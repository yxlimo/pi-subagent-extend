/**
 * pi-allow-reads — 把一个会话（主要是子代理）能碰的文件限制在任务范围内。
 *
 * 设计目标：父代理委派子代理时指定本次任务的文件/目录范围，子代理会话里
 * 范围之外的 tool_call 一律拒绝（fail closed），防止子代理漫无目的地扫仓库。
 *
 * 配置只来自 pi-subagents 的 extensionBindings。父代理在 subagent 工具调用里传：
 *      extensionBindings: { "pi-allow-reads/1": { "scope": ["src/auth/**"], "maxReads": 20 } }
 * pi-subagents 把它编码进 PI_SUBAGENT_EXTENSION_BINDINGS 传给子代理，本扩展在
 * 激活时（factory）一次性读取。前台子代理的这个环境变量只在会话启动前存在，
 * 之后父进程环境被恢复，所以不能在 tool_call 里懒读。
 *
 * 没有 bindings 时扩展不生效：父会话和未绑定范围的子代理不受影响。
 *
 * 扩展还随包带一个用法 skill（../skills/pi-allow-reads），经 resources_discover
 * 注册给会话：扩展加载到哪个会话，父代理侧就能看到「委派时如何传 bindings」的约定，
 * 不需要往 AGENTS.md 里写。
 *
 * 生效时的规则：
 * - read / edit / write / grep / find / ls：解析 path（缺省为 cwd），命中范围
 *   放行，否则拒绝；readOnly 时 edit / write 一律拒绝
 * - bash：默认拒绝。bindings 里写 bash.allow（命令前缀白名单，如 "pnpm run typecheck"）
 *   后，只有命中白名单的命令放行，并且改写成在 bwrap 沙箱里执行：只读根、断网
 *   （bash.network 可开）、可写目录只有 scope（bash.writable 时），防止用 shell
 *   绕过范围去改文件
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
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allEntries, classifyCommand, commandMatches, parseBashRule, type BashRule } from "./bash-match.ts";
import { DenyCounter } from "./deny-count.ts";
import { Probe, parseProbeConfig } from "./probe.ts";

const BINDINGS_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";
const BINDING_NAMESPACE = "pi-allow-reads";
/**
 * 随包发布的用法 skill 目录，经 resources_discover 注册，扩展加载即生效。
 * 拆成两个：范围与 bash 白名单、探针判据与停机语义。
 */
const SKILL_DIRS = ["pi-allow-reads", "pi-allow-reads-probes"].map((name) =>
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

/** 从 PI_SUBAGENT_EXTENSION_BINDINGS 里取本扩展的 namespace；没有则返回 undefined。 */
function bindingsPolicy(raw: string | undefined): Policy | undefined {
	if (!raw?.trim()) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return denyAll(
			`${BINDINGS_ENV} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}），全部拒绝`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return denyAll(`${BINDINGS_ENV} 不是 JSON 对象，全部拒绝`);
	}
	const record = parsed as Record<string, unknown>;
	const key = Object.keys(record).find(
		(k) => k === `${BINDING_NAMESPACE}/1` || k.startsWith(`${BINDING_NAMESPACE}/`),
	);
	// 绑定是给别的扩展的，本扩展不参与。
	if (!key) return undefined;
	const cfg = record[key];
	if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
		return denyAll(`extensionBindings ${key} 的配置不是对象，全部拒绝`);
	}
	const config = cfg as Record<string, unknown>;
	const scope = config.scope;
	if (!Array.isArray(scope) || scope.some((g) => typeof g !== "string" || !g.trim())) {
		return denyAll(`extensionBindings ${key}.scope 必须是非空字符串数组，全部拒绝`);
	}
	const globs = (scope as string[]).map((g) => g.trim()).filter(Boolean);
	const allowTools = Array.isArray(config.allowTools)
		? (config.allowTools as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "")
		: [];
	return {
		globs,
		regexps: compile(globs),
		source: `extensionBindings ${key}`,
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

/** 找 bwrap：环境变量优先，否则常见路径。 */
function bwrapPath(): string | undefined {
	const fromEnv = process.env.PI_ALLOW_READS_BWRAP?.trim();
	if (fromEnv) return existsSync(fromEnv) ? fromEnv : undefined;
	for (const candidate of ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]) {
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
		// cwd 本身要可写：沙箱根是只读的，不绑的话 git 连索引都写不了，
		// 子代理任何落盘操作都会失败。cwd 落在 /tmp 下时也顺带解决
		// 沙箱的 tmpfs /tmp 把 cwd 挡住的问题。
		dirs.add(cwd);
		const worktreeRoot = findWorktreeRoot(cwd);
		if (worktreeRoot) dirs.add(worktreeRoot);
		// node_modules 也要可写：pnpm install 要写 .bin 里的 shim。它通常不在
		// scope 里，但装依赖是任务的必要步骤。worktree 里它是符号链接，要绑
		// 解析后的真实路径（bwrap 不能把符号链接当 bind 源）。
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
		const dir = resolve(homedir(), ".cache", "pi-allow-reads");
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
	const privateDir = `/tmp/.pi-allow-reads-${process.pid}`;
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

/** /allowed-reads 里显示 pnpm store：探测到的路径 + 一句「未放行」的提示。 */
function describePnpmStore(cwd: string): string {
	const found = detectPnpmStore(cwd);
	if (found.path) return `${found.path}（未放行；要让子代理装依赖就写进 bash.writablePaths）`;
	return `探测失败（${found.error ?? "未知原因"}）`;
}

function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** 把命令包进 bwrap：只读根、私有 /tmp、可选断网、可选把可写目录 bind 进去。 */
export function wrapInSandbox(command: string, cwd: string, rule: BashRule, policy: Policy, bwrap: string): string {
	const parts = [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
	if (!rule.network) parts.push("--unshare-net");
	for (const dir of sandboxWritableDirs(policy, cwd, rule)) parts.push("--bind", dir, dir);
	if (rule.gitExcludes && !process.env.GIT_CONFIG_COUNT) {
		const excludes = gitExcludesFile();
		if (excludes) parts.push("--bind", excludes, excludes);
	}
	for (const [key, value] of Object.entries(sandboxEnv(cwd, rule))) {
		parts.push("--setenv", key, value);
	}
	parts.push("--die-with-parent", "--chdir", cwd, "--", "bash", "-lc", command);
	return parts.map(shellQuote).join(" ");
}

function preview(globs: string[]): string {
	if (globs.length === 0) return "（空）";
	const shown = globs.slice(0, 12).join(", ");
	return globs.length > 12 ? `${shown} …` : shown;
}

export default function (pi: ExtensionAPI) {
	// bindings 在激活时定格：前台子代理的 bindings 环境变量只在会话启动前存在，
	// tool_call 里读不到，必须在这里取。
	const rawBindings = process.env[BINDINGS_ENV];
	const policy = bindingsPolicy(rawBindings) ?? INACTIVE;
	const probeCfg = parseProbeConfig(policy.probe);
	const denyCounter = new DenyCounter(policy.maxDenies);
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
	const probe =
		policy.active && probeCfg
			? new Probe({
				config: probeCfg,
				bashRule: policy.bash,
				readOnly: policy.readOnly,
				hooks: {
					abort: abortNow,
					warn: (text) => {
						const ui = currentCtx?.ui as { notify?: (m: string, t?: string) => void } | undefined;
						ui?.notify?.(`pi-allow-reads: ${text}`, "warning");
					},
				},
			})
			: undefined;

	// 绑定与方法约定（skill）一起提供给会话：扩展被加载，skill 就进系统提示的
	// 可用列表；父代理据此知道委派时传 extensionBindings。已上锁的会话不注册——
	// 它不委派，也不该去读一个自己被范围拦住的文件。
	pi.on("resources_discover", async () => (policy.active ? {} : { skillPaths: SKILL_DIRS }));

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		if (!policy.active) return;
		const budget = policy.maxReads > 0 ? `，read 预算 ${policy.maxReads} 次` : "";
		const bash = policy.bash
			? `，bash ${policy.bash.read.length} 读 / ${policy.bash.write.length} 写`
			: "，bash 关闭";
		const probeLine = probe ? "，探针开启" : "";
		const storeLine = policy.bash ? `，pnpm store ${detectPnpmStore(ctx.cwd ?? process.cwd()).path ?? "探测失败"}` : "";
		const mode = policy.readOnly ? "只读" : "读写";
		const msg = policy.globs.length
			? `任务范围生效（${policy.source}，${policy.globs.length} 条，${mode}${budget}${bash}${probeLine}${storeLine}）`
			: `任务范围为空，所有文件访问都被拒绝${budget}${bash}${probeLine}${storeLine}`;
		ctx.ui.notify(`pi-allow-reads: ${msg}`, "info");
	});

	pi.on("session_shutdown", async () => {
		probe?.dispose();
	});

	// 探针 3 需要看命令输出；tool_result 里拿。
	pi.on("tool_result", async (event) => {
		if (!probe) return;
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
					`pi-allow-reads: 本会话不允许执行 bash（来源：${policy.source}）。需要跑测试/typecheck 时由父代理在 bindings 里给 bash.read / bash.write 点名命令`,
				);
			}
			if (!command) return deny("pi-allow-reads: 空的 bash 命令");
			if (SHELL_META.test(command)) {
				return deny(
					`pi-allow-reads: bash 命令含 shell 元字符（; & | < > \` $ 等），只允许直接调用白名单命令：${preview(allEntries(rule))}`,
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
					`pi-allow-reads: bash 命令不在白名单内：${preview(allEntries(rule))}（来源：${policy.source}）${storeHint}`,
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
			const bwrap = bwrapPath();
			if (!bwrap) {
				return deny("pi-allow-reads: 找不到 bwrap，无法在沙箱内执行 bash（白名单命令也不会在没有沙箱的情况下放行）");
			}
			(event.input as { command?: string }).command = wrapInSandbox(command, cwd, rule, policy, bwrap);
			return undefined;
		}
		if (EXEC_TOOLS.includes(event.toolName)) {
			return bail(
				`pi-allow-reads: 本会话被限定在任务范围内（${preview(policy.globs)}），不允许执行 ${event.toolName}`,
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
				return bail(`pi-allow-reads: 已达 read 预算上限（${policy.maxReads} 次）`);
			}
			if (WRITE_TOOLS.includes(event.toolName)) {
				if (policy.readOnly) {
					return bail(`pi-allow-reads: 本会话只读，禁止 ${event.toolName}（来源：${policy.source}）`);
				}
				// 写操作没有 path 就无法判断目标：直接说清，不要报成「路径不在范围内」。
				// 这是用法错误不是权限错误，不计入撞权限计数。
				if (!raw) {
					return deny(
						`pi-allow-reads: ${event.toolName} 必须给 path（参数里没有 path，无法判断目标文件是否在任务范围内）。范围：${preview(policy.globs)}`,
					);
				}
			}
			if (!isAllowed(policy, cwd, target)) {
				// 缺 path 时目标其实是 cwd，说清这一点，免得被当成「子代理走错目录」。
				if (!raw) {
					// 缺 path：用法错误，不计入撞权限计数。
					return deny(
						`pi-allow-reads: 没有给 path，按当前目录（cwd：${cwd}）处理，而它不在任务范围内（来源：${policy.source}）。范围：${preview(policy.globs)}`,
					);
				}
				return bail(
					`pi-allow-reads: "${target}" 不在任务范围内（来源：${policy.source}）。范围：${preview(policy.globs)}`,
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
			`pi-allow-reads: 工具 ${event.toolName} 不在放行名单内，拒绝（fail closed；确需放行就在 extensionBindings 的 allowTools 里列出）`,
		);
	});

	pi.registerCommand("allowed-reads", {
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
				: ["未生效（本会话没有 pi-allow-reads 的 extensionBindings）"];
			ctx.ui.notify(`pi-allow-reads:\n${lines.join("\n")}`, "info");
		},
	});
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
