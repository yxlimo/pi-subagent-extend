import { statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 从锚点解析目标文件。
 *
 * 锚点编辑工具（replace / replace_match / insert / copy / move）在入参里可以不带路径：
 * 目标由「锚点归属」决定，而归属记录在宿主扩展自己的会话 sidecar 里
 * （`<config>/sessions/<sha256(sessionFile) 前 24 位>.registry.jsonl`，事件为
 * `allocate {path, rows}` / `free` / `clear`）。
 *
 * 我们读它，是为了给这些工具判「目标在不在写范围里」。不读就只能一律拒绝，那样子代理在
 * 这类宿主上一个字也改不了。代价是依赖一份第三方私有格式，所以证据链是单向的：
 * 读不到、读不懂、查不到 —— 一律当作**拿不到目标**，然后拒绝。绝不会因为读不到而放行。
 */
/**
 * 一次锚点解析的三种结局。
 *
 * 把「锚点不认识」和「锚点分属两个文件」分开，是因为两者的出路完全不同：前者要模型重新读文件
 * （锚点会过期）或者改用显式 path；后者是入参本身自相矛盾，重读一百次也没用，只能拆成两次调用。
 * 混成一句「不在注册表里」，模型就会去重读，然后拿回同样的拒绝。
 */
export type AnchorResolution =
	| { path: string }
	| { miss: "unknown" }
	| { miss: "disagree"; files: string[] };
export function anchorTargetPath(
	sessionFile: string | undefined,
	anchors: string[],
): AnchorResolution {
	if (!sessionFile || anchors.length === 0) return { miss: "unknown" };
	const dir = join(
		process.env.PI_HASHLINE_DIR ??
			join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pi-hashline-edit-pro"),
		"sessions",
	);
	const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 24);
	const sidecar = join(dir, `${key}.registry.jsonl`);
	let raw: string;
	try {
		// 一次 stat 取全（mtimeNs + size + ino）：分两次取的话文件可能在两次之间被改写，
		// 拼出来的 stamp 谁都不对应。用纳秒而不是毫秒 —— 宿主重写（压缩）sidecar 时字节数
		// 可能刚好不变，毫秒粒度也可能落在同一刻，那样就会拿旧解析结果判新文件。
		const info = statSync(sidecar, { bigint: true });
		const stamp = `${info.mtimeNs}:${info.size}:${info.ino}`;
		const cached = anchorCache.get(sidecar);
		if (cached?.stamp === stamp) raw = cached.raw;
		else {
			raw = readFileSync(sidecar, "utf8");
			anchorCache.set(sidecar, { stamp, raw });
		}
	} catch {
		return { miss: "unknown" };
	}
	const wanted = new Set(anchors);
	const owned = new Map<string, string>();
	for (const line of raw.split("\n")) {
		if (!line) continue;
		let event: { kind?: string; path?: string; rows?: unknown; anchors?: unknown };
		try {
			event = JSON.parse(line) as typeof event;
		} catch {
			// 半行（正在追加）或坏行：跳过。宁可判不出来而拒绝，也不猜。
			continue;
		}
		if (event.kind === "clear") owned.clear();
		else if (event.kind === "free") {
			if (Array.isArray(event.anchors)) {
				for (const anchor of event.anchors) if (typeof anchor === "string") owned.delete(anchor);
			} else if (typeof event.path === "string") {
				for (const [anchor, path] of owned) if (path === event.path) owned.delete(anchor);
			}
		} else if (event.kind === "allocate" && typeof event.path === "string" && Array.isArray(event.rows)) {
			for (const row of event.rows) {
				// 只留我们查的那几个锚点：一次 allocate 可能带整份文件的行（实测一份 1998 条），
				// 全部收进 map 没有意义。
				if (Array.isArray(row) && typeof row[0] === "string" && wanted.has(row[0])) {
					owned.set(row[0], event.path);
				}
			}
		}
	}
	// 所有锚点必须指向同一个文件，拿不到唯一目标就拒绝。
	//
	// 宿主自己也有一条同义规则：两个锚点归属不同文件时它抛
	// `[E_BAD_SHAPE] The anchors are owned by different files … edit one file per call`
	// （edit-common.ts 的 resolveEditTarget，paths.size > 1）。这里跟着拒，是为了让本层的
	// 判断不依赖宿主先把它拦下来 —— 我们判的是「将要被写的文件在不在写范围里」，目标都不唯一
	// 就没有答案，不能挑一个算数。
	//
	// 关于两种拼写（`remove_from` / `replace_from` 互为别名）：宿主在 `prepareArguments` 里
	// 就按自己的规范名归一化、把另一个删掉，而 pi 的 `tool_call` 钩子拿到的是归一化并校验
	// 之后的入参（agent-loop: prepareToolCallArguments → validateToolArguments →
	// beforeToolCall({args})），所以同时带两种拼写、各指一处的入参到不了这里。这条规则防的
	// 是「锚点确实分属两个文件」的入参，不是别名。
	const resolvedFiles = new Set<string>();
	for (const anchor of anchors) {
		const found = owned.get(anchor);
		if (found) resolvedFiles.add(found);
	}
	if (resolvedFiles.size === 0) return { miss: "unknown" };
	if (resolvedFiles.size > 1) return { miss: "disagree", files: [...resolvedFiles].sort() };
	const [onlyFile] = resolvedFiles;
	return { path: onlyFile };
}

/** sidecar 解析缓存：一次工具调用读一次文件太长，按 mtime+size 失效。 */
const anchorCache = new Map<string, { stamp: string; raw: string }>();

/**
 * 可能承载锚点的入参名。两种拼写都在里面（`replace` 用 remove_*，`replace_match` 用
 * replace_*，宿主互为别名），所以列全；至于它们是不是都指向同一份文件，由
 * `anchorTargetPath` 自己核对 —— 不能指望工具去校验，它会先删掉别名。
 */
export const ANCHOR_ARGS = [
	"remove_from",
	"remove_to",
	"replace_from",
	"replace_to",
	"source_from",
	"source_to",
	"anchor",
];

/**
 * 双文件工具（copy / move）把两份文件写在同一组入参里：`source_from` / `source_to` 属于
 * 源文件，`anchor` 属于目标文件。两组锚点归属不同文件，必须分开解析 —— 合成一个列表去查，
 * 只会返回先命中的那一个，等于只判了一侧。
 *
 * 目标侧只有 `anchor`：宿主的 copy/move 契约只认 path / source_from / source_to / anchor /
 * direction，传 `remove_from` 会被它以未知字段拒掉（payload-contract.ts 的 TRANSFER_KEYS）。
 * 早先这里把 `remove_from` / `remove_to` 也算进目标侧，今天造不成问题（宿主先拒），但排序是
 * 隐患：多锚点取值取第一个能命中的，那样返回的是源文件，真正的目标反而没判。
 */
export const TRANSFER_SOURCE_ARGS = ["source_from", "source_to"];
export const TRANSFER_DEST_ARGS = ["anchor"];
