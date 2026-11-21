/**
 * SANDBOX 层：bash 沙箱的装配 —— helper 定位与能力探测（--describe）、git 需要的额外可写目录、
 * 可写目录推导、spec 的构建与落盘（spec 文件的生命周期）、命令包装。
 * 除各 memo（gitDirsCache、pnpmStoreCache、helperCache、toolchainCacheDirMemo、specSeq，
 * 语义上仍是纯推导）外不持有会话状态；index.ts 只做接线。
 * 模块拆分第四步：以下声明从 index.ts 原样搬出，行为不变。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BashRule } from "./bash-match.ts";
import { DETECT_SKIP, detectScratchDirs } from "./dependencies.ts";
import { CONVENTIONAL_TMP, canonical, dropHiddenGrants, expandPath, findWorktreeRoot, insideTree } from "./paths.ts";
import { globToRegExp, normalizeGlob, type Policy } from "./policy.ts";
/**
 * linked worktree 的 git 公共目录（主仓的 .git）。只有 .git 是文件（worktree）时才问 git，
 * 普通仓库直接返回 undefined：那边 .git 在 cwd 之内，不需要额外授权，也省掉一次 spawn。
 * 结果按 cwd 缓存：bash 白名单命令会反复拼 spec。
 */
const gitDirsCache = new Map<string, { gitDir: string; common: string } | undefined>();
/**
 * git 需要可写的路径。
 *
 * 索引、HEAD 与它们的锁文件（`index.lock`、`HEAD.lock`）建在本次 checkout 的 gitdir 根上，
 * 所以那个目录必须整个授权 —— Landlock 只能正向授权，没有「授权目录但排除 hooks/」的写法。
 *
 * 区别在 gitdir 是谁：linked worktree 里它是 `<common>/worktrees/<id>`，里面只有 HEAD /
 * index / logs / refs，没有 hooks 也没有 config；于是 hooks/config 留在 common dir 里，
 * 那里只给 git 真正要写的三个子目录，不再整目录授权（否则子代理能植入 hook 或改
 * core.hooksPath，之后以父代理身份执行）。四个路径全部实测过：少给哪一个都有具体命令
 * 先失败（per-worktree gitdir → index.lock / HEAD.lock；objects → 对象库；refs → ref 锁；
 * logs → reflog 追加）。
 *
 * 普通 checkout 里 gitdir 与 common 就是同一个目录，hooks、config 和索引挤在一起：只能整
 * 目录授权。这是 Landlock 的能力边界，不是实现取舍 —— 只给 objects/refs/logs 加根级文件时，
 * `git add` 第一个死在 `.git/index.lock` 上（实测）。
 */
function gitWritablePaths(git: { gitDir: string; common: string }): string[] {
	if (canonical(git.gitDir) === canonical(git.common)) return [git.gitDir];
	const paths = [git.gitDir];
	for (const name of ["objects", "refs", "logs"]) {
		const abs = resolve(git.common, name);
		// helper 会拒掉不存在的 spec 路径，所以这里先滤一遍。
		if (existsSync(abs)) paths.push(abs);
	}
	return paths;
}

/**
 * git 需要可写的两个目录：本次 checkout 的 gitdir，以及（linked worktree 时）主仓的
 * 公共目录。索引与 ref 分别住在两处，所以两个都要问出来；具体授权哪几层见
 * gitWritablePaths。
 */
function gitDirs(cwd: string): { gitDir: string; common: string } | undefined {
	const key = resolve(cwd);
	if (gitDirsCache.has(key)) return gitDirsCache.get(key);
	let found: { gitDir: string; common: string } | undefined;
	try {
		const out = execFileSync("git", ["rev-parse", "--absolute-git-dir", "--git-common-dir"], {
			cwd: key,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		const [gitDirRaw, commonRaw] = out.trim().split("\n");
		const gitDir = gitDirRaw?.trim();
		const common = commonRaw ? resolve(key, commonRaw.trim()) : "";
		if (gitDir && existsSync(gitDir)) {
			found = { gitDir, common: common && existsSync(common) ? common : gitDir };
		}
	} catch {
		found = undefined;
	}
	gitDirsCache.set(key, found);
	return found;
}

/** helper 的名字：找它、报它、文档里写它都用这一个常量。 */
const HELPER_NAME = "pi-subagents-extend-helper";

/**
 * 找 helper：环境变量优先，其次包装好的 bin/，最后仓内 cargo 产物。
 *
 * 第三个候选是给「源码 checkout + 软链加载」这种用法的：cargo 建好了但没跑
 * `pnpm run build:helper` 把产物拷进 bin/ 时，bash 不该整体失效 —— 这是改名后
 * 真实踩到的坑。npm 安装的副本没有 ../helper，那一条自然落空。
 */
/**
 * helper 候选路径。纯函数，便于直接钉住候选及其顺序：环境变量不是候选，
 * 而是覆盖（设了但不存在就不往下找，否则「指错了」会静默用上另一个）。
 */
export function helperCandidates(here: string): string[] {
	return [
		resolve(here, "..", "bin", HELPER_NAME),
		resolve(here, "..", "..", "helper", "target", "release", HELPER_NAME),
	];
}

export function helperPath(): string | undefined {
	const fromEnv = process.env.PI_SUBAGENTS_EXTEND_HELPER?.trim();
	if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
	const here = dirname(fileURLToPath(import.meta.url));
	for (const candidate of helperCandidates(here)) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/**
 * bash 到底能不能跑。缺 helper 与内核对不上都是「每条命令都拒」，与其让子代理
 * 撞墙几次再自己推断，不如开场就把它说出来。
 */
export function bashBlocker(helper: string | undefined): string | undefined {
	if (!helper) {
		return "no sandbox helper found, so every bash command will be refused. Run `pnpm run build:helper` in packages/pi-plugin, or set PI_SUBAGENTS_EXTEND_HELPER.";
	}
	const caps = describeHelper(helper);
	if (!caps?.landlock.supported) {
		const reason = caps?.landlock.reason ?? "helper --describe returned nothing usable";
		return `this kernel cannot enforce the sandbox (${reason}), so every bash command will be refused`;
	}
	return undefined;
}

/**
 * 整棵子树写法 → 该子树根（相对路径，"" 表示 cwd）。`dir/**`、`**`，以及在 `dir/**`
 * 后面再跟一层单层通配的写法都算；`dir/*.ts` 不算 —— 它只覆盖一部分，须按文件展开。
 *
 * 判据是「第一个通配符段起，剩下的段是否都是 `**`（可带一个收尾的单层 `*`）」：`**`
 * 能吃任意层，所以 `**` 后面再跟一层单层通配仍然覆盖全部；而以单层通配开头只覆盖一层，
 * 例如 `dir` 下一层的 `*` 摸不到子目录里的文件，两层倒过来的写法也摸不到 dir 的直接子文件。
 */
function subtreeRoot(glob: string): string | undefined {
	const segments = glob.split("/");
	const first = segments.findIndex((segment) => /[*?]/.test(segment));
	if (first === -1) return undefined;
	const rest = segments.slice(first);
	if (rest[0] !== "**" || rest.some((segment) => segment !== "**" && segment !== "*")) return undefined;
	return segments.slice(0, first).join("/");
}

/** 展开文件级 glob 时的遍历上限：一条 glob 不该把大仓整个走一遍。 */
const GLOB_WALK_MAX_ENTRIES = 20000;

/**
 * 文件级 glob 展开成实际存在的文件。
 *
 * spec.write 可以列文件，Landlock 对文件路径只授权那个 inode，所以 `src/auth/*.ts`
 * 只打开它真正匹配到的文件，而不是整个 src/auth/。代价是「还没创建的新文件」不在
 * 这里 —— 那需要一个目录级的 MAKE_REG，也就等于把整个目录打开。
 *
 * 走过的目录用 DETECT_SKIP 同一张跳过表：那是「依赖/产物不往里走」的判据，展开 glob
 * 与探测清单是同一件事。软链指到树外的不收：Landlock 按目标 inode 授权，收了就等于
 * 授权树外那个文件。
 */
function expandFileGlob(cwd: string, glob: string): string[] {
	const re = globToRegExp(glob);
	const base = canonical(cwd);
	const segments = glob.split("/");
	const firstWild = segments.findIndex((segment) => /[*?]/.test(segment));
	// 静态前缀：第一个通配符段之前的那些段。调用方只传带通配符的 glob，prefix 不会等于整条。
	const prefix = firstWild === -1 ? "" : segments.slice(0, firstWild).join("/");
	const found: string[] = [];
	const stack = [resolve(cwd, prefix || ".")];
	let seen = 0;
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			seen += 1;
			if (seen > GLOB_WALK_MAX_ENTRIES) return found.sort();
			const abs = resolve(dir, entry.name);
			const rel = insideTree(base, abs);
			if (rel === undefined) continue;
			if (entry.isDirectory()) {
				if (!DETECT_SKIP.has(entry.name)) stack.push(abs);
			} else if (entry.isFile() && (re.test(rel) || re.test(abs))) {
				found.push(abs);
			}
		}
	}
	return found.sort();
}


/** Phase 3 output.deliverable: the real file in the main checkout, for write grants and refusals. */
let deliverableTargetPath: string | undefined;

/**
 * wireDeliverable 登记交付物目标路径（state 在本层，因为唯一的读者是 sandboxWritableDirs）。
 * index.ts 侧的赋值点全部走这一个入口，模块内可变状态只有这一份。
 */
export function setDeliverableTargetPath(path: string | undefined): void {
	deliverableTargetPath = path;
}

/**
 * 写范围 → 沙箱可写路径。
 *
 * 只有覆盖整棵子树的写法（`dir`、`dir/**`）才授权目录本身：授权目录就是授权它下面
 * 所有东西，而 Landlock 只能正向授权、无法从已授权的目录里再排除子目录，所以「目录
 * 授权」必须恰好等于「这条 glob 覆盖到的范围」。文件级写法（`src/auth/*.ts`，以及通配符
 * 在中间层的写法）因此展开成实际存在的文件 —— 旧做法是截到第一个通配符，于是
 * `src/auth/*.ts` 把整个 src/auth/ 打开，中间层通配则把 src/ 整个打开。
 */
function writablePaths(policy: Policy, cwd: string): string[] {
	const paths = new Set<string>();
	// 按写范围派生，不用读范围：bash 的可写面不该比 edit / write 更宽。
	for (const raw of policy.writeGlobs) {
		const glob = normalizeGlob(raw);
		if (!glob) continue;
		const root = subtreeRoot(glob);
		if (root !== undefined) {
			const abs = resolve(cwd, root || ".");
			if (abs !== "/" && existsSync(abs)) paths.add(abs);
			continue;
		}
		if (!/[*?]/.test(glob)) {
			// 纯路径：是目录就授权整棵子树，是文件就授权该文件。
			const abs = resolve(cwd, glob);
			if (abs !== "/" && existsSync(abs)) paths.add(abs);
			continue;
		}
		for (const file of expandFileGlob(cwd, glob)) paths.add(file);
	}
	return [...paths];
}




/**
 * 产物目录：探测结果 + 显式追加。已存在的直接放行；探测到的主产物缺了就创建，
 * 其余缺了不管（空目录本身没有意义）；显式追加的缺了也创建 —— 那是父代理点名的。
 */
function scratchDirs(cwd: string, rule: BashRule, options: { create: boolean }): string[] {
	if (rule.scratchPaths === false) return [];
	const dirs = new Set<string>();
	const add = (abs: string, create: boolean) => {
		if (existsSync(abs)) {
			dirs.add(abs);
			return;
		}
		// /permission 只报告「将要放行什么」：缺的也列出来，但不落盘。
		if (!options.create) {
			dirs.add(abs);
			return;
		}
		// 建 spec 时：只有主产物和显式追加的才创建。创建失败就不放行 —— 把不存在的路径
		// 写进 spec，helper 会拒绝整条命令，报错点离真正的原因太远。
		if (!create) return;
		try {
			mkdirSync(abs, { recursive: true });
			dirs.add(abs);
		} catch {
			// 只读树或权限不足：如实失败，别把它算成已授权。
		}
	};
	for (const { dir, primary } of detectScratchDirs(cwd)) add(dir, primary);
	for (const extra of rule.scratchPaths) add(resolve(cwd, extra), true);
	return [...dirs];
}

/**
 * 状态目录：spec 文件、`git-excludes` 与工具链缓存都放这里，默认 `~/.cache/pi-subagents-extend`。
 *
 * `PI_SUBAGENTS_EXTEND_STATE` 覆盖它，测试用它把套件的写入挪出真实 home。不给覆盖时改 HOME 也能达到
 * 同样效果，但那太粗暴：CI 上的 cargo 是 rustup 的 shim，会去建 `$HOME/.rustup`，而包目录不在沙箱
 * 写授权里，整条工具链用例就被 Landlock 拒掉。
 */
function stateDir(): string {
	const override = process.env.PI_SUBAGENTS_EXTEND_STATE;
	if (override) return resolve(override);
	return resolve(homedir(), ".cache", "pi-subagents-extend");
}

/**
 * 工具链缓存目录。放 ~/.cache 下持久保存：沙箱里的 /tmp 是每次调用私有的 tmpfs，
 * 把 GOCACHE 放那里会让 `go test` 每次都全量重编译。
 * 只设一条 XDG_CACHE_HOME，而不是逐个数 GOCACHE / MYPY_CACHE_DIR / RUFF_CACHE_DIR：
 * 前者是约定（实测 go 的默认 cache 跟着它走），后者是一份要一直维护的工具名单。
 */
let toolchainCacheDirMemo: string | undefined | null = null;

function toolchainCacheDir(): string | undefined {
	if (toolchainCacheDirMemo !== null) return toolchainCacheDirMemo;
	let dir: string | undefined;
	try {
		dir = resolve(stateDir(), "xdg-cache");
		mkdirSync(dir, { recursive: true });
	} catch {
		dir = undefined;
	}
	toolchainCacheDirMemo = dir;
	return dir;
}

/**
 * 沙箱里要绑成可写的路径集合：
 * - 写范围覆盖到的路径（bash.writable 时）：整棵子树的 glob 给目录，文件级 glob 给文件
 * - git 真正要写的目录（见 gitWritablePaths）：不给的话 add / commit / stash 全拼在 index.lock 上
 * - `<cwd>/node_modules`：pnpm install 要写 .bin 里的 shim；worktree 里它是软链，给真实路径
 * - 项目声明的产物目录 + 工具链缓存目录（XDG_CACHE_HOME）
 * - bash.writablePaths 里的全局可写区（pnpm store、mise state 等；bash.writable 时）
 *
 * cwd 本身不在其中：整棵授权等于把整个 checkout 打开，读范围的宽窄不该自动变成写权限。
 * 各项都以 bash.writable 为前提：false 是角色自己定下的上限，任何一层都不该把它放宽。
 */
export function sandboxWritableDirs(
	policy: Policy,
	cwd: string,
	rule: BashRule,
	options: { create: boolean } = { create: true },
): string[] {
	const dirs = new Set<string>();
	if (rule.writable) {
		for (const dir of writablePaths(policy, cwd)) dirs.add(dir);
		// git 的索引与 ref 必须可写，否则 add / commit / stash 全拼在 index.lock 上；但只给
		// git 真正要写的部分，不因此把整个 checkout 打开。linked worktree 的索引在
		// <common>/worktrees/<id> 里，ref 与对象在 common dir 的 refs / logs / objects 里，
		// hooks 和 config 不在授权范围内。
		const git = gitDirs(cwd);
		if (git) {
			for (const path of gitWritablePaths(git)) dirs.add(path);
		}
		// node_modules 也要可写：pnpm install 要写 .bin 里的 shim。它通常不在
		// scope 里，但装依赖是任务的必要步骤。worktree 里它是符号链接，要给
		// 解析后的真实路径：Landlock 规则落在 inode 上，符号链接自身不覆盖目标。
		const nodeModules = resolve(cwd, "node_modules");
		if (existsSync(nodeModules)) {
			try {
				dirs.add(realpathSync(nodeModules));
			} catch {
				dirs.add(nodeModules);
			}
		}
		// 项目自己声明过的产物目录（git 忽略的）：build/test 往这里写。
		for (const dir of scratchDirs(cwd, rule, options)) dirs.add(dir);
		const cache = toolchainCacheDir();
		if (cache) dirs.add(cache);
		for (const raw of rule.writablePaths) {
			const abs = expandPath(cwd, raw);
			if (abs && abs !== "/" && existsSync(abs)) dirs.add(abs);
		}
		// 交付物是文件级授权：只放真实文件，不打开它所在的目录。
		if (deliverableTargetPath) dirs.add(deliverableTargetPath);
	}
	return [...dirs];
}

/** 沙箱里 git 用的全局排除规则：依赖目录不进索引。 */
const GIT_EXCLUDE_PATTERNS = ["node_modules/", ".pnpm-store/"];

/**
 * 写出 git 的全局排除文件。放在 cache 目录下（不是 /tmp：沙箱里的 /tmp 是
 * tmpfs，会把宿主的文件挡住）。
 */
function gitExcludesFile(): string | undefined {
	try {
		const dir = stateDir();
		const file = resolve(dir, "git-excludes");
		const wanted = `${GIT_EXCLUDE_PATTERNS.join("\n")}\n`;
		if (!existsSync(file) || readFileSync(file, "utf8") !== wanted) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, wanted);
		}
		return file;
	} catch {
		return undefined;
	}
}

/**
 * 沙箱里的环境变量：
 * - bindings 给的 bash.env
 * - XDG_RUNTIME_DIR：默认指向沙箱私有的 /tmp。pnpm 12 把自己的锁目录放在
 *   XDG_RUNTIME_DIR（/run/user/<uid>）下，只读根下连 `pnpm run` 都跑不起来。
 * - MISE_STATE_DIR：worktree 场景下 mise 要把新 worktree 的 mise.toml 登记进
 *   ~/.local/state/mise/trusted-configs，只读根下解析配置阶段就失败；
 *   把 state 目录挪到沙箱私有的 /tmp 即可免掉这次登记。
 *
 * 两者都可以被父代理用 bash.env 覆盖。
 */
function sandboxEnv(cwd: string, rule: BashRule): Record<string, string> {
	const env: Record<string, string> = { ...rule.env };
	const privateDir = `/tmp/.pi-subagents-extend-${process.pid}`;
	// git 的全局排除：子代理 `git add -A` 时不把依赖目录吸进索引。
	// 宿主已经设了 GIT_CONFIG_COUNT 就不插手，免得覆盖别人的配置。
	if (rule.gitExcludes && !process.env.GIT_CONFIG_COUNT) {
		const excludes = gitExcludesFile();
		if (excludes) {
			env.GIT_CONFIG_COUNT = "1";
			env.GIT_CONFIG_KEY_0 = "core.excludesFile";
			env.GIT_CONFIG_VALUE_0 = excludes;
		}
	}
	if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `${privateDir}/runtime`;
	// 构建缓存要跨调用持久，所以放 ~/.cache 而不是私有的 /tmp；只在沙箱可写时给，
	// 只读沙箱里指向一个不可写目录只会让报错更难读。
	if (rule.writable) {
		const cache = toolchainCacheDir();
		if (cache && !env.XDG_CACHE_HOME) env.XDG_CACHE_HOME = cache;
	}
	if (!env.MISE_STATE_DIR) {
		const worktreeRoot = findWorktreeRoot(cwd);
		const miseConfig = worktreeRoot ? resolve(worktreeRoot, "mise.toml") : undefined;
		if (miseConfig && existsSync(miseConfig)) env.MISE_STATE_DIR = `${privateDir}/mise`;
	}
	return env;
}

/**
 * 探测 pnpm 的 store 路径（只探测，不自动放行）。路径随 cwd 变，必须用子代理的
 * cwd 跑。探测失败不影响其他功能，只是这一行显示不出来。
 */
const pnpmStoreCache = new Map<string, { path?: string; error?: string }>();

export function detectPnpmStore(cwd: string): { path?: string; error?: string } {
	const cached = pnpmStoreCache.get(cwd);
	if (cached) return cached;
	const found = probePnpmStore(cwd);
	pnpmStoreCache.set(cwd, found);
	return found;
}

function probePnpmStore(cwd: string): { path?: string; error?: string } {
	try {
		const out = execFileSync("pnpm", ["store", "path"], {
			cwd,
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const line = out
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.pop();
		return line ? { path: line } : { error: "pnpm store path printed nothing" };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** /permission 里显示 pnpm store：探测到的路径 + 一句「未放行」的提示。 */
export function describePnpmStore(cwd: string): string {
	const found = detectPnpmStore(cwd);
	if (found.path) return `${found.path} (not writable; add it to bash.writablePaths if the subagent must install dependencies)`;
	return `detection failed (${found.error ?? "unknown cause"})`;
}

function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * helper 的能力探测结果：`--describe` 只读，每个进程查一次。
 */
export type HelperCapabilities = {
	landlock: { kernel_abi: number; required_abi: number; supported: boolean; reason?: string | null };
	network_namespace: boolean;
	resolver_sockets: string[];
};

const helperCache = new Map<string, HelperCapabilities | undefined>();

/** 问 helper 能做到什么程度；拿不到就返回 undefined，调用方按不可用处理。 */
export function describeHelper(helper: string): HelperCapabilities | undefined {
	if (helperCache.has(helper)) return helperCache.get(helper);
	let caps: HelperCapabilities | undefined;
	try {
		// ABI 不够时 --describe 也会输出 JSON，只是退出码非 0；所以按输出解析。
		const out = execFileSync(helper, ["--describe"], {
			encoding: "utf8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		caps = JSON.parse(out) as HelperCapabilities;
	} catch (error) {
		const stdout = (error as { stdout?: unknown })?.stdout;
		if (typeof stdout === "string" && stdout.trim()) {
			try {
				caps = JSON.parse(stdout) as HelperCapabilities;
			} catch {
				caps = undefined;
			}
		}
	}
	helperCache.set(helper, caps);
	return caps;
}

/**
 * 沙箱 spec：每个会话写一次，所有 bash 调用复用。
 *
 * helper 只认绝对路径，这里给的都是 resolve 过的；路径不存在时 helper 会直接拒绝，
 * 所以不存在的可写目录要提前滤掉。
 */
/**
 * 沙箱里默认可写的设备。没有它们，`2>/dev/null` 这种写法会直接 EPERM。
 */
export const SANDBOX_DEVICE_PATHS = [
	"/dev/null",
	"/dev/zero",
	"/dev/full",
	"/dev/random",
	"/dev/urandom",
	"/dev/tty",
	"/dev/pts",
];


/**
 * 命令自己用的临时目录：宿主的 TMPDIR（os.tmpdir() 认它），或 bash.env 里钉住的那一个。
 *
 * 它必须和 helper 挂私有 tmpfs 的目录是**同一个**：只授权、不挂载的目录，写下来落在宿主上，
 * 不是落在沙箱里。所以它既写进 spec 的 `tmp`，也被下面的 `write` 引用，两处不再各说各话。
 */
export function scratchDir(cwd: string, rule: BashRule): string {
	const pinned = rule.env.TMPDIR?.trim();
	// expandPath 对空串返回 undefined，这里已经排除了空串，剩下的只是类型上的可能。
	const wanted = ((pinned ? expandPath(cwd, pinned) : tmpdir()) ?? "").replace(/\/+$/, "") || "/";
	// 根目录不能当挂载点（会盖掉整棵树），不存在的目录既挂不上、Landlock 也会拒绝整个 spec。
	// 这两种情况退回 /tmp：它对 helper 是既有默认值，不会因为一个坏掉的 TMPDIR 让 bash 全灭。
	return wanted !== "/" && existsSync(wanted) ? wanted : CONVENTIONAL_TMP;
}
/** 已提示过的被剔授权：每条命令一份 spec，不记下来就会每调一次重复提示一次。 */
export const reportedHiddenGrants = new Set<string>();
/**
 * 把「授权落在私有 tmpfs 之下、已被剔掉」这件事告诉父代理一次。
 *
 * 不提示的话，子代理只会看到自己的写被 Landlock 拒掉，而真正的原因在配置里：那个目录每次调用都
 * 被挂上一个空的 tmpfs。提示走 UI，不进模型上下文 —— 这是给父代理看的配置告警，不是给子代理的
 * 行动指令（子代理那边已经有「拿报告代替写文件」的既定退路）。
 */
function reportHiddenGrants(dropped: string[], warn: ((message: string) => void) | undefined): void {
	const fresh = dropped.filter((path) => !reportedHiddenGrants.has(path));
	if (fresh.length === 0) return;
	for (const path of fresh) reportedHiddenGrants.add(path);
	warn?.(
		`pi-subagents-extend: write grant(s) dropped: the sandbox mounts a private tmpfs over that path when it can, and a grant below a mount point is hidden inside it: ${fresh.join(", ")}. Write the file with the write tool, or point bash.env.TMPDIR outside /tmp.`
	);
}
export function buildSpec(cwd: string, rule: BashRule, policy: Policy, warn?: (message: string) => void) {
	const scratch = scratchDir(cwd, rule);
	// 落在私有 tmpfs 之下的授权 helper 一律拒（整份 spec 连带 bash 一起死），所以在这里先剔掉：
	// 授权与挂载互相抵消是父代理的配置问题，不该让一条命令整个跑不起来。
	const { kept, dropped } = dropHiddenGrants(
		[
			...new Set([
				...sandboxWritableDirs(policy, cwd, rule),
				// 两个会被私有化的临时目录都放行：命令自己的那个，和约定俗成的 /tmp。
				...[scratch, CONVENTIONAL_TMP].filter((dir) => existsSync(dir)),
				// The helper refuses a spec path that does not exist, so filter here.
				...SANDBOX_DEVICE_PATHS.filter((path) => existsSync(path)),
			]),
		],
		cwd,
		scratch,
	);
	reportHiddenGrants(dropped, warn);
	return {
		cwd,
		read: ["/"],
		// helper 在这个目录上挂一个私有 tmpfs，所以命令写的临时文件留在沙箱里，不落在宿主上。
		// 只在它不等于 helper 的默认值（/tmp）时才写进 spec：约定值本来就不言自明，而且不带这个
		// 字段的 spec 仍能被旧版 helper 解开（它 deny_unknown_fields）。
		...(scratch === CONVENTIONAL_TMP ? {} : { tmp: scratch }),
		write: kept,
		offline: rule.network !== true,
		// 只在开启时写：spec 是 deny_unknown_fields，旧版 helper 拿到这个键会直接拒掉整份
		// spec，所以关闭时必须连键都不出现。
		...(rule.cpuStallSeconds === false ? {} : { stallSeconds: rule.cpuStallSeconds }),
		env: sandboxEnv(cwd, rule),
	};
}

/**
 * 把 spec 写到 helper 读的位置，返回文件路径。
 *
 * 文件名必须**每次调用都唯一**：pi 会并行发出多个工具调用，而 helper 是启动后才读
 * 这份文件。早先用 `spec-<pid>.json`（一个进程一个名字），并行 bash 会互相覆盖——
 * 先起的那条 helper 可能读到后一条的 spec，拿到错的写清单与 cwd，症状是随机、不可
 * 复现的授权失败或命令走错目录。序号只要求进程内唯一，toolCallId 不可打印字符换成下划线。
 */
let specSeq = 0;
export function writeSpecFile(spec: ReturnType<typeof buildSpec>, toolCallId: string): string | undefined {
	const safeId = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
	let temp: string | undefined;
	let file: string | undefined;
	try {
		// homedir() 在 try 里面算：它靠 $HOME 与 passwd，两者都取不到时会抛。抛在这里就让
		// 调用方走「拿不到 spec 就拒绝」的路，而不是把异常抛出判定层。
		const dir = stateDir();
		mkdirSync(dir, { recursive: true });
		specSeq += 1;
		file = resolve(dir, `spec-${process.pid}-${specSeq}-${safeId}.json`);
		// 先写临时文件再改名：helper 只会看到完整内容，不会读到半截 JSON（半截会被
		// deny_unknown_fields / 解析失败拒掉，表现为莫名其妙的 exit 77）。
		temp = `${file}.tmp`;
		writeFileSync(temp, JSON.stringify(spec));
		renameSync(temp, file);
		return file;
	} catch {
		// 写成功、改名失败时暂存文件会留下来。我们不知道失败发生在哪一步，所以两个路径
		// 都试一遍（force 让多删一次无害），别让一次失败变成一份永久垃圾。
		for (const path of [temp, file]) {
			if (path === undefined) continue;
			try {
				rmSync(path, { force: true });
			} catch {
				// 清不掉也不影响本次判定。
			}
		}
		return undefined;
	}
}

/** 删掉某次调用的 spec 文件。结果不会再回来时（结果回来了、或者被挤出上限）靠它收尾。 */
export function dropSpecFile(entry: { specFile?: string } | undefined): void {
	if (!entry?.specFile) return;
	try {
		rmSync(entry.specFile, { force: true });
	} catch {
		// 删不掉不影响判定，session_shutdown 的清扫会兜底。
	}
}

/**
 * 清掉遗留的 spec 文件。
 *
 * 正常路径（tool_result）删自己那份，但会话被中断、进程被杀、或者一次 bash 调用的结果
 * 永不回来时，文件就留在 ~/.cache/pi-subagents-extend 里。这里按**年龄**清：只删 10 分钟
 * 以前的，别的 pi 进程正在用的新文件不会被碰。只认 `spec-` 前缀，因为同一个目录里还放着
 * `git-excludes` 文件和 `xdg-cache` 目录。
 */
export function sweepStaleSpecFiles(): void {
	const cutoff = Date.now() - 10 * 60 * 1000;
	try {
		const dir = stateDir();
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.startsWith("spec-") || !/\.json(\.tmp)?$/.test(entry.name)) continue;
			const path = resolve(dir, entry.name);
			try {
				if (statSync(path).mtimeMs > cutoff) continue;
				rmSync(path, { force: true });
			} catch {
				// 单个文件失败不影响其它文件。
			}
		}
	} catch {
		// 目录不存在或读不了：没有可清扫的东西。
	}
}

/**
 * 把命令交给 helper：它在 exec 前给自己套上 Landlock 与网络命名空间，所以白名单命令
 * 拿到的就是已经限定好范围、断好网的进程。
 */
export function wrapInSandbox(command: string, specFile: string, helper: string): string {
	return [helper, "--spec", specFile, "--", "bash", "-lc", command].map(shellQuote).join(" ");
}
