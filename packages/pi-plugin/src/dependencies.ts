/**
 * DEPENDENCY-ENVIRONMENT 层：依赖环境探测与闸门 —— 工具链产物目录探测（scratch dirs）、
 * lockfile / 安装凭据检查、依赖闸门（dependency gate）的命令归类与最终判定。
 * 除 `scratchDirsCache`（探测结果按 cwd 的 memo，语义上仍是纯函数）外不持有会话状态；
 * index.ts 只做接线。
 * 模块拆分第三步：以下声明从 index.ts 原样搬出，行为不变。
 */
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
/**
 * 工具链 → 项目里会出现的产物目录。判据是仓库根（及其一层子目录，覆盖 monorepo 的
 * packages/*）里的清单文件：有 Cargo.toml 就是 Rust 项目，有 package.json 就是 Node 项目。
 * 只读文件，不 spawn 进程，也不猜「这个目录现在存不存在」。
 *
 * dirs 里的目录：存在就放行，不存在就不管（空目录没有意义，凭空造一堆更吵）。
 * primary 里的目录：属于该工具链的主产物，缺了就创建 —— `cargo test` 一定会写 target/，
 * 不放行也不创建的话，命令第一次跑就是 Permission denied。
 */
const TOOLCHAINS: { markers: string[]; dirs: string[]; primary: string[] }[] = [
	{
		markers: ["package.json"],
		dirs: ["coverage", "dist", "build", ".next", ".nuxt", ".output", ".svelte-kit", ".turbo", ".vite", ".parcel-cache", ".cache", ".angular"],
		primary: [],
	},
	{ markers: ["Cargo.toml"], dirs: ["target"], primary: ["target"] },
	{
		markers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
		dirs: ["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".venv"],
		primary: ["__pycache__"],
	},
	{ markers: ["go.mod"], dirs: ["bin"], primary: [] },
	{ markers: ["pom.xml"], dirs: ["target"], primary: ["target"] },
	{ markers: ["build.gradle", "build.gradle.kts"], dirs: ["build", ".gradle"], primary: ["build"] },
	{ markers: ["mix.exs"], dirs: ["_build", "deps"], primary: ["_build"] },
	{ markers: ["pubspec.yaml"], dirs: [".dart_tool", "build"], primary: [".dart_tool"] },
	{ markers: ["Gemfile"], dirs: ["tmp", "log", ".bundle"], primary: [] },
	{ markers: ["Package.swift"], dirs: [".build"], primary: [".build"] },
	{ markers: ["build.zig"], dirs: ["zig-out", "zig-cache", ".zig-cache"], primary: ["zig-out", "zig-cache"] },
	{ markers: ["stack.yaml", "cabal.project"], dirs: ["dist-newstyle", ".stack-work"], primary: ["dist-newstyle"] },
	{ markers: ["CMakeLists.txt"], dirs: ["build"], primary: ["build"] },
	{ markers: ["*.csproj", "*.sln"], dirs: ["obj", "bin"], primary: [] },
];

/**
 * 清单也往子目录里找两层（`packages/web/package.json` 这种 monorepo 布局），
 * 但不开销太大：跳过明显的产物/依赖目录，并给总量封顶。
 */
export const DETECT_SKIP = new Set(["node_modules", ".git", "dist", "build", "target", ".venv", "vendor", "__pycache__", "bin", "obj"]);
const DETECT_MAX_ROOTS = 200;

const scratchDirsCache = new Map<string, { dir: string; primary: boolean }[]>();

/** 探测结果按 cwd 缓存：bash 白名单命令会反复拼 spec。 */
/**
 * 按名字排序（纯函数，供 `sortedEntries` 与测试使用）。用字典序而不是 localeCompare：
 * 后者的结果依赖运行时的 locale，那正好是排序要消除的那类不确定性。
 */
export function sortByName<T extends { name: string }>(entries: T[]): T[] {
	return entries.sort((a, b) => {
		if (a.name === b.name) return 0;
		return a.name < b.name ? -1 : 1;
	});
}

/**
 * 目录项按名字排序后返回；读不了就当作空目录。
 *
 * readdir 的顺序由文件系统决定：这台机器上 tmpfs 给的是排序结果，而 ext4 的 dir_index、
 * XFS、NFS 给的是哈希序。扫描有 DETECT_MAX_ROOTS 的名额上限，顺序不定就意味着
 * 「哪些目录被检查、被授权」随机器而变 —— 闸门可能在一台机器上放行、在另一台上拒绝。
 * 排序把这个不确定性按死。
 */
export function sortedEntries(dir: string): Dirent[] {
	try {
		return sortByName(readdirSync(dir, { withFileTypes: true }));
	} catch {
		return [];
	}
}

export function detectScratchDirs(cwd: string): { dir: string; primary: boolean }[] {
	const key = resolve(cwd);
	const cached = scratchDirsCache.get(key);
	if (cached) return cached;

	const found: { dir: string; primary: boolean }[] = [];
	const roots = [key];
	// 广度优先往下两层，遇到产物/依赖目录不再深入。
	let frontier = [key];
	for (let depth = 0; depth < 2 && roots.length < DETECT_MAX_ROOTS; depth += 1) {
		const next: string[] = [];
		for (const dir of frontier) {
			for (const entry of sortedEntries(dir)) {
				if (!entry.isDirectory() || DETECT_SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
				const child = resolve(dir, entry.name);
				roots.push(child);
				next.push(child);
				if (roots.length >= DETECT_MAX_ROOTS) break;
			}
			if (roots.length >= DETECT_MAX_ROOTS) break;
		}
		frontier = next;
	}

	for (const root of roots) {
		let entries: string[] = [];
		try {
			entries = readdirSync(root);
		} catch {
			continue;
		}
		for (const toolchain of TOOLCHAINS) {
			const matched = toolchain.markers.some((marker) =>
				marker.startsWith("*.")
					? entries.some((name) => name.endsWith(marker.slice(1)))
					: entries.includes(marker),
			);
			if (!matched) continue;
			for (const name of toolchain.dirs) {
				found.push({ dir: resolve(root, name), primary: toolchain.primary.includes(name) });
			}
		}
	}

	scratchDirsCache.set(key, found);
	return found;
}

/**
 * 有依赖的项目以 lockfile 为准（只有 package.json 不算：那可能只是个配置包）。
 * 判据：有 lockfile 的目录必须出现过安装结果 —— `node_modules/.bin`，或 Yarn PnP 的 `.pnp.cjs`。
 */
const LOCKFILES = new Set([
	"pnpm-lock.yaml",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
	"bun.lockb",
	"bun.lock",
]);

/** Yarn 2+ 的 PnP 不建 node_modules，`.pnp.cjs` 才是「装好了」的凭据。 */
const PNP_MARKERS = [".pnp.cjs", ".pnp.js"];

/**
 * 依赖根：cwd 往下两层里有 lockfile 的目录。`ignored` 里的前缀不参与。
 *
 * 不缓存。会话中途 `git checkout` 一个新增了包的分支是很常见的动作，而闸门的 `git` 豁免
 * 恰好让这个动作畅通无阻 —— 缓存会让闸门停在旧结论上。这个扫描只在闸门真正生效时跑，
 * 代价是几个 readdir。
 */
function dependencyRoots(cwd: string, ignored: string[]): string[] {
	return dependencyScope(cwd, ignored).filter(hasLockfile);
}

/**
 * 要查的目录：cwd 与它往下两层的子目录（跳过依赖/产物目录与被忽略的目录）。
 *
 * 被忽略的目录在遍历时就剪掉，而不是收集完再筛：一棵 fixtures 树能占满
 * DETECT_MAX_ROOTS 的名额，把真包挤出扫描范围，闸门于是无声失效。
 */
export function dependencyScope(cwd: string, ignored: string[]): string[] {
	const key = resolve(cwd);
	if (gateIgnores(cwd, ignored, key)) return [];
	const roots = [key];
	let frontier = [key];
	// 与工具链探测同一个范围：cwd 往下两层，跳过依赖/产物目录。
	for (let depth = 0; depth < 2 && roots.length < DETECT_MAX_ROOTS; depth += 1) {
		const next: string[] = [];
		for (const dir of frontier) {
			for (const entry of sortedEntries(dir)) {
				if (!entry.isDirectory() || DETECT_SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
				const child = resolve(dir, entry.name);
				if (gateIgnores(cwd, ignored, child)) continue;
				roots.push(child);
				next.push(child);
				if (roots.length >= DETECT_MAX_ROOTS) break;
			}
			// 外层也要断：内层 break 只退出当前目录，frontier 里剩下的每个目录还会各推一个
			// 子目录进来，250 个目录的树能得 246 个 root，而文档说的是 200。
			if (roots.length >= DETECT_MAX_ROOTS) break;
		}
		frontier = next;
	}
	return roots;
}

/** 目录里有没有 lockfile。软链的也算：workspace 常把它链到共享文件。 */
function hasLockfile(dir: string): boolean {
	try {
		return readdirSync(dir, { withFileTypes: true }).some(
			(entry) => (entry.isFile() || entry.isSymbolicLink()) && LOCKFILES.has(entry.name),
		);
	} catch {
		return false;
	}
}

/**
 * 依赖没装好的目录（相对 cwd，`.` 表示就是 cwd）。
 *
 * 沙箱里 store 多半不可写，pnpm 于是退回一个空 store 去装，那条 WARN 埋在几百行输出里，
 * 构建则可能干脆卡在锁上 —— 与其让第一条命令莫名卡死，不如在它跑起来之前点名缺哪个目录。
 */
function missingDependencies(cwd: string, ignored: string[]): string[] {
	return dependencyRoots(cwd, ignored)
		.filter((dir) => !installed(dir))
		.map((dir) => relative(cwd, dir) || ".");
}

/**
 * `dir` 是否落在某个被忽略的目录前缀里。
 *
 * 前缀按 cwd 解析，并且必须对齐目录边界：`fixtures` 忽略 fixtures 本身及其下全部，
 * 不会连坐 `fixtures-old`。这与 scope 里写一个纯目录路径的含义一致（那也覆盖整棵子树），
 * 但**不收 glob**：闸门的用途是「这个目录没人装依赖」，那是一处固定位置，
 * 一条写死的路径就够；允许 `fixtures/*` 这类写法只会让「我明明忽略了它」变成调试题。
 */
function gateIgnores(cwd: string, ignored: string[], dir: string): boolean {
	return ignored.some((prefix) => {
		// resolve 对绝对路径本就返回它自己，所以绝对前缀天然可以指到 cwd 之上；相对前缀
		// 则一定落在 cwd 之下，包含 cwd 的只有 "." / ".." 这类写法（等于关掉整道闸门）。
		const rel = relative(resolve(cwd, prefix), dir);
		return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
	});
}

/** 装好的两个凭据：`node_modules/.bin`（普通安装）或 `.pnp.cjs`（Yarn PnP）。 */
function installed(dir: string): boolean {
	if (existsSync(resolve(dir, "node_modules", ".bin"))) return true;
	return PNP_MARKERS.some((marker) => existsSync(resolve(dir, marker)));
}

/** 闸门的拒绝文案；依赖齐了返回 undefined。 */
function dependencyGateReason(cwd: string, ignored: string[]): string | undefined {
	const missing = missingDependencies(cwd, ignored);
	if (missing.length === 0) return undefined;
	const shown = missing.slice(0, 3).join(", ");
	const rest = missing.length > 3 ? ` and ${missing.length - 3} more` : "";
	// 忽略项是字面路径，不认 glob。写成 `fixtures/*` 或写错一个字母都会静默匹配不到任何目录，
	// 于是「我明明忽略了它」变成调试题 —— 点名一句，省掉那一轮。
	const globbed = ignored.filter((prefix) => /[*?]/.test(prefix));
	const hint = globbed.length > 0
		? ` Ignore entries are literal paths, not globs: ${globbed.join(", ")} matched nothing.`
		: "";
	return `pi-subagents-extend: ${shown}${rest} has a lockfile but no node_modules/.bin or .pnp.cjs, so this command would run against an unfinished install. File tools still work; use contact_supervisor so the parent finishes the install or grants the store.${hint}`;
}

/** 命令的第一个词，跳过 `FOO=bar cmd` 这类前置赋值。 */
function commandHead(command: string): string {
	for (const token of command.trim().split(/\s+/)) {
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
		return basename(token);
	}
	return "";
}

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun", "npx", "pnpx", "bunx", "corepack"]);

/**
 * 包在另一条命令外面的壳。`sh -c "pnpm test"`、`env pnpm test`、`exec pnpm test`
 * 的第二个词才是真正要跑的命令，只看第一个词会把它们当成阅读类放过去。
 */
const COMMAND_WRAPPERS = new Set([
	"sh", "bash", "zsh", "dash", "ash", "ksh", "env", "exec", "command",
	"nohup", "setsid", "nice", "ionice", "stdbuf", "timeout", "xargs",
]);

/**
 * 包装器后面真正要跑的那条命令的名字。
 *
 * 跳过包装器自己、它的选项、`NAME=value` 前置赋值和纯数值参数（`timeout 30 pnpm test`）。
 * 只看头而不扫描全部词元：`sh -c "rg pnpm"` 是在搜这个字，不该被当成要装依赖。
 */
function payloadHead(command: string): string {
	const words = command.split(/[\s'"]+/).filter(Boolean);
	for (const word of words.slice(1)) {
		if (word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || /^[0-9]/.test(word)) continue;
		if (COMMAND_WRAPPERS.has(basename(word))) continue;
		return basename(word);
	}
	return "";
}

/**
 * 闸门只管「会去装依赖」的那几类：写类命令（构建、测试）与包管理器本身。
 *
 * `git` 与只读命令不受影响。git 不需要 node_modules，而「先落任务日志再提交」这种保树
 * 纪律恰恰在依赖缺失时最要用得上 —— 把 git 一起挡掉，拒绝就发生在最不该发生的时刻。
 *
 * 包装器要穿透到载荷的命令名上，否则 `sh -c "pnpm test"` 会从侧面跳过闸门；但只认载荷
 * 的命令名，不认命令里出现的字，否则 `sh -c "rg pnpm"` 会被误拦。脚本文件
 * （`node build.mjs`）里写的是什么从命令行看不出来，那是这条判据的边界。
 */
function dependencyGateApplies(command: string, access: "read" | "write"): boolean {
	const head = commandHead(command);
	if (head === "git") return false;
	if (!COMMAND_WRAPPERS.has(head)) {
		if (access === "write") return true;
		return PACKAGE_MANAGERS.has(head);
	}
	// 包装器要穿透到载荷的命令名；`env git commit` 照样享 git 豁免。
	// `command -v pnpm` 是问「这个工具在不在」，不是跑它。
	if (head === "command" && /(^|\s)-[vV](\s|$)/.test(command)) return false;
	const payload = payloadHead(command);
	if (payload === "" || payload === "git") return false;
	if (PACKAGE_MANAGERS.has(payload)) return true;
	return access === "write";
}

/** 闸门的最终判定：关掉、不适用或依赖齐全时返回 undefined。 */
export function dependencyGateVerdict(
	rule: { dependencyGate: string[] | false },
	command: string,
	access: "read" | "write",
	cwd: string,
): string | undefined {
	if (rule.dependencyGate === false || !dependencyGateApplies(command, access)) return undefined;
	return dependencyGateReason(cwd, rule.dependencyGate);
}
