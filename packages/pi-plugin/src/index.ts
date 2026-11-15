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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allEntries, classifyCommand, deniedEntry, parseBashRule, type BashRule } from "./bash-match.ts";
import { DenyCounter } from "./deny-count.ts";
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
	source: string;
	readOnly: boolean;
	maxReads: number;
	allowTools: string[];
	bash?: BashRule;
	/** 探针配置；undefined = 关闭。 */
	probe: unknown;
	/** 连续被拒多少次算「撞权限」；0 = 关闭。 */
	maxDenies: number;
	active: boolean;
}

const INACTIVE: Policy = {
	globs: [],
	regexps: [],
	source: "未配置",
	readOnly: true,
	maxReads: 0,
	allowTools: [],
	probe: undefined,
	maxDenies: 0,
	active: false,
};

/** bindings 存在但无法使用时的策略：会话保持活跃，但什么都拿不到。 */
function denyAll(source: string): Policy {
	return {
		globs: [],
		regexps: [],
		source,
		readOnly: true,
		maxReads: 0,
		allowTools: [],
		probe: undefined,
		maxDenies: 0,
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
		const g = glob.length > 1 ? glob.replace(/\/+$/, "") || "/" : glob;
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
			error: `${BINDINGS_ENV} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}），全部拒绝`,
		};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { error: `${BINDINGS_ENV} 不是 JSON 对象，全部拒绝` };
	}
	const record = parsed as Record<string, unknown>;
	const key = Object.keys(record).find(
		(k) => k === `${BINDING_NAMESPACE}/1` || k.startsWith(`${BINDING_NAMESPACE}/`),
	);
	// 绑定是给别的扩展的，本扩展不参与。
	if (!key) return {};
	const cfg = record[key];
	if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
		return { error: `extensionBindings ${key} 的配置不是对象，全部拒绝` };
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
function parsePolicyObject(
	config: Record<string, unknown>,
	source: string,
	options: { requireScope: boolean },
): Policy {
	const scope = config.scope;
	const scopeGiven = scope !== undefined;
	if (scopeGiven && (!Array.isArray(scope) || scope.some((g) => typeof g !== "string" || !g.trim()))) {
		return denyAll(`${source}.scope 必须是字符串数组，全部拒绝`);
	}
	if (!scopeGiven && options.requireScope) {
		return denyAll(`${source}.scope 缺失，全部拒绝`);
	}
	const globs = scopeGiven ? (scope as string[]).map((g) => g.trim()).filter(Boolean) : [];
	const allowTools = Array.isArray(config.allowTools)
		? (config.allowTools as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "")
		: [];
	return {
		globs,
		regexps: compile(globs),
		source,
		readOnly: config.readOnly === true,
		maxReads: positiveInt(config.maxReads),
		allowTools,
		bash: parseBashRule(config.bash),
		probe: config.probe,
		// 撞权限是纯错误信号：不配也开，父代理可以显式写 0 关掉。
		maxDenies: config.maxDenies === 0 ? 0 : positiveInt(config.maxDenies) || 3,
		active: true,
	};
}

function isAllowed(policy: Policy, cwd: string, target: string): boolean {
	if (policy.globs.length === 0) return false;
	const abs = resolve(cwd, target);
	const rel = relative(cwd, abs);
	for (const re of policy.regexps) {
		if (re.test(rel) || re.test(abs)) return true;
	}
	return false;
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
	for (const glob of policy.globs) {
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
function sandboxWritableDirs(policy: Policy, cwd: string, rule: BashRule): string[] {
	const dirs = new Set<string>();
	if (rule.writable) {
		for (const dir of writableDirs(policy, cwd)) dirs.add(dir);
		// cwd 本身要可写：根只读，不给的话 git 连索引都写不了，子代理任何落盘
		// 操作都会失败。（cwd 落在 /tmp 下时，helper 不会给它盖私有 tmpfs，见
		// namespace.rs。）
		dirs.add(cwd);
		const worktreeRoot = findWorktreeRoot(cwd);
		if (worktreeRoot) dirs.add(worktreeRoot);
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
		return line ? { path: line } : { error: "pnpm store path 没有输出" };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** /permission 里显示 pnpm store：探测到的路径 + 一句「未放行」的提示。 */
function describePnpmStore(cwd: string): string {
	const found = detectPnpmStore(cwd);
	if (found.path) return `${found.path}（未放行；要让子代理装依赖就写进 bash.writablePaths）`;
	return `探测失败（${found.error ?? "未知原因"}）`;
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

export function writeSpec(cwd: string, rule: BashRule, policy: Policy): string | undefined {
	const spec = {
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
	if (globs.length === 0) return "（空）";
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
	const source = `profile ${name}（${shown}）`;
	if (!existsSync(path)) return { source, error: `${source}：找不到 ${shown}` };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { source, error: `${source}：${shown} 不是合法 JSON（${detail}）` };
	}
	const table = asObject(parsed);
	if (!table) return { source, error: `${source}：${shown} 不是 JSON 对象` };
	if (!("default" in table) && !(name in table)) {
		return { source, error: `${source}：${shown} 里既没有 "default" 也没有 "${name}"` };
	}
	const config = mergeConfig(asObject(table.default), asObject(table[name]));
	if (!config) return { source, error: `${source}：${shown} 里 "${name}" 与 "default" 都不是对象` };
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
	let policy: Policy = call.error
		? denyAll(call.error)
		: call.config
			? parsePolicyObject(call.config, `extensionBindings ${BINDING_NAMESPACE}`, { requireScope: true })
			: INACTIVE;
	let denyCounter = new DenyCounter(policy.maxDenies);
	let allowedReads = 0;
	// 探针要停本轮：abort 是 hard stop，同一个动作可能触发多次，只做一次。
	let aborted = false;
	let lastAbortReason = "";
	/**
	 * 停机：不调 ctx.abort()。硬 abort 会把模型正在生成的收尾汇报一起掐掉，父代理只能
	 * 收到一句工具错误。改为「粘住停止状态 + 后续调用一律 terminate」，pi 在工具批次
	 * 结束后自然收尾，模型有机会把结论写完。
	 */
	const abortNow = () => {
		aborted = true;
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
						abort: abortNow,
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
			allowedReads = 0;
			armProbe();
		}
		if (!policy.active) return;
		const budget = policy.maxReads > 0 ? `，read 预算 ${policy.maxReads} 次` : "";
		const bash = policy.bash
			? `，bash ${policy.bash.read.length} 读 / ${policy.bash.write.length} 写`
			: "，bash 关闭";
		const probeLine = probe ? "，探针开启" : "";
		const storeLine = policy.bash ? `，pnpm store ${detectPnpmStore(cwd).path ?? "探测失败"}` : "";
		const mode = policy.readOnly ? "只读" : "读写";
		const msg = policy.globs.length
			? `任务范围生效（${policy.source}，${policy.globs.length} 条，${mode}${budget}${bash}${probeLine}${storeLine}）`
			: `任务范围为空，所有文件访问都被拒绝${budget}${bash}${probeLine}${storeLine}`;
		ctx.ui.notify(`pi-subagent-extend: ${msg}`, "info");
	});

	pi.on("session_shutdown", async () => {
		probe?.dispose();
	});

	// 探针 3 需要看命令输出；tool_result 里拿。
	pi.on("tool_result", async (event) => {
		if (!probe) return;
		// SAFETY: tool_result 的事件类型只声明了结果载体，没声明 toolName。这里只读
		// 三个字段，且先用 `!== "bash"` 筛掉，拿不到 toolName 就当它不是 bash 结果。
		const p = event as unknown as { toolName?: string; content?: unknown; result?: unknown };
		if (p.toolName !== "bash") return;
		probe.noteBashResult(textOf(p.content) || textOf(p.result));
	});

	pi.on("tool_call", async (event, ctx) => {
		currentCtx = ctx;
		if (!policy.active) return;
		const cwd = ctx.cwd ?? process.cwd();
		const deny = (reason: string) => ({ block: true, reason } as const);
		// 探针在边界上的 warn / 到期停机，先于本工具的判定。
		const boundary = probe?.atToolBoundary();
		if (boundary) {
			if (boundary.stop) {
				lastAbortReason = boundary.reason;
				abortNow();
				return { block: true, reason: boundary.reason };
			}
			return { block: true, reason: boundary.reason, terminate: false };
		}
		// 已经停过：后续调用一律拒绝。不带 terminate——terminate 会在工具批次结束时
		// 直接结束本轮，模型连收尾汇报都来不及写；这里靠「每次都被拒」逼它停止调工具
		// 并输出汇报。
		if (aborted) {
			return { block: true, reason: `${lastAbortReason}\n\n本轮已停止，不要再调用任何工具，直接输出最终汇报。` };
		}

		const bail = (reason: string) => {
			const counted = denyCounter.record();
			if (!counted.yes) return deny(reason);
			const composed = counted.note ? `${reason}\n\n${counted.note}` : reason;
			if (counted.stop) {
				lastAbortReason = composed;
				abortNow();
				return { block: true, reason: composed };
			}
			return { block: true, reason: composed };
		};

		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown })?.command ?? "").trim();
			const rule = policy.bash;
			if (!rule) {
				return bail(
					`pi-subagent-extend: 本会话不允许执行 bash（来源：${policy.source}）。需要跑测试/typecheck 时由父代理在 bindings 里给 bash.read / bash.write 点名命令`,
				);
			}
			if (!command) return deny("pi-subagent-extend: 空的 bash 命令");
			// 禁止列表先于一切判定：它来自项目 profile，调用方的白名单不能放宽它。
			const forbidden = deniedEntry(rule, command);
			if (forbidden) {
				return deny(
					`pi-subagent-extend: bash 命令被项目 profile 禁掉："${forbidden}"（来源：${policy.source}）。这条禁令不受 extensionBindings 的白名单影响`,
				);
			}
			if (SHELL_META.test(command)) {
				return deny(
					`pi-subagent-extend: bash 命令含 shell 元字符（; & | < > \` $ 等），只允许直接调用白名单命令：${preview(allEntries(rule))}`,
				);
			}
			const match = classifyCommand(rule, command);
			if (!match) {
				// 模型能看见这段文案，所以把它需要的路径直接写进去，省得它再猜。
				const store = detectPnpmStore(cwd);
				const storeHint = store.path
					? `（pnpm store 在 ${store.path}，未放行；需要装依赖时由父代理写进 bash.writablePaths）`
					: "";
				return bail(
					`pi-subagent-extend: bash 命令不在白名单内：${preview(allEntries(rule))}（来源：${policy.source}）${storeHint}`,
				);
			}
			const repeatEvent = probe?.noteBashStart(command, match.access);
			if (repeatEvent) {
				if (repeatEvent.stop) {
					lastAbortReason = repeatEvent.reason;
					abortNow();
				}
				return { block: true, reason: repeatEvent.reason };
			}
			const helper = helperPath();
			if (!helper) {
				return deny(
					"pi-subagent-extend: 找不到沙箱 helper（pi-subagent-extend-helper）。在 pi-plugin 目录里跑一次 `pnpm run build:helper`，或用 PI_SUBAGENT_EXTEND_HELPER 指定路径",
				);
			}
			const caps = describeHelper(helper);
			if (!caps?.landlock.supported) {
				const reason = caps?.landlock.reason ?? "helper --describe 没有输出可用信息";
				return deny(`pi-subagent-extend: 当前内核无法强制任务范围：${reason}`);
			}
			const specFile = writeSpec(cwd, rule, policy);
			if (!specFile) {
				return deny("pi-subagent-extend: 写不出沙箱 spec（检查 ~/.cache/pi-subagent-extend 是否可写）");
			}
			(event.input as { command?: string }).command = wrapInSandbox(command, specFile, helper);
			return undefined;
		}
		if (EXEC_TOOLS.includes(event.toolName)) {
			return bail(
				`pi-subagent-extend: 本会话被限定在任务范围内（${preview(policy.globs)}），不允许执行 ${event.toolName}`,
			);
		}
		if (SAFE_TOOLS.includes(event.toolName) || policy.allowTools.includes(event.toolName)) {
			return undefined;
		}

		if (PATH_TOOLS.includes(event.toolName)) {
			const input = (event as { input?: { path?: unknown } }).input;
			const raw = typeof input?.path === "string" ? input.path.trim() : "";
			const target = raw || ".";
			if (event.toolName === READ_TOOL && policy.maxReads > 0 && allowedReads >= policy.maxReads) {
				return bail(`pi-subagent-extend: 已达 read 预算上限（${policy.maxReads} 次）`);
			}
			if (WRITE_TOOLS.includes(event.toolName)) {
				if (policy.readOnly) {
					return bail(`pi-subagent-extend: 本会话只读，禁止 ${event.toolName}（来源：${policy.source}）`);
				}
				// 写操作没有 path 就无法判断目标：直接说清，不要报成「路径不在范围内」。
				// 这是用法错误不是权限错误，不计入撞权限计数。
				if (!raw) {
					return deny(
						`pi-subagent-extend: ${event.toolName} 必须给 path（参数里没有 path，无法判断目标文件是否在任务范围内）。范围：${preview(policy.globs)}`,
					);
				}
			}
			if (!isAllowed(policy, cwd, target)) {
				// 缺 path 时目标其实是 cwd，说清这一点，免得被当成「子代理走错目录」。
				if (!raw) {
					// 缺 path：用法错误，不计入撞权限计数。
					return deny(
						`pi-subagent-extend: 没有给 path，按当前目录（cwd：${cwd}）处理，而它不在任务范围内（来源：${policy.source}）。范围：${preview(policy.globs)}`,
					);
				}
				return bail(
					`pi-subagent-extend: "${target}" 不在任务范围内（来源：${policy.source}）。范围：${preview(policy.globs)}`,
				);
			}
			if (WRITE_TOOLS.includes(event.toolName)) {
				const junk = probe?.checkWriteTarget(target);
				if (junk) return { block: true, reason: junk.reason, terminate: false };
				probe?.noteWriteActivity();
			}
			if (event.toolName === READ_TOOL) allowedReads += 1;
			return undefined;
		}

		return bail(
			`pi-subagent-extend: 工具 ${event.toolName} 不在放行名单内，拒绝（fail closed；确需放行就在 extensionBindings 的 allowTools 里列出）`,
		);
	});

	pi.registerCommand("permission", {
		description: "查看当前任务范围、bash 白名单与探针状态",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			const lines = policy.active
				? [
					`来源: ${policy.source}`,
					`模式: ${policy.readOnly ? "只读" : "读写"}`,
					policy.bash
						? `bash 读: ${policy.bash.read.join(" | ") || "（无）"}`
						: "bash: 关闭",
					policy.bash ? `bash 写: ${policy.bash.write.join(" | ") || "（无）"}` : undefined,
					policy.bash && policy.bash.deny.length > 0
						? `bash 禁（不可放宽）: ${policy.bash.deny.join(" | ")}`
						: undefined,
					policy.bash
						? `沙箱: ${policy.bash.network ? "有网" : "断网"}，${policy.bash.writable ? "scope 可写" : "只读根"}`
						: undefined,
					policy.bash
						? `沙箱可写路径: ${
							sandboxWritableDirs(policy, cwd, policy.bash)
								.map((d) => d.replace(cwd, "."))
								.join(" | ") || "（无）"
						}`
						: undefined,
					policy.bash ? `pnpm store: ${describePnpmStore(cwd)}` : undefined,
					`已读 ${allowedReads}${policy.maxReads > 0 ? `/${policy.maxReads}` : ""} 次`,
					`撞权限: ${denyCounter.status()}`,
					...(probe ? probe.status() : ["探针: 关闭"]),
					...policy.globs.map((g) => `  ${g}`),
				].filter((l): l is string => Boolean(l))
				: ["未生效（本会话没有 pi-subagent-extend 的 extensionBindings，也没有声明 profile）"];
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
