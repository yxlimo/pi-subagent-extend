/**
 * bash 白名单的匹配与读写归类。
 *
 * 条目两种写法：
 * - 字面量：按空白切词的前缀匹配。`"pnpm test"` 放行 `pnpm test -t foo`，不放行 `pnpm publish`。
 * - `re:` 前缀：正则，整串锚定（不写 ^$ 也整串）。用来表达一个命令族的多种参数。
 *
 * 不自动探测正则：命令参数本身就常含 `*`、`.`、`(`（glob 输入、shell 分支），
 * 猜错方向是误授权，比误拒绝危险得多。
 *
 * 读写归类供探针使用：legacy 的 read / write 列按列定读写（两侧都命中以 write 为准，
 * 保守方向）；新的 allow 单列用 commandAccess 从命令本身判读写，read / write 留作兼容列。
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { leadingAssignments } from "./bash/env.ts";
import { commandAccess, PACKAGE_DIR_FLAGS, PACKAGE_MANAGERS } from "./bash/programs.ts";
import { RE_PREFIX, tokens } from "./bash/tokens.ts";

export { deniedEnvAssignment, leadingAssignments, type LeadingAssignments } from "./bash/env.ts";
export { commandAccess, isUnknownProgram } from "./bash/programs.ts";
export { requiresNetwork } from "./bash/network.ts";
export { commandSegments, pathCandidates, shellTokens, tokens } from "./bash/tokens.ts";

export type BashAccess = "read" | "write";

export interface BashRule {
	read: string[];
	write: string[];
	/** 新的单列白名单：读写由 commandAccess 从命令本身判，不再预先分列。 */
	allow: string[];
	/** 允许网络（默认关闭，沙箱内使用私有网络命名空间）。 */
	network: boolean;
	/** scope 命中的目录在沙箱里可写（默认只读根）。 */
	writable: boolean;
	/**
	 * 额外给予写权限的路径（绝对路径、`~` 开头或相对 cwd）。
	 * pnpm store、mise 的 state 目录这类全局可写区，不在 scope 里，但工具链要写。
	 */
	writablePaths: string[];
	/** 注入到沙箱里的环境变量（写进 spec 的 env 字段）。 */
	env: Record<string, string>;
	/**
	 * 项目内构建/测试产物目录。默认按工具链 marker 判断后放行（并创建），
	 * `false` 关闭整份内置清单，数组在内置清单之上追加。
	 */
	scratchPaths: string[] | false;
	/**
	 * 结构性禁掉的命令，**不可被 bindings 放宽**。来自项目 profile 的 bash.deny，
	 * 与调用方写的 read/write 取并集：即便调用方把同一条命令列进白名单也进不来。
	 */
	deny: string[];
	/**
	 * 启动前的依赖完整性闸门（默认开）：有 lockfile 却没有 node_modules/.bin 的目录，
	 * 让 bash 直接失败并点名，而不是让第一条构建命令在沙箱里去装依赖、然后挂住。
	 *
	 * 数组是「这些目录不必装」的前缀清单：树里常年躺着没人安装的 lockfile
	 * （fixtures/、vendored 的样例工程）时，只关掉整道闸门等于把真包也一起交出去。
	 * `false` 才是整道闸门的开关。
	 */
	dependencyGate: string[] | false;
	/**
	 * 命令树停止消耗 CPU 超过这么多秒就杀掉（默认关）。
	 *
	 * 墙钟超时分不开「死锁」和「长编译」，累计 CPU 分得开：干活的树每次采样都在涨，卡住的
	 * 树一动不动。判据由 helper 实现 —— 它是子进程 PID 命名空间的 PID 1，看得见整棵子树。
	 */
	cpuStallSeconds: number | false;
	/**
	 * 是否给沙箱里的 git 注入全局排除规则（node_modules/、.pnpm-store/）。
	 * 默认开：防止子代理 `git add -A` 把依赖目录吸进索引。
	 */
	gitExcludes: boolean;
}

export interface BashMatch {
	access: BashAccess;
	/** 命中哪一列：legacy 的 read / write，或是新的 allow。 */
	column: "read" | "write" | "allow";
	/** 命中的条目原文，用于拒绝文案与诊断。 */
	entry: string;
}

/**
 * 单条模式是否匹配整条命令。`re:` 条目按正则整串匹配；否则按 token 前缀匹配。
 * 空命令永不匹配。
 */
export function commandMatches(pattern: string, command: string): boolean {
	const cmd = command.trim();
	if (!cmd) return false;
	const entry = pattern.trim();
	if (entry.startsWith(RE_PREFIX)) {
		const source = entry.slice(RE_PREFIX.length).trim();
		if (!source) return false;
		try {
			return new RegExp(`^(?:${source})$`).test(cmd);
		} catch {
			// 写坏的正则不匹配任何命令（fail closed），而不是让整条规则消失。
			return false;
		}
	}
	const want = tokens(entry);
	if (want.length === 0) return false;
	// 赋值前缀先剥掉再比：条目的第一个 token 指的是程序名，不是它前面的环境变量。
	const have = tokens(leadingAssignments(cmd).rest);
	return want.every((token, i) => have[i] === token);
}

/**
 * 归类一条命令。legacy 两列先判且各按原义：write 命中 = write，read 命中 = read；
 * allow 列最后判，读写由 commandAccess 从命令本身推出来。
 *
 * allow 排在 legacy 两列之后是刻意的：同一条命令同时列进 write 与 allow 时，legacy 语义
 * 必须原样保留（这个兼容阶段不改老配置的行为）；先判 allow 会把它重新判成可能的 read。
 */
export function classifyCommand(rule: BashRule, command: string): BashMatch | undefined {
	const write = rule.write.find((entry) => commandMatches(entry, command));
	if (write !== undefined) return { access: "write", column: "write", entry: write };
	const read = rule.read.find((entry) => commandMatches(entry, command));
	if (read !== undefined) return { access: "read", column: "read", entry: read };
	const allow = rule.allow.find((entry) => commandMatches(entry, command));
	if (allow !== undefined) return { access: commandAccess(command, rule.writable), column: "allow", entry: allow };
	return undefined;
}

/** 全部条目（供拒绝文案与诊断），三列都要列。 */
export function allEntries(rule: BashRule): string[] {
	return [...rule.read, ...rule.write, ...rule.allow];
}

/** 命中禁止列表时返回该条目原文，否则 undefined。 */
export function deniedEntry(rule: BashRule, command: string): string | undefined {
	return rule.deny.find((entry) => commandMatches(entry, command));
}

export function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return (value as unknown[])
		.filter((v): v is string => typeof v === "string" && v.trim() !== "")
		.map((v) => v.trim());
}

/** 配置对象；不是对象（含数组）时返回 undefined。 */
function configObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

/** 去重且保序：先到的在前，底层的条目排在调用方新增的前面。 */
function unique(values: string[]): string[] {
	return [...new Set(values)];
}
function stringMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!key.trim()) continue;
		if (typeof raw !== "string" && typeof raw !== "number") continue;
		out[key.trim()] = String(raw);
	}
	return out;
}

/**
 * 解析 bindings 里的 bash 字段。没写、写坏、三列都空都返回 undefined（= 拒绝 bash）。
 * `read` / `write` 是兼容列，含义照旧；`allow` 是新的单列，读写留给 commandAccess 判。
 */
export function parseBashRule(raw: unknown): BashRule | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const cfg = raw as Record<string, unknown>;
	const read = stringList(cfg.read);
	const write = stringList(cfg.write);
	const allow = stringList(cfg.allow);
	if (read.length === 0 && write.length === 0 && allow.length === 0) return undefined;
	return {
		read,
		write,
		allow,
		network: cfg.network === true,
		writable: cfg.writable === true,
		writablePaths: stringList(cfg.writablePaths),
		env: stringMap(cfg.env),
		scratchPaths: cfg.scratchPaths === false ? false : stringList(cfg.scratchPaths),
		gitExcludes: cfg.gitExcludes !== false,
		deny: stringList(cfg.deny),
		dependencyGate: cfg.dependencyGate === false ? false : stringList(cfg.dependencyGate),
		// 未写 = 关。这条看门狗杀掉整棵进程树，默认打开会误杀刻意等待的命令（sleep、退避轮询），
		// 而 helper 看不到输出（stdio 是继承的，不走管道），没法用「无输出」佐证。
		cpuStallSeconds: stallSeconds(cfg.cpuStallSeconds),
	};
}

/**
 * 合并两层 bash 配置（profile 默认值与本次调用的 bindings）。
 *
 * 语义按字段区分，不是整块覆盖 —— 整块覆盖的后果是：派单只要写一条 `bash.read`，
 * profile 里那几十条授权就整块消失，于是「想加一条授权」变成「把全部重抄一遍」，
 * 派单反而不能放宽权限。
 *
 * - 白名单（read / write / allow）取并集：调用方只能往上加，不能悄悄删掉底层已放行的。
 *   但「写了这一列」与「没写」不是一回事：写了空列表 = 该列就是空（清空底层的授权），
 *   没写 = 继承。否则 `read: []` 被当成「加零条」，派单想禁用 bash 却静默保留了整列授权。
 * - deny 取并集，且是硬底线：任何一层都拆不掉它（拆掉禁令与放宽权限是两件事）。
 * - 其余字段调用方优先（写了的以调用方为准，没写的沿用底层的值）：network、writable、
 *   gitExcludes、dependencyGate、cpuStallSeconds、scratchPaths。
 * - writablePaths 取并集（多一条是保住底层已经给的授权，不是放宽）；env 按键合并，
 *   同名键以调用方为准。
 *
 * `reset: true`（只可能出现在调用方这一层，或由调用方的顶层 `reset: true` 传进来）表示
 * 「这次只给这几条」：先把底下那层的 read / write / allow 丢掉，再套用调用方的白名单。
 * deny 仍然并集 —— 收窄白名单不等于拆掉项目禁令。
 *
 * 纯函数：不改传入的两个对象，返回新对象。`reset` 键不会进结果，它是控制合并的，
 * 不是给 `parseBashRule` 的字段。
 */
export function mergeBashConfig(
	base: unknown,
	over: unknown,
	/** 调用方顶层写了 `reset: true`：那一层「只给这些」也覆盖 bash 白名单。 */
	forceReset = false,
): Record<string, unknown> | undefined {
	const lower = configObject(base);
	const upper = configObject(over);
	if (!lower && !upper) return undefined;
	const bottom = lower ?? {};
	const top = upper ?? {};
	// reset 只认调用方这一层：它的意思是「丢掉下面那层的白名单」，底层自己写没有意义。
	const reset = forceReset || top.reset === true;
	// 底层整体搬过来（`reset` 不搬：它是控制合并的，不是给 parseBashRule 的字段）。
	const inherited: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(bottom)) {
		if (key === "reset") continue;
		inherited[key] = value;
	}
	return {
		...inherited,
		...bashLists(bottom, top, reset),
		...bashSwitches(bottom, top),
	};
}

/**
 * 白名单与禁令：并集。底层在前，调用方新增的在后。
 *
 * reset 时底下那层的白名单整个丢掉（调用方只给这几条），但 deny 仍然并集 ——
 * 收窄白名单不等于拆掉项目禁令。
 */
function bashLists(bottom: Record<string, unknown>, top: Record<string, unknown>, reset: boolean): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of ["read"] as const) {
		// 「写了这一列」与「没写」不是一回事：写了空列表 = 该列就是空（清空底层的授权），
		// 没写 = 继承（并集）。以前两者都算「加零条」，于是派单写 `read: []` 想禁用 bash，
		// profile 的整列授权却原样留着 —— 静默保留授权是最坏的一种失败。
		const declared = Object.hasOwn(top, key);
		const given = stringList(top[key]);
		const list = declared && given.length === 0 ? [] : unique([...(reset ? [] : stringList(bottom[key])), ...given]);
		// reset 时即使为空也要写进去：否则底层那份白名单还留在结果里，reset 就白写了。
		// 显式空列表同理：不写进结果，底层那份就又回来了。
		if (list.length > 0 || reset || declared) out[key] = list;
	}
	// `write` 与 `allow` 在**合并层**仍按同一列处理（兼容期保留的两拼法；parseBashRule 已分列），
	// 必须按列、不能按键：不然「这一列只留 x」会有两种拼法、两种结果 —— 派单写
	// `{ write: [], allow: ["x"] }` 能清掉 profile 的 `write`，而 `{ allow: [], write: ["x"] }`
	// 却留着，差别只在 profile 当初用哪个拼法。按列处理：上层**任一**别名显式为空，
	// 这一列就从底层清空；否则并集。
	const writeDeclared = Object.hasOwn(top, "write");
	const allowDeclared = Object.hasOwn(top, "allow");
	const writeGiven = stringList(top.write);
	const allowGiven = stringList(top.allow);
	const emptied = (writeDeclared && writeGiven.length === 0) || (allowDeclared && allowGiven.length === 0);
	const clears = reset || emptied;
	const writeBase = clears ? [] : stringList(bottom.write);
	const allowBase = clears ? [] : stringList(bottom.allow);
	const writeList = unique([...writeBase, ...writeGiven]);
	const allowList = unique([...allowBase, ...allowGiven]);
	if (writeList.length > 0 || reset || writeDeclared || emptied) out.write = writeList;
	if (allowList.length > 0 || reset || allowDeclared || emptied) out.allow = allowList;
	// deny 是硬底线：两层并集，任何一层都拆不掉。
	const deny = unique([...stringList(bottom.deny), ...stringList(top.deny)]);
	if (deny.length > 0) out.deny = deny;
	// 可写区并集：多一条是保住底层已经给的授权，不是放宽。
	const writablePaths = unique([...stringList(bottom.writablePaths), ...stringList(top.writablePaths)]);
	if (writablePaths.length > 0) out.writablePaths = writablePaths;
	return out;
}

/**
 * 开关与标量：调用方写了以调用方为准，没写沿用底层的值。
 *
 * env 按键合并：底层的保留，同名键以调用方为准。
 */
function bashSwitches(bottom: Record<string, unknown>, top: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of ["network", "writable", "gitExcludes", "dependencyGate", "cpuStallSeconds", "scratchPaths"] as const) {
		if (Object.hasOwn(top, key)) out[key] = top[key];
	}
	const env = { ...stringMap(bottom.env), ...stringMap(top.env) };
	if (Object.keys(env).length > 0) out.env = env;
	return out;
}

/** `cpuStallSeconds`：未写、写坏、`false`、小于等于 0 一律当关闭。 */
function stallSeconds(value: unknown): number | false {
	// 先 floor 再判断：否则 0.5 会得到 0，而 0 !== false 会把 `stallSeconds: 0` 写进 spec ——
	// 旧版 helper 的 deny_unknown_fields 会因此整份拒绝（退出码 77），正好是「关掉时不写键」
	// 想避免的那种失败。也不接受非数字：`true` 经 Number() 会变成 1，即「静默 1 秒就杀」。
	if (typeof value !== "number" || !Number.isFinite(value)) return false;
	const n = Math.floor(value);
	if (n <= 0) return false;
	return n;
}

/**
 * 「授权写了却永远命中不了」的判定。
 *
 * 这里说的「命中不了」不是语法不匹配（那种情况命令会被拒，拒绝文案里会说清），而是这条命令
 * 在会话的工作目录下**根本跑不起来**：仓库根没有 package.json，`pnpm run x` 只会报
 * "No package.json found"。子代理没有 `cd`、也没有 `&&`，于是这条授权永远用不上，
 * 它只能自己找一个等价写法 —— 那正是要避免的坑。
 *
 * 只判能确定的事实，不猜：
 * - `re:` 正则条目无法静态判断，跳过；
 * - 程序名是工具链里到处都有的（`git`、`rg`、`node`）时，工作目录语义太杂，一律不判：
 *   误报比漏报糟；
 * - 判据与理由文本必须一致：manifest 按工具自己的规矩**向上**找（cwd 的祖先也算，
 *   两条链都查：字面路径与真实路径），所以 `why` 写的是 "in <cwd> or its ancestors"。
 */
export interface UnreachableEntry {
	/** 条目原文。 */
	entry: string;
	/** 为什么命中不了：一句可核对的事实。 */
	why: string;
	/**
	 * 判定时实际查看的目录：cwd 的**解析后**路径（`realpathSync`），解不出时才是字面路径。
	 *
	 * 文案要印这个而不是字面 cwd：cwd 经软链进来时，读者按字面链一查就能找到 manifest，
	 * 那条「永远命中不了」的结论于是看起来是错的。
	 */
	lookedIn?: string;
	/** 改成什么：拿不到可靠改法时没有这个字段。 */
	fix?: string;
	/**
	 * cwd 下面所有带 package.json 的目录（相对 cwd 的路径）。
	 *
	 * 有多个候选时给不出可靠的改法：这条授权原本指哪个包只有父代理知道。
	 */
	candidates?: string[];
	/**
	 * 恰好一个候选包、但那个包里没有条目点名的脚本（`pnpm run typecheck` 而包里只有 `lint`）。
	 *
	 * 这是「脚本不存在」，不是「授权不可达」：命令跑起来会得到 pnpm 自己的
	 * "Command not found"，改包目录也治不好。有了这个标记，文案才能说清「没有候选包带这个
	 * 脚本」，而不是让读者去几个候选里「挑一个」—— 挑哪一个都不行。
	 */
	scriptMissing?: string;
}

/** 首个词：条目与命令的程序位。 */
export function firstToken(text: string): string {
	const head = tokens(text.trim())[0];
	return head && head !== "" ? head : "";
}

/** 条目里指定的包目录（`--dir <p>` / `--prefix <p>` / `-C <p>` / `--cwd <p>`）。 */
interface PackageDir {
	/** 旗标原文。 */
	flag: string;
	/** 条目里写的路径。 */
	path: string;
	/** 旗标在条目里的位置：`<p>` 与旗标分写时，值在下一个位置。 */
	index: number;
}

/** 找出条目里那个「换包目录」的旗标；判不了时返回 undefined（不猜）。 */
function packageDirFlag(entry: string): PackageDir | undefined {
	const words = tokens(entry);
	for (let i = 0; i < words.length; i += 1) {
		const word = words[i] as string;
		for (const flag of PACKAGE_DIR_FLAGS) {
			if (word === flag) {
				const value = words[i + 1] as string | undefined;
				// 旗标后面没有值：判不了，不猜。
				if (value === undefined) return undefined;
				return { flag, path: value, index: i };
			}
			if (word.startsWith(`${flag}=`)) {
				const value = word.slice(flag.length + 1);
				if (!value) return undefined;
				return { flag, path: value, index: i };
			}
		}
	}
	return undefined;
}

/** 找包目录时最多往下走几层。 */
const MAX_PACKAGE_SEARCH_DEPTH = 4;

/** 向上找 manifest 时最多走几层：病态的深路径不至于把判定拖成扫盘。 */
const MAX_MANIFEST_SEARCH_DEPTH = 8;

/**
 * 从 cwd 向上找 manifest（`package.json` / `Cargo.toml`）。
 *
 * npm/pnpm/yarn/bun 与 cargo 都是**向上**找 manifest：cwd 是仓库里的子目录时，
 * 祖先目录里有 manifest 就说明这条命令跑得起来。只看 cwd 会把它误判成不可达，
 * 而误报会让父代理去改一条本来没坏的配置。
 *
 * 起点是**物理**路径（见 `searchRoots`）：工具看到的是 `process.cwd()`，软链已经被解开。
 * 依据是「工具自己的规矩」，不是「把可能的路径都试一遍」——后者只会多报可达，
 * 把一条死授权藏起来，而那正是这个判据要防的事。
 *
 */
function manifestAbove(cwd: string, manifest: string): string | undefined {
	for (const root of searchRoots(cwd)) {
		const found = manifestUp(root, manifest);
		if (found !== undefined) return found;
	}
	return undefined;
}

/**
 * 上行的起点：**物理**路径优先。
 *
 * 工具看到的是 `process.cwd()`，它已经把软链解开（内核在 `chdir` 时解析），沙箱 helper
 * 也是 `chdir(spec.cwd)` 起的进程。所以字面链上命中的 manifest 工具**永远看不到**：
 * 把两条链取并集，只会把一条真的跑不起来的授权判成可达、从此不再报告 —— 而这正是
 * 这个判据要防的事。`realpathSync` 失败（cwd 已不存在或没权限）时才退回字面路径：
 * 判定不该因为读不到目录而抛。
 */
function searchRoots(cwd: string): string[] {
	try {
		return [realpathSync(cwd)];
	} catch {
		return [resolve(cwd)];
	}
}

/** 一条链上的上行查找。 */
function manifestUp(start: string, manifest: string): string | undefined {
	let dir = start;
	for (let depth = 0; depth <= MAX_MANIFEST_SEARCH_DEPTH; depth += 1) {
		if (existsSync(join(dir, manifest))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

/**
 * 这些子命令本来就不需要 manifest：版本号、帮助、store/config 之类。
 * 它们在没有任何 package.json 的目录里照样跑得起来，判成不可达就是误报。
 */
const MANIFEST_EXEMPT_SUBCOMMANDS = new Set([
	"--version",
	"--help",
	"-v",
	"-V",
	"store",
	"config",
	"setup",
	"env",
	"cache",
	"dlx",
]);

/**
 * 这些旗标让「从 cwd 找 manifest」这件事判不了：工作区范围（`-r`、`--filter`）
 * 或别的目录（cargo 的 `-C`）。带着它们猜 cwd 必然猜错。
 */
const MANIFEST_EXEMPT_FLAGS = new Set([
	"-w",
	"--workspace-root",
	"--filter",
	"-r",
	"--recursive",
	"--manifest-path",
	"-C",
]);

/** 条目里有没有这些旗标（`--flag=value` 形态也算）。 */
function hasExemptFlag(entry: string): boolean {
	return tokens(entry).some((word) => {
		if (MANIFEST_EXEMPT_FLAGS.has(word)) return true;
		for (const flag of MANIFEST_EXEMPT_FLAGS) {
			if (flag.startsWith("--") && word.startsWith(`${flag}=`)) return true;
		}
		return false;
	});
}

/** 条目的子命令位置上有没有不需要 manifest 的词（`pnpm store path`、`npm --help`…）。 */
function hasExemptSubcommand(entry: string): boolean {
	return tokens(entry).slice(1).some((word) => MANIFEST_EXEMPT_SUBCOMMANDS.has(word));
}

/**
 * bun 自带的子命令：`test` 用它自己的 runner，`x` 是它的 dlx —— 两者都不看 `package.json`。
 *
 * 判据是「`run` 出现在子命令之前 ⇒ 那是包脚本」，所以 `bun run test` 与
 * `bun --cwd <dir> run test` 不豁免，而 `bun test`、`bun --bun test`、`bun --cwd <dir> test`
 * 都豁免。这样不必知道每个旗标吃几个值，也就不会把旗标的**值**当成子命令。
 */
function bunBuiltin(entry: string): string | undefined {
	if (firstToken(entry) !== "bun") return undefined;
	const rest = tokens(entry).slice(1);
	const runAt = rest.indexOf("run");
	const testAt = rest.indexOf("test");
	const xAt = rest.indexOf("x");
	if (runAt !== -1 && testAt !== -1 && runAt < testAt) return undefined;
	if (testAt !== -1) return "test";
	if (xAt !== -1) return "x";
	return undefined;
}

/**
 * 这条**命令**自己需不需要 manifest —— 与「条目」的判据分开。
 *
 * 宽条目（`pnpm`）放行的 `pnpm --version` 并不需要 manifest，它失败的原因是网络、二进制
 * 缺失或别的什么；拿「这条条目没有 manifest 可用」去解释它，是把原因安到了不成立的前提上。
 */
export function commandNeedsNoManifest(command: string): boolean {
	const entry = command.trim();
	if (!entry) return false;
	if (hasExemptSubcommand(entry) || hasExemptFlag(entry)) return true;
	// 自己指了包目录（`pnpm --dir packages/a run build`）：cwd 有没有 manifest 与之无关。
	if (packageDirFlag(entry) !== undefined) return true;
	return bunBuiltin(entry) !== undefined;
}

/**
 * 构建产物目录：路径里有一段是这些目录时，文件不存在只说明还没构建，
 * 不说明这条授权命中不了（`packages/helper/target/release/…` 要等一次 cargo build）。
 */
const BUILD_ARTIFACT_DIRS = new Set([
	"target",
	"dist",
	"build",
	"out",
	"node_modules",
	".git",
	".venv",
	"__pycache__",
]);

/** 路径里有没有一段是构建产物目录。 */
function isBuildArtifactPath(path: string): boolean {
	return path.split(/[/\\]/).some((part) => BUILD_ARTIFACT_DIRS.has(part));
}

/** 一条文案里最多列几项。monorepo 下候选包可能有几百个，一条告警不该被它撑爆。 */
export const MAX_LISTED = 8;

/**
 * 把一组路径拼进一条文案，超过上限就截断并说还剩几条。
 *
 * 截断放在**渲染**这一层，不放在收集处：`candidates.length !== 1` 决定「给不给改法」，
 * 收集时就截断会把「12 个候选，判不了」写成「8 个候选，判不了」—— 结论没变，但读者
 * 以为只有 8 个，而且 `… and N more` 里的 N 也没地方算。收集保持完整，只有给人看的
 * 那串字有上限。
 */
export function listedJoin(items: string[]): string {
	if (items.length <= MAX_LISTED) return items.join(", ");
	const rest = items.length - MAX_LISTED;
	return `${items.slice(0, MAX_LISTED).join(", ")}, … and ${rest} more`;
}

/**
 * cwd 下面**所有**带 package.json 的目录（相对 cwd 的路径）。
 *
 * 收集全部而不是第一个：仓库里常有多个包，「这条授权原本指哪个包」只有父代理知道，
 * 随便挑一个再给一条 `--dir` 建议，会把命令指到别的包上。
 */
function packageCandidatesUnder(cwd: string): string[] {
	const out: string[] = [];
	let frontier = [""];
	for (let depth = 0; depth < MAX_PACKAGE_SEARCH_DEPTH; depth += 1) {
		const next: string[] = [];
		for (const rel of frontier) {
			const abs = rel === "" ? cwd : join(cwd, rel);
			let names: string[];
			try {
				names = readdirSync(abs, { withFileTypes: true })
					.filter(
						(entry) =>
							(entry.isDirectory() || entry.isSymbolicLink()) &&
							!entry.name.startsWith(".") &&
							entry.name !== "node_modules",
					)
					.map((entry) => entry.name)
					.sort();
			} catch {
				continue;
			}
			for (const name of names) {
				const childRel = rel === "" ? name : join(rel, name);
				if (existsSync(join(cwd, childRel, "package.json"))) out.push(childRel);
				next.push(childRel);
			}
		}
		frontier = next;
	}
	return out;
}

/**
 * 条目里的脚本名：`run <script>` 与裸 `test` 两种形态。
 *
 * 只认这两种：别的裸词（`pnpm install`）是子命令还是脚本名猜不准，
 * 猜错就会把一条本来跑得起来的命令判成不可达。
 */
function scriptName(entry: string): string | undefined {
	const words = tokens(entry);
	if (words.length < 2) return undefined;
	if (words[1] === "run") return words[2];
	// `bun test` 跑的是 bun 自带的测试运行器，不看 `scripts.test`，连 package.json 都不需要；
	// 把它当成「包里的 test 脚本」会让文案说一句假话（"no candidate has a `test` script"）。
	// 只有 `bun run test` 才是脚本。
	if (words[1] === "test") return words[0] === "bun" ? undefined : "test";
	return undefined;
}

/** 候选包的 package.json 里真的有这个脚本吗。 */
function hasScript(cwd: string, pkgRel: string, script: string): boolean {
	try {
		const raw = readFileSync(join(cwd, pkgRel, "package.json"), "utf8");
		const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
		return parsed.scripts !== undefined && Object.prototype.hasOwnProperty.call(parsed.scripts, script);
	} catch {
		return false;
	}
}

/** `packageFixFor` 的答案：有改法就给改法，没有就说清为什么没有。 */
interface PackageFixOutcome {
	/** 可靠改法；给不出来时没有这个字段。 */
	fix?: string;
	/** 恰好一个候选、但那个包里没有这个脚本：交给文案去说明。 */
	scriptMissing?: string;
}

/**
 * 改法只在**恰好一个候选**、且那个包里真的有这个脚本时才给。
 *
 * 多个候选时给不出来：这条授权原本指哪个包只有父代理知道，随便挑一个会把命令
 * 指到别的包上。脚本不在包里时那条建议自己也跑不通（pnpm 报 "Command not found"），
 * 那是脚本不存在，不是授权不可达 —— 所以既不给改法，也要把「原因不是包选错了」
 * 带回去（`scriptMissing`），否则文案只会让人在候选里挑一个，而挑哪一个都不行。
 */
function packageFixFor(
	cwd: string,
	head: string,
	managerFlag: string,
	entry: string,
	candidates: string[],
	script: string | undefined,
	dir?: PackageDir,
): PackageFixOutcome {
	if (candidates.length !== 1) return {};
	const pkg = candidates[0] as string;
	if (script !== undefined && !hasScript(cwd, pkg, script)) return { scriptMissing: script };
	return { fix: packageFix(head, managerFlag, pkg, entry, dir) };
}

/** 造一条包管理器条目的不可达记录：候选列表，加上可靠时才有的改法。 */
function packagingItem(
	cwd: string,
	entry: string,
	head: string,
	managerFlag: string,
	why: string,
	candidates: string[],
	dir?: PackageDir,
): UnreachableEntry {
	const item: UnreachableEntry = { entry, why, lookedIn: searchRoots(cwd)[0] };
	if (candidates.length > 0) item.candidates = candidates;
	const { fix, scriptMissing } = packageFixFor(cwd, head, managerFlag, entry, candidates, scriptName(entry), dir);
	if (fix) item.fix = fix;
	if (scriptMissing) item.scriptMissing = scriptMissing;
	return item;
}

/**
 * 包管理器的改法：`pnpm --dir <pkg> run <script>` 这类形态。
 *
 * 原条目里的换目录旗标被换掉：那个路径正是失效的原因。
 */
function packageFix(head: string, managerFlag: string, pkgDir: string, entry: string, dir?: PackageDir): string {
	const words = tokens(entry);
	const rest: string[] = [];
	for (let i = 1; i < words.length; i += 1) {
		const word = words[i] as string;
		if (dir && i === dir.index) {
			// `--dir <p>`：旗标与值一起跳过；`--dir=<p>` 只跳过旗标本身。
			if (word === dir.flag) i += 1;
			continue;
		}
		rest.push(word);
	}
	return [head, managerFlag, pkgDir, ...rest].join(" ");
}

/** 一条包管理器条目在 cwd 下跑不跑得起来；跑不起来时给出记录。 */
function packageManagerItem(
	cwd: string,
	entry: string,
	head: string,
	managerFlag: string,
	candidates: string[],
): UnreachableEntry | undefined {
	// bun 自带的子命令先判：`bun --cwd <dir> test` 里的 `--cwd` 会被当成包目录旗标，
	// 于是它先掉进下面那个分支、被按「那个目录里没有 package.json」判成不可达 ——
	// 而 `bun test` 用的是它自己的 runner，跟 package.json 无关。
	if (bunBuiltin(entry) !== undefined) return undefined;
	const dir = packageDirFlag(entry);
	if (dir) {
		// 条目自己指了包目录：那个目录里没有 package.json 才算命中不了。
		const target = isAbsolute(dir.path) ? dir.path : resolve(cwd, dir.path);
		if (existsSync(join(target, "package.json"))) return undefined;
		return packagingItem(cwd, entry, head, managerFlag, `no package.json in ${dir.path}`, candidates, dir);
	}
	// 不需要 manifest 的子命令（`pnpm store path`）与判不了的旗标（`pnpm -r test`）：不判。
	if (hasExemptSubcommand(entry) || hasExemptFlag(entry)) return undefined;
	// manifest 向上找：cwd 是子目录时，祖先有 package.json 就说明跑得起来。
	if (manifestAbove(cwd, "package.json")) return undefined;
	return packagingItem(cwd, entry, head, managerFlag, `no package.json in ${cwd} or its ancestors`, candidates);
}

/** 一条 cargo 条目在 cwd 下跑不跑得起来。 */
function cargoItem(cwd: string, entry: string): UnreachableEntry | undefined {
	// `cargo --manifest-path <p>` / `cargo -C <dir>` 指了别的包：判不了，不判。
	if (hasExemptFlag(entry) || hasExemptSubcommand(entry)) return undefined;
	if (manifestAbove(cwd, "Cargo.toml")) return undefined;
	return { entry, why: `no Cargo.toml in ${cwd} or its ancestors` };
}

/**
 * 扫出永远命中不了的条目。
 *
 * 判据只有「这条命令在 cwd 下跑不起来」这一类事实：语法不匹配的条目不在这里（那条命令
 * 本来就会被拒，拒绝文案里会说）。判不出来的（正则、工具链里到处都有的程序名）一律放过。
 *
 * 「跑不起来」按工具自己的规矩算：manifest 向上找（cwd 与它的祖先），找不到才算。
 */
export function unreachableEntries(entries: string[], cwd: string): UnreachableEntry[] {
	const out: UnreachableEntry[] = [];
	// 候选目录只找一次：多个包管理器条目指向同一批候选目录，找一次就够。
	let candidates: string[] | undefined;
	const findCandidates = (): string[] => {
		if (candidates === undefined) candidates = packageCandidatesUnder(cwd);
		return candidates;
	};
	for (const raw of entries) {
		const entry = raw.trim();
		if (!entry) continue;
		// 正则条目无法静态判断：跳过，不猜。
		if (entry.startsWith(RE_PREFIX)) continue;
		const head = firstToken(entry);
		if (!head) continue;
		const managerFlag = PACKAGE_MANAGERS[head];
		if (managerFlag !== undefined) {
			const item = packageManagerItem(cwd, entry, head, managerFlag, findCandidates());
			if (item) out.push(item);
			continue;
		}
		if (head === "cargo") {
			const item = cargoItem(cwd, entry);
			if (item) out.push(item);
			continue;
		}
		if (head.startsWith("/")) {
			// 程序位写成绝对路径：这个可以静态核对。
			// 构建产物目录里的文件不存在只说明还没构建，不说明这条授权命中不了。
			if (isBuildArtifactPath(head)) continue;
			if (!existsSync(head)) {
				out.push({ entry, why: `${head} does not exist` });
			}
			continue;
		}
		// 其它程序名一律不判：`git`、`rg`、`node` 的工作目录语义太杂，误报比漏报糟。
	}
	return out;
}
