/**
 * pi-subagent-extend — 把一个会话（主要是子代理）能碰的文件限制在任务范围内。
 *
 * 设计目标：父代理委派子代理时指定本次任务的文件/目录范围，子代理会话里
 * 范围之外的 tool_call 一律拒绝（fail closed），防止子代理漫无目的地扫仓库。
 *
 * 配置有两条来源：
 * 1. pi-subagents 的 extensionBindings。父代理在 subagent 工具调用里传：
 *      extensionBindings: { "pi-subagent-extend/1": { "scope": ["src/auth/**"], "maxReads": 20 } }
 *    pi-subagents 把它编码进 PI_SUBAGENT_EXTENSION_BINDINGS 传给子代理，本扩展在
 *    激活时（factory）一次性读取。前台子代理的这个环境变量只在会话启动前存在，
 *    之后父进程环境被恢复，所以不能在 tool_call 里懒读。
 * 2. agent profile（src/profile.ts）：agent 定义里声明一份两行 loader，角色默认值
 *    写在项目 .pi/subagent-bindings.json。调用方的 bindings 按 key 覆盖默认值，但
 *    bash.deny 取并集、不可放宽。profile 是文件，按会话 cwd 读，所以在 session_start
 *    解析。
 *
 * 两条都没有时扩展不生效：父会话和未绑定范围的子代理不受影响。
 *
 * 扩展还随包带一个用法 skill（../skills/pi-subagent-extend），经 resources_discover
 * 注册给会话：扩展加载到哪个会话，父代理侧就能看到「委派时如何传 bindings」的约定，
 * 不需要往 AGENTS.md 里写。
 *
 * 生效时的规则：
 * - read / edit / write / grep / find / ls：解析 path（缺省为 cwd），命中范围
 *   放行，否则拒绝；readOnly 时 edit / write 一律拒绝
 * - bash：默认拒绝。bindings 里写 bash.allow（命令前缀白名单，如 "pnpm run typecheck"）
 *   后，只有命中白名单的命令放行，并且改写成交给沙箱 helper 执行：读写范围由
 *   Landlock 强制（内核 ABI 7 起），网络默认断（bash.network 可开）：断网时连
 *   UDP/DNS 一起断，靠私有网络命名空间 + 盖掉解析器套接字；可写目录只有 scope
 *   （bash.writable 时）与 bash.writablePaths，防止用 shell 绕过范围去改文件
 * - powershell / codemode：一律拒绝（没有路径可判，能绕过范围）
 * - structured_output 与 allowTools 里列出的工具：放行（执行器类不可放行）
 * - 其余未知工具：拒绝
 *
 * 通配符：** 任意层目录；* 单层内任意字符；? 单个字符。纯路径 glob 额外匹配
 * 该目录自身与其下所有内容；"dir/**" 也匹配 "dir" 本身。
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { allEntries, classifyCommand, deniedEntry, parseBashRule, type BashRule } from "./bash-match.ts";
import { DenyCounter } from "./deny-count.ts";
import { handoffHintFor, withHint } from "./handoff-hint.ts";
import { networkFailureNote, writeRefusalNote } from "./sandbox-note.ts";
import { Probe, parseProbeConfig } from "./probe.ts";

const BINDINGS_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";
const BINDING_NAMESPACE = "pi-subagent-extend";
/** agent 角色默认 bindings 的默认位置（相对会话 cwd）。 */
const PROFILE_FILE = ".pi/subagent-bindings.json";
/**
 * 随包发布的用法 skill 目录，经 resources_discover 注册，扩展加载即生效。
 * 三个：范围与 bash 白名单、探针判据与停机语义、上下文隔离（AGENTS.md 标记与主代理专属文件）。
 */
const SKILL_DIRS = ["pi-subagent-extend", "pi-subagent-extend-probes", "pi-subagent-extend-context"].map((name) =>
	fileURLToPath(new URL(`../skills/${name}`, import.meta.url)),
);

const READ_TOOL = "read";
const PATH_TOOLS = ["read", "edit", "write", "grep", "find", "ls"];
const WRITE_TOOLS = ["edit", "write"];
const EXEC_TOOLS = ["bash", "powershell", "codemode"];
/**
 * 不碰文件系统的会话级运行时工具，范围生效时照常放行。
 * contact_supervisor / intercom 是子代理向父代理（监督者）转告的正当通道——探针的
 * 停机判据本来就要它立刻上报，封锁它只会把信息憋在死掉的会话里。
 */
const SAFE_TOOLS = ["structured_output", "contact_supervisor", "intercom"];

/** shell 元字符：出现就不放行，否则白名单前缀可以被拼进任意命令。 */
const SHELL_META = /[;&|<>()`$\n\r\\]/;

interface Policy {
	globs: string[];
	regexps: RegExp[];
	/** 写范围（edit / write 工具）。没配 writeScope 时等于读范围；readOnly 时为空。 */
	writeGlobs: string[];
	writeRegexps: RegExp[];
	source: string;
	readOnly: boolean;
	maxReads: number;
	allowTools: string[];
	bash?: BashRule;
	/** 探针配置；undefined = 关闭。 */
	probe: unknown;
	/** 连续被拒多少次算「撞权限」；0 = 关闭。 */
	maxDenies: number;
	/** 写拒的独立预算：写拒是用法错，换个交付方式就能解决，不该跟读拒共用额度。 */
	maxWriteDenies: number;
	active: boolean;
}

const INACTIVE: Policy = {
	globs: [],
	regexps: [],
	writeGlobs: [],
	writeRegexps: [],
	source: "not configured",
	readOnly: true,
	maxReads: 0,
	allowTools: [],
	probe: undefined,
	maxDenies: 0,
	maxWriteDenies: 0,
	active: false,
};

/** 撞权限的缺省预算；两处都要用，所以提出来。 */
const DEFAULT_MAX_DENIES = 5;
const DEFAULT_MAX_WRITE_DENIES = 2;

/**
 * bindings 存在但无法使用时的策略：会话保持活跃，但什么都拿不到。
 *
 * 预算用缺省值而不是 0：0 表示「永不计数」，那会让一次写坏的绑定变成无限重试的会话 ——
 * 每个调用都被拒、却永远不会停，正是这条判据要避免的状态。拒几次就硬停，父代理能从拒绝
 * 文案里看到真实原因（哪一份绑定、哪里写错）。
 */
function denyAll(source: string): Policy {
	return {
		globs: [],
		regexps: [],
		writeGlobs: [],
		writeRegexps: [],
		source,
		readOnly: true,
		maxReads: 0,
		allowTools: [],
		probe: undefined,
		maxDenies: DEFAULT_MAX_DENIES,
		maxWriteDenies: DEFAULT_MAX_WRITE_DENIES,
		active: true,
	};
}

/**
 * glob → 正则，单趟扫描。不能串 replace：`**` 先变成 `.*` 后，后一步的 `*` 规则会
 * 把新生成的 `*` 再改写一遍（"**" 曾变成 ".[^/]*"）。
 */
function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i += 1) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				// `**/` 吃掉整段目录（含零段），`**` 吃掉任意层任意字符。
				if (glob[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (ch === "?") {
			re += "[^/]";
		} else {
			re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`);
}

/**
 * 展开目录语义后编译。"dir/**" 额外匹配 "dir" 本身；不含通配符的纯路径额外
 * 匹配 "dir/**"，所以范围写 "src" 就覆盖 src 及其下所有内容。
 */
function compile(globs: string[]): RegExp[] {
	const expanded = new Set<string>();
	for (const glob of globs) {
		// 尾斜杠只是目录写法，去掉后再展开，否则 "dir/" 会变成 "dir//**"。
		const raw = glob.length > 1 ? glob.replace(/\/+$/, "") || "/" : glob;
		// "." 和 "./" 表示整棵树。不归一的话会编译成 ^\.$ / ^\./.*$，而 matches 比的是
		// 相对路径 —— 仓库根的相对路径是空串、子文件是 "src/a.ts"，两条都命中不了，
		// 于是 scope: ["."]（文档里的「读全仓」写法）什么也授权不了。
		// 开头的 "./" 同理要去掉："." 归一成 "**"（整棵树），"./src" 归一成 "src"。
		const g = raw === "." ? "**" : raw.replace(/^\.\//, "");
		expanded.add(g);
		if (g.endsWith("/**")) expanded.add(g.slice(0, -3) || "/");
		else if (!/[*?]/.test(g)) expanded.add(`${g}/**`);
	}
	return [...expanded].map(globToRegExp);
}

function positiveInt(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 从 PI_SUBAGENT_EXTENSION_BINDINGS 里取本扩展的 namespace 配置对象。 */
function extractCallConfig(raw: string | undefined): { config?: Record<string, unknown>; error?: string } {
	if (!raw?.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			error: `${BINDINGS_ENV} is not valid JSON (${error instanceof Error ? error.message : String(error)}); everything is refused`,
		};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { error: `${BINDINGS_ENV} is not a JSON object; everything is refused` };
	}
	const record = parsed as Record<string, unknown>;
	const key = Object.keys(record).find(
		(k) => k === `${BINDING_NAMESPACE}/1` || k.startsWith(`${BINDING_NAMESPACE}/`),
	);
	// 绑定是给别的扩展的，本扩展不参与。
	if (!key) return {};
	const cfg = record[key];
	if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
		return { error: `extensionBindings ${key}: the configuration is not an object; everything is refused` };
	}
	return { config: cfg as Record<string, unknown> };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

/** bash 里的 deny 条目（字符串且非空）。 */
function bashDenyEntries(bash: unknown): string[] {
	const cfg = asObject(bash);
	const deny = cfg?.deny;
	if (!Array.isArray(deny)) return [];
	return deny.filter((d): d is string => typeof d === "string" && d.trim() !== "").map((d) => d.trim());
}

/**
 * 合并两层配置（profile 默认值与本次调用的 bindings）：调用方的键覆盖默认值的键，
 * `bash` 整个对象覆盖。但 `bash.deny` 取并集——deny 是限制，调用方不能靠重写 bash
 * 把项目禁掉的命令要回来。
 */
function mergeConfig(
	base: Record<string, unknown> | undefined,
	over: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!base) return over;
	if (!over) return base;
	const merged: Record<string, unknown> = { ...base, ...over };
	const deny = [...new Set([...bashDenyEntries(base.bash), ...bashDenyEntries(over.bash)])];
	if (deny.length > 0) {
		const bash = asObject(over.bash) ?? asObject(base.bash) ?? {};
		merged.bash = { ...bash, deny };
	}
	return merged;
}

/**
 * 配置对象 → 策略。
 *
 * `requireScope` 为 true 时（本次调用的 bindings）scope 必须写成字符串数组，写错
 * 就全拒；为 false 时（agent profile 的默认值）允许不写 scope：角色的默认值不知道
 * 本次任务管哪些路径，此时文件访问全拒但 bash 白名单照常可用——漏传 bindings 是
 * 「响的」失败，不是「什么限制都没有」。
 */
/**
 * 写范围（edit / write 工具），与 bash.writablePaths（进程层）分开：
 *   不写 writeScope → 等于读范围，现有派单行为不变；
 *   readOnly → 压过一切，等价于空写范围；
 *   写了 → 只认这一份，写超出即拒，读不受影响。
 */
function parseWriteScope(
	config: Record<string, unknown>,
	globs: string[],
	readOnly: boolean,
	source: string,
): { writeGlobs?: string[]; error?: string } {
	if (readOnly) return { writeGlobs: [] };
	if (config.writeScope === undefined) return { writeGlobs: globs };
	const ws = config.writeScope;
	if (!Array.isArray(ws) || ws.some((g) => typeof g !== "string" || !g.trim())) {
		return { error: `${source}.writeScope must be an array of strings; everything is refused` };
	}
	return { writeGlobs: (ws as string[]).map((g) => g.trim()).filter(Boolean) };
}

function parsePolicyObject(
	config: Record<string, unknown>,
	source: string,
	options: { requireScope: boolean },
): Policy {
	const scope = config.scope;
	const scopeGiven = scope !== undefined;
	if (scopeGiven && (!Array.isArray(scope) || scope.some((g) => typeof g !== "string" || !g.trim()))) {
		return denyAll(`${source}.scope must be an array of strings; everything is refused`);
	}
	if (!scopeGiven && options.requireScope) {
		return denyAll(`${source}.scope is missing; everything is refused`);
	}
	const globs = scopeGiven ? (scope as string[]).map((g) => g.trim()).filter(Boolean) : [];
	const readOnly = config.readOnly === true;
	const write = parseWriteScope(config, globs, readOnly, source);
	if (write.error) return denyAll(write.error);
	const writeGlobs = write.writeGlobs as string[];
	const allowTools = Array.isArray(config.allowTools)
		? (config.allowTools as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "")
		: [];
	return {
		globs,
		regexps: compile(globs),
		writeGlobs,
		writeRegexps: compile(writeGlobs),
		source,
		readOnly,
		maxReads: positiveInt(config.maxReads),
		allowTools,
		bash: parseBashRule(config.bash),
		probe: config.probe,
		// 撞权限是纯错误信号：不配也开，父代理可以显式写 0 关掉。
		// 缺省 5：停机是硬停，判早一次就丢掉整轮任务，而多给几次只浪费几个调用。
		maxDenies: config.maxDenies === 0 ? 0 : positiveInt(config.maxDenies) || DEFAULT_MAX_DENIES,
		// 缺省 2：写拒是用法错（该回报告而不是落盘），给两次机会换做法就够。
		maxWriteDenies: config.maxWriteDenies === 0 ? 0 : positiveInt(config.maxWriteDenies) || DEFAULT_MAX_WRITE_DENIES,
		active: true,
	};
}

/**
 * 真实路径。目标可能还不存在（写新文件），所以取最深的已存在祖先做 realpath，再把剩下的段拼回去。
 *
 * 为什么必须 realpath：词法比较只看路径字符串，软链是唯一能绕过它的向量 —— `src/link` 指到树外时，
 * `write src/link/evil` 在词法上仍是 `src/` 之下。bash 那条路有 Landlock 按 inode 兜底，edit/write
 * 工具在父进程里跑，没有第二层。
 */
function canonical(path: string): string {
	let head = path;
	const rest: string[] = [];
	for (;;) {
		try {
			const real = realpathSync(head);
			return rest.length === 0 ? real : join(real, ...rest.slice().reverse());
		} catch {
			const parent = dirname(head);
			if (parent === head) return path;
			rest.push(basename(head));
			head = parent;
		}
	}
}

/** 目标是否落在某个范围里：相对路径与绝对路径都试，scope 写哪种都认。 */
function matches(regexps: RegExp[], cwd: string, target: string): boolean {
	if (regexps.length === 0) return false;
	const base = canonical(cwd);
	const abs = canonical(resolve(cwd, target));
	const rel = relative(base, abs);
	// 落在工作树之外的一律不认。范围是相对项目写的，项目就是这棵树；软链指到树外时真实路径
	// 会带 ".."，整棵树的范围（"." / "**"）也不该把它放进来。
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
	for (const re of regexps) {
		if (re.test(rel) || re.test(abs)) return true;
	}
	return false;
}

/**
 * "." / "./" / 仓库根 / "/"：目标不是某个文件，而是「整棵树」。单独区分出来，
 * 这样拒绝文案能直说「这是仓库根」，而不是让人以为 scope 写法有错。
 */
function isRootish(raw: string, cwd: string): boolean {
	const abs = resolve(cwd, raw);
	return abs === cwd || abs === "/";
}

/**
 * linked worktree 的 git 公共目录（主仓的 .git）。只有 .git 是文件（worktree）时才问 git，
 * 普通仓库直接返回 undefined：那边 .git 在 cwd 之内，不需要额外授权，也省掉一次 spawn。
 * 结果按 cwd 缓存：bash 白名单命令会反复拼 spec。
 */
const gitDirsCache = new Map<string, { gitDir: string; common: string } | undefined>();
/**
 * git 需要可写的两个目录：本次 checkout 的 gitdir，以及（linked worktree 时）主仓的
 * 公共目录。索引与 ref 分别住在两处，只给一个时 git add / commit / stash 会拼在
 * index.lock 上。普通仓两者相同，只需 .git 本身。
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

/** 找 helper：环境变量优先，其次包内构建产物，最后缓存目录。 */
function helperPath(): string | undefined {
	const fromEnv = process.env.PI_SUBAGENT_EXTEND_HELPER?.trim();
	if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(here, "..", "bin", "pi-subagent-extend-helper"),
		resolve(homedir(), ".pi", "subagent-permission", "bin", "pi-subagent-extend-helper"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** scope 里可写的那几个目录：取每条 glob 的静态前缀，存在才 bind。 */
function writableDirs(policy: Policy, cwd: string): string[] {
	const dirs = new Set<string>();
	// 按写范围派生，不用读范围：bash 的可写面不该比 edit / write 更宽。
	for (const glob of policy.writeGlobs) {
		const literal = glob.split(/[*?]/)[0].replace(/\/+$/, "");
		if (!literal) continue;
		const abs = resolve(cwd, literal);
		if (abs !== "/" && existsSync(abs)) dirs.add(abs);
	}
	return [...dirs];
}

/**
 * 找 git worktree 的根：从 cwd 往上找第一个「.git 是文件」的目录。
 * worktree 里 .git 是指向主仓 gitdir 的文件；主仓 checkout 里 .git 是目录。
 * 返回 undefined 表示不在 worktree 里。
 */
export function findWorktreeRoot(cwd: string): string | undefined {
	let dir = resolve(cwd);
	for (let i = 0; i < 64; i += 1) {
		const dotGit = resolve(dir, ".git");
		if (existsSync(dotGit)) {
			try {
				const st = statSync(dotGit);
				// worktree：.git 是文件
				if (!st.isDirectory()) return dir;
				return undefined;
			} catch {
				return undefined;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

/** 展开 ~ 与相对路径；返回 undefined 表示不是可用路径。 */
function expandPath(cwd: string, raw: string): string | undefined {
	const value = raw.trim();
	if (!value) return undefined;
	if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
	if (value === "~") return homedir();
	if (value.startsWith("/")) return value;
	return resolve(cwd, value);
}

/**
 * 沙箱里要绑成可写的路径集合：
 * - scope 命中的目录（bash.writable 时）
 * - worktree 根本身（bash.writable 时）：scope 通常只写到 worktree 里的相对路径，
 *   而 package.json、node_modules 这类 worktree 根级文件在范围之外，不绑就只读
 * - bash.writablePaths 里的全局可写区（pnpm store、mise state 等）
 */
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
const DETECT_SKIP = new Set(["node_modules", ".git", "dist", "build", "target", ".venv", "vendor", "__pycache__", "bin", "obj"]);
const DETECT_MAX_ROOTS = 200;

const scratchDirsCache = new Map<string, { dir: string; primary: boolean }[]>();

/** 探测结果按 cwd 缓存：bash 白名单命令会反复拼 spec。 */
function detectScratchDirs(cwd: string): { dir: string; primary: boolean }[] {
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
			try {
				for (const entry of readdirSync(dir, { withFileTypes: true })) {
					if (!entry.isDirectory() || DETECT_SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
					const child = resolve(dir, entry.name);
					roots.push(child);
					next.push(child);
					if (roots.length >= DETECT_MAX_ROOTS) break;
				}
			} catch {
				// 读不了就跳过这一支。
			}
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
		dir = resolve(homedir(), ".cache", "pi-subagent-extend", "xdg-cache");
		mkdirSync(dir, { recursive: true });
	} catch {
		dir = undefined;
	}
	toolchainCacheDirMemo = dir;
	return dir;
}

function sandboxWritableDirs(
	policy: Policy,
	cwd: string,
	rule: BashRule,
	options: { create: boolean } = { create: true },
): string[] {	const dirs = new Set<string>();
	if (rule.writable) {
		for (const dir of writableDirs(policy, cwd)) dirs.add(dir);
		// git 的索引与 ref 必须可写，否则 add / commit / stash 全拼在 index.lock 上；但只给
		// git 目录本身，不因此把整个 checkout 打开。linked worktree 的索引与 ref 在**主仓**的
		// gitdir 里（<common>/worktrees/<id>/index、<common>/refs），普通仓就是 <repo>/.git。
		// Lab 实测见 Lab/git-worktree/probe.sh。
		const git = gitDirs(cwd);
		if (git) {
			dirs.add(git.gitDir);
			dirs.add(git.common);
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
	}
	for (const raw of rule.writablePaths) {
		const abs = expandPath(cwd, raw);
		if (abs && abs !== "/" && existsSync(abs)) dirs.add(abs);
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
		const dir = resolve(homedir(), ".cache", "pi-subagent-extend");
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
	const privateDir = `/tmp/.pi-subagent-extend-${process.pid}`;
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
function describePnpmStore(cwd: string): string {
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
const SANDBOX_DEVICE_PATHS = [
	"/dev/null",
	"/dev/zero",
	"/dev/full",
	"/dev/random",
	"/dev/urandom",
	"/dev/tty",
	"/dev/pts",
];

/** 这次命令的 spec；`writeRefusalNote` 要拿它的 `write` 判断越界写。 */
export function buildSpec(cwd: string, rule: BashRule, policy: Policy) {
	return {
		cwd,
		read: ["/"],
		// The helper mounts a private tmpfs on the scratch dir, so writes there stay
		// inside the sandbox; when the cwd already sits in it, the mount is skipped
		// and the write allowance below is what makes it usable.
		write: [
			...new Set([
				...sandboxWritableDirs(policy, cwd, rule),
				tmpdir(),
				// The helper refuses a spec path that does not exist, so filter here.
				...SANDBOX_DEVICE_PATHS.filter((path) => existsSync(path)),
			]),
		],
		offline: rule.network !== true,
		env: sandboxEnv(cwd, rule),
	};
}

/** 把 spec 写到 helper 读的位置，返回文件路径。 */
function writeSpecFile(spec: ReturnType<typeof buildSpec>): string | undefined {
	try {
		const dir = resolve(homedir(), ".cache", "pi-subagent-extend");
		mkdirSync(dir, { recursive: true });
		const file = resolve(dir, `spec-${process.pid}.json`);
		writeFileSync(file, JSON.stringify(spec));
		return file;
	} catch {
		return undefined;
	}
}

/**
 * 把命令交给 helper：它在 exec 前给自己套上 Landlock 与网络命名空间，所以白名单命令
 * 拿到的就是已经限定好范围、断好网的进程。
 */
export function wrapInSandbox(command: string, specFile: string, helper: string): string {
	return [helper, "--spec", specFile, "--", "bash", "-lc", command].map(shellQuote).join(" ");
}

function preview(globs: string[]): string {
	if (globs.length === 0) return "(empty)";
	const shown = globs.slice(0, 12).join(", ");
	return globs.length > 12 ? `${shown} …` : shown;
}

export interface ActivateOptions {
	/** agent 角色的默认 bindings 名；由 profile() 传入。 */
	profileName?: string;
	/** profile 文件路径，默认 .pi/subagent-bindings.json（相对会话 cwd）。 */
	profileFile?: string;
}

/**
 * 读 agent 角色的默认 bindings：先取文件里的 "default"，再用该角色名那一层覆盖。
 * 声明了 profile 却拿不到默认值（文件缺失、JSON 坏、两个键都没有）时返回 error，
 * 由调用方转成全拒——沉默地退回不设限是最坏的降级。
 */
function readProfile(
	cwd: string,
	name: string,
	file?: string,
): { config?: Record<string, unknown>; source: string; error?: string } {
	const path = resolve(cwd, file ?? PROFILE_FILE);
	const shown = path.startsWith(`${cwd}/`) ? relative(cwd, path) : path;
	const source = `profile ${name} (${shown})`;
	if (!existsSync(path)) return { source, error: `${source}: ${shown} not found` };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { source, error: `${source}: ${shown} is not valid JSON (${detail})` };
	}
	const table = asObject(parsed);
	if (!table) return { source, error: `${source}: ${shown} is not a JSON object` };
	if (!("default" in table) && !(name in table)) {
		return { source, error: `${source}: ${shown} has neither "default" nor "${name}"` };
	}
	const config = mergeConfig(asObject(table.default), asObject(table[name]));
	if (!config) return { source, error: `${source}: ${shown}: neither "${name}" nor "default" is an object` };
	return { config, source };
}

/**
 * profile 定下的策略：默认值打底，本次调用的 bindings 覆盖。本次 bindings 自己
 * 写坏时返回 undefined，由调用方保持全拒——不让 profile 把错误掩盖成「可用」。
 */
function profilePolicy(
	cwd: string,
	options: ActivateOptions,
	call: Record<string, unknown> | undefined,
	callBroken: boolean,
): Policy | undefined {
	if (!options.profileName || callBroken) return undefined;
	const resolved = readProfile(cwd, options.profileName, options.profileFile);
	if (resolved.error) return denyAll(resolved.error);
	const merged = mergeConfig(resolved.config, call) ?? {};
	return parsePolicyObject(merged, resolved.source, { requireScope: false });
}

export function activate(pi: ExtensionAPI, options: ActivateOptions = {}) {
	// bindings 在激活时定格：前台子代理的 bindings 环境变量只在会话启动前存在，
	// tool_call 里读不到，必须在这里取。profile 的文件反过来——要按会话 cwd 读，
	// 所以在 session_start 里解析。
	const call = extractCallConfig(process.env[BINDINGS_ENV]);
	let policy: Policy = INACTIVE;
	/** toolCallId → 这次 bash 的 spec 摘要（写清单、cwd、是否离线）。 */
	const sandboxSpecs = new Map<string, { write: string[]; cwd: string; offline: boolean }>();
	if (call.error) {
		policy = denyAll(call.error);
	} else if (call.config) {
		policy = parsePolicyObject(call.config, `extensionBindings ${BINDING_NAMESPACE}`, { requireScope: true });
	}
	let denyCounter = new DenyCounter(policy.maxDenies);
	// 写拒单独计数：写拒的正解是换交付方式（回报告），跟「授权写错」不是一类信号。
	let writeDenyCounter = new DenyCounter(policy.maxWriteDenies, "write");
	let allowedReads = 0;
	// 停机是硬停：每个被拦的结果都带 terminate，pi 在整批结果都 terminating 时结束本轮
	// （docs/extensions.md："terminate only applies to a blocked call; the agent stops early
	// only when every finalized result in the batch is terminating"）。停止后整批都会被拦，
	// 所以不留「一切都拒绝、模型还在反复试」的软状态。
	let stopped = false;
	let stopReason = "";
	const stop = (reason: string) => {
		stopped = true;
		stopReason = reason;
		return { block: true, reason, terminate: true } as const;
	};
	let currentCtx: { cwd?: string; actions?: unknown; ui?: unknown } | undefined;
	let probe: Probe | undefined;
	/** 按当前 policy 建探针。profile 要到 session_start 才读出，所以这里可重跑。 */
	const armProbe = () => {
		const probeCfg = parseProbeConfig(policy.probe);
		probe =
			policy.active && probeCfg
				? new Probe({
					config: probeCfg,
					readOnly: policy.readOnly,
					hooks: {
						warn: (text) => {
							const ui = currentCtx?.ui as { notify?: (m: string, t?: string) => void } | undefined;
							ui?.notify?.(`pi-subagent-extend: ${text}`, "warning");
						},
					},
				})
				: undefined;
	};
	armProbe();

	// 绑定与方法约定（skill）一起提供给会话：扩展被加载，skill 就进系统提示的
	// 可用列表；父代理据此知道委派时传 extensionBindings。已上锁的会话不注册——
	// 它不委派，也不该去读一个自己被范围拦住的文件。
	// 判定函数放在 activate 作用域：tool_call 回调保持扁平，计数器也在这里。
	const deny = (reason: string) => ({ block: true, reason } as const);
	const bail = (reason: string) => {
		const counted = denyCounter.record();
		if (!counted.yes) return deny(reason);
		const composed = counted.note ? `${reason}\n\n${counted.note}` : reason;
		return counted.stop ? stop(composed) : deny(composed);
	};
	// 写拒自己的预算：文案必须给出「改用回报告」这条出路，否则子代理只会换个路径再试。
	const writeBail = (reason: string) => {
		const counted = writeDenyCounter.record();
		if (!counted.yes) return deny(reason);
		const composed = counted.note ? `${reason}\n\n${counted.note}` : reason;
		return counted.stop ? stop(composed) : deny(composed);
	};

	/** 路径类工具的判定：读认读范围，写认写范围，两类拒绝各自计数、各自文案。 */
	const pathToolVerdict = (
		event: { toolName: string; input?: unknown },
		cwd: string,
	): { block: true; reason: string; terminate?: boolean } | undefined => {
		if (!PATH_TOOLS.includes(event.toolName)) return undefined;
		const input = (event as { input?: { path?: unknown } }).input;
		const raw = typeof input?.path === "string" ? input.path.trim() : "";
		const target = raw || ".";
		const isWrite = WRITE_TOOLS.includes(event.toolName);
		if (event.toolName === READ_TOOL && policy.maxReads > 0 && allowedReads >= policy.maxReads) {
			return bail(`pi-subagent-extend: read budget exhausted (${policy.maxReads} reads).`);
		}
		if (isWrite && policy.readOnly) {
			return bail(`pi-subagent-extend: this session is read-only; ${event.toolName} is refused (source: ${policy.source}).`);
		}
		// 写操作没有 path 就无法判断目标：直接说清，不要报成「路径不在范围内」。
		// 这是用法错误不是权限错误，不计入撞权限计数。
		if (isWrite && !raw) {
			return deny(
				`pi-subagent-extend: ${event.toolName} needs a path; the target cannot be checked without one. Pass it explicitly.\nWrite scope: ${preview(policy.writeGlobs)}`,
			);
		}
		const readOk = matches(policy.regexps, cwd, target);
		if (isWrite) {
			if (!matches(policy.writeRegexps, cwd, target)) {
				// 读得到、写不到：这是最常见也最容易误导的拒绝，文案要直说撞的是写范围，
				// 并给出正解——回报告——而不是「换个路径再试」。
				if (readOk) {
					return writeBail(
						`pi-subagent-extend: "${target}" is readable but not writable — the write scope is ${preview(policy.writeGlobs)} (source: ${policy.source}). Deliver a report instead of writing a file; use contact_supervisor if it really has to be written.`,
					);
				}
				return bail(
					`pi-subagent-extend: "${target}" is outside the scope — neither readable nor writable (source: ${policy.source}). Do not retry outside paths; if you need this one, say what and why.\nRead scope: ${preview(policy.globs)}\nWrite scope: ${preview(policy.writeGlobs)}`,
				);
			}
		} else if (!readOk) {
			// 缺 path 时目标其实是 cwd，说清这一点，免得被当成「子代理走错目录」。
			if (!raw) {
				// 缺 path：用法错误，不计入撞权限计数。
				return deny(
					`pi-subagent-extend: no path was given; the working directory (${cwd}) was assumed and is outside the read scope (source: ${policy.source}). Pass a path inside the scope.\nRead scope: ${preview(policy.globs)}`,
				);
			}
			// cwd / 仓库根：读起来像 scope 写错，其实多半是「想要全仓搜索」。计数（这是
			// 授权问题），但要说清这不是某个文件路径写错。
			if (isRootish(raw, cwd)) {
				return bail(
					`pi-subagent-extend: "${raw}" is the repository root, not a file in the read scope (source: ${policy.source}). Pass the concrete path; if repo-wide access is really needed, say so and the parent can widen the scope.\nRead scope: ${preview(policy.globs)}`,
				);
			}
			return bail(
				`pi-subagent-extend: "${target}" is outside the read scope (source: ${policy.source}). Do not retry outside paths; if you need this one, say what and why.\nRead scope: ${preview(policy.globs)}`,
			);
		}
		if (isWrite) {
			const junk = probe?.checkWriteTarget(target);
			if (junk) return { block: true, reason: junk.reason, terminate: false };
			probe?.noteWriteActivity();
		}
		if (event.toolName === READ_TOOL) allowedReads += 1;
		return undefined;
	};

	pi.on("resources_discover", async () => (policy.active ? {} : { skillPaths: SKILL_DIRS }));

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		const cwd = ctx.cwd ?? process.cwd();
		// profile 只在声明了它的入口里生效：agent 的 subagentOnlyExtensions 会加载
		// 那份两行 loader，主会话不会加载，所以主会话不会被项目默认值误锁。
		const resolved = profilePolicy(cwd, options, call.config, Boolean(call.error));
		if (resolved) {
			probe?.dispose();
			policy = resolved;
			denyCounter = new DenyCounter(policy.maxDenies);
			writeDenyCounter = new DenyCounter(policy.maxWriteDenies, "write");
			allowedReads = 0;
			armProbe();
		}
		if (!policy.active) return;
		const budget = policy.maxReads > 0 ? `, read budget ${policy.maxReads}` : "";
		const bash = policy.bash
			? `, bash ${policy.bash.read.length} read / ${policy.bash.write.length} write`
			: ", bash off";
		const probeLine = probe ? ", probe on" : "";
		const storeLine = policy.bash ? `, pnpm store ${detectPnpmStore(cwd).path ?? "detection failed"}` : "";
		const mode = policy.readOnly ? "read-only" : "read-write";
		const sameWrite = policy.writeGlobs.join("\n") === policy.globs.join("\n");
		const writeNote = sameWrite ? "" : `, write scope ${policy.writeGlobs.length} entries`;
		const msg = policy.globs.length
			? `scope active (${policy.source}, ${policy.globs.length} entries${writeNote}, ${mode}${budget}${bash}${probeLine}${storeLine})`
			: `scope is empty: every file access is refused${budget}${bash}${probeLine}${storeLine}`;
		ctx.ui.notify(`pi-subagent-extend: ${msg}`, "info");
	});

	pi.on("session_shutdown", async () => {
		probe?.dispose();
	});

	// tool_result 干三件事：
	// 1. 探针 3 要看 bash 的输出；
	// 2. 子代理的 worktree 单会在这里返回交接单路径，就地补一句「该看哪个键」；
	// 3. 离线沙箱里的网络失败要就地说明「这是主代理没授权」，否则子代理会当成
	//    环境坏了，换 registry / 加 timeout 反复重试。
	pi.on("tool_result", async (event) => {
		const text = textOf(event.content);
		const isBash = event.toolName === "bash";
		if (probe && isBash) probe.noteBashResult(text);
		// bash 没开时命令根本没跑，别去解释它的结果。
		const offline = policy.bash !== undefined && policy.bash.network !== true;
		const ran = sandboxSpecs.get(event.toolCallId);
		if (ran) sandboxSpecs.delete(event.toolCallId);
		const hints = [
			handoffHintFor(text),
			isBash ? networkFailureNote(text, offline) : undefined,
			isBash && ran ? writeRefusalNote(text, ran.write, ran.cwd) : undefined,
		].filter((hint): hint is string => Boolean(hint));
		if (!hints.length) return undefined;
		return { content: withHint(event.content, hints.join("\n\n")) };
	});

	// 后台子代理完成后，pi-subagents 用 sendMessage 把通知注入会话（正文带 `Parallel handoff:`）。
	// 实测 message_end 不会为这种注入消息触发，所以改用 context：每次 LLM 调用前拿到完整
	// 消息表，就地补一句。它就是模型实际看到的内容，不依赖通知用什么 role 送达。
	pi.on("context", async (event) => {
		let changed = false;
		const messages = event.messages.map((message) => {
			if (message.role !== "custom" && message.role !== "user") return message;
			const text = textOf(message.content);
			// 便宜的前置筛：没有 handoff 字样就不进正则。
			if (!text.includes("handoff")) return message;
			const hint = handoffHintFor(text);
			if (!hint) return message;
			changed = true;
			const content = Array.isArray(message.content)
				? withHint(message.content, hint)
				: withHint(message.content, hint);
			return { ...message, content };
		});
		return changed ? { messages } : undefined;
	});

	const judgeToolCall = async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined | void> => {
		currentCtx = ctx;
		if (!policy.active) return;
		const cwd = ctx.cwd ?? process.cwd();
		// 求援通道不受任何停机影响：被停住的子代理最需要的就是「报告我卡在哪」。
		if (SAFE_TOOLS.includes(event.toolName)) return undefined;
		if (stopped) return { block: true, reason: stopReason, terminate: true };
		// 探针在边界上的 warn / 到期停机，先于本工具的判定。
		const boundary = probe?.atToolBoundary();
		if (boundary) {
			if (boundary.stop) return stop(boundary.reason);
			return { block: true, reason: boundary.reason, terminate: false };
		}

		// 拒绝分两类，分类标准只有一条：**父代理放宽授权能不能解决**。
		//   能 → 撞权限计数（bail）：范围外路径、命令不在白名单、read 预算、readOnly 写、
		//         工具不在 allowTools、整个 bash 被关。这些是「授权与任务不匹配」的信号。
		//   不能 → 只拒不计（deny）：用法错误（缺 path、空命令、shell 元字符）、
		//          项目 profile 的硬禁令、永远不开放的工具、环境/内核缺能力。
		// 把后一类算进预算，会让一次参数写错就提前判死长任务。

		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown })?.command ?? "").trim();
			const rule = policy.bash;
			if (!rule) {
				return bail(
					`pi-subagent-extend: bash is not allowed here (source: ${policy.source}). For tests or a typecheck the parent must list the commands in bash.read / bash.write.`,
				);
			}
			if (!command) return deny("pi-subagent-extend: empty bash command");
			// 禁止列表先于一切判定：它来自项目 profile，调用方的白名单不能放宽它。
			const forbidden = deniedEntry(rule, command);
			if (forbidden) {
				return deny(
					`pi-subagent-extend: command blocked by the project profile: "${forbidden}" (source: ${policy.source}); extensionBindings cannot lift it.`,
				);
			}
			if (SHELL_META.test(command)) {
				return deny(
					`pi-subagent-extend: shell metacharacters are not allowed (; & | < > \` $ …): run one allowlisted command. Allowed: ${preview(allEntries(rule))}`,
				);
			}
			const match = classifyCommand(rule, command);
			if (!match) {
				// 模型能看见这段文案，所以把它需要的路径直接写进去，省得它再猜。
				const store = detectPnpmStore(cwd);
				const storeHint = store.path
					? ` (pnpm store at ${store.path}, not writable; the parent can add it to bash.writablePaths)`
					: "";
				return bail(
					`pi-subagent-extend: command not in the allowlist: ${preview(allEntries(rule))} (source: ${policy.source})${storeHint}`,
				);
			}
			const repeatEvent = probe?.noteBashStart(command, match.access);
			if (repeatEvent) {
				return repeatEvent.stop
					? stop(repeatEvent.reason)
					: { block: true, reason: repeatEvent.reason, terminate: false };
			}
			const helper = helperPath();
			if (!helper) {
				return deny(
					"pi-subagent-extend: the sandbox helper (pi-subagent-extend-helper) was not found; run `pnpm run build:helper` in pi-plugin, or set PI_SUBAGENT_EXTEND_HELPER.",
				);
			}
			const caps = describeHelper(helper);
			if (!caps?.landlock.supported) {
				const reason = caps?.landlock.reason ?? "helper --describe returned no usable information";
				return deny(`pi-subagent-extend: this kernel cannot enforce the task scope: ${reason}`);
			}
			const spec = buildSpec(cwd, rule, policy);
			const specFile = writeSpecFile(spec);
			if (!specFile) {
				return deny("pi-subagent-extend: cannot write the sandbox spec; check that ~/.cache/pi-subagent-extend is writable");
			}
			// 记下这条命令的写权限清单：tool_result 判「写越界」时要用它当事实依据，
			// 不靠文案猜。挡住条数上限，避免结果永远不回来的调用把表撑大。
			if (sandboxSpecs.size >= 64) {
				const oldest = sandboxSpecs.keys().next().value as string | undefined;
				if (oldest !== undefined) sandboxSpecs.delete(oldest);
			}
			sandboxSpecs.set(event.toolCallId, { write: spec.write, cwd, offline: spec.offline });
			(event.input as { command?: string }).command = wrapInSandbox(command, specFile, helper);
			return undefined;
		}
		if (EXEC_TOOLS.includes(event.toolName)) {
			// 从来不可用：给多宽的范围、多长的命令白名单都不会打开，所以不计入撞权限。
			return deny(
				`pi-subagent-extend: ${event.toolName} is never available in a scoped session; no grant can widen it. Use read, edit, write, grep, find, ls, or an allowlisted bash command.`,
			);
		}
		// SAFE_TOOLS 已经在最前面处理过，这里只管调用方显式放行的工具。
		if (policy.allowTools.includes(event.toolName)) return undefined;

		if (PATH_TOOLS.includes(event.toolName)) {
			return pathToolVerdict(event as { toolName: string; input?: unknown }, cwd);
		}

		return bail(
			`pi-subagent-extend: tool ${event.toolName} is not on the allow list (fail closed; the parent can add it to allowTools).`,
		);
	};

	pi.on("tool_call", async (event, ctx) => {
		const verdict = await judgeToolCall(event, ctx);
		// 放行的调用把两类「连续」计数都清零。判据是连续而不是累计：子代理改了做法就该重新计数，
		// 否则早期的一次误判会在几十轮之后把任务判死。
		//
		// 求援通道不清零：它是报告，不是进展。否则每次试探之间插一句 contact_supervisor 就能
		// 永远停在「警告」档，硬停判据直接失效。
		if (verdict === undefined && !SAFE_TOOLS.includes(event.toolName)) {
			denyCounter.reset();
			writeDenyCounter.reset();
		}
		return verdict;
	});

	pi.registerCommand("permission", {
		description: "Show the current task scope, the bash allowlist and the probe state",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			const lines = policy.active
				? [
					`Source: ${policy.source}`,
					`Mode: ${policy.readOnly ? "read-only" : "read-write"}`,
					policy.readOnly || policy.writeGlobs.join("\n") === policy.globs.join("\n")
						? undefined
						: `Write scope: ${policy.writeGlobs.join(" | ") || "(none)"}`,
					`Read scope: ${policy.globs.join(" | ") || "(none)"}`,
					`Read denials: ${denyCounter.status()} · write denials: ${writeDenyCounter.status()}`,
					policy.bash
						? `bash read: ${policy.bash.read.join(" | ") || "(none)"}`
						: "bash: off",
					policy.bash ? `bash write: ${policy.bash.write.join(" | ") || "(none)"}` : undefined,
					policy.bash && policy.bash.deny.length > 0
						? `bash deny (cannot be lifted): ${policy.bash.deny.join(" | ")}`
						: undefined,
					policy.bash
						? `Sandbox: ${policy.bash.network ? "network on" : "offline"}, ${policy.bash.writable ? "scope writable" : "read-only root"}`
						: undefined,
					policy.bash
						? `Sandbox writable paths: ${
							sandboxWritableDirs(policy, cwd, policy.bash, { create: false })
								.map((d) => d.replace(cwd, "."))
								.join(" | ") || "(none)"
						}`
						: undefined,
					policy.bash ? `pnpm store: ${describePnpmStore(cwd)}` : undefined,
					`Reads: ${allowedReads}${policy.maxReads > 0 ? `/${policy.maxReads}` : ""}`,
					...(probe ? probe.status() : ["Probe: off"]),
				].filter((l): l is string => Boolean(l))
				: ["Inactive (no pi-subagent-extend bindings and no profile declared in this session)"];
			ctx.ui.notify(`pi-subagent-extend:\n${lines.join("\n")}`, "info");
		},
	});
}

export default function (pi: ExtensionAPI) {
	activate(pi);
}

/** 从 tool_result 的 content/result 里抽纯文本。 */
function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
				return "";
			})
			.join("\n");
	}
	if (value && typeof value === "object" && "text" in value) return String((value as { text: unknown }).text ?? "");
	return "";
}
