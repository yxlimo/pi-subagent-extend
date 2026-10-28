/**
 * pi-allow-reads — 把一个会话（主要是子代理）能碰的文件限制在任务范围内。
 *
 * 设计目标：父代理委派子代理时指定本次任务的文件/目录范围，子代理会话里
 * 范围之外的 tool_call 一律拒绝（fail closed），防止子代理漫无目的地扫仓库。
 *
 * 配置来源（优先级从高到低，命中即停）：
 * 1. pi-subagents 的 extensionBindings。父代理在 subagent 工具调用里传：
 *      extensionBindings: { "pi-allow-reads/1": { "scope": ["src/auth/**"], "maxReads": 20 } }
 *    pi-subagents 把它编码进 PI_SUBAGENT_EXTENSION_BINDINGS 传给子代理，本扩展在
 *    激活时（factory）一次性读取。前台子代理的这个环境变量只在会话启动前存在，
 *    之后父进程环境被恢复，所以不能在 tool_call 里懒读。
 * 2. 环境变量 PI_ALLOWED_FILES（逗号分隔 glob），可选 PI_MAX_READS。独立运行
 *    （pi -e）时用；此来源是只读语义。
 * 3. <cwd>/.pi/allowed-reads.txt（每行一个 glob，# 后为注释）。只读语义。
 *
 * 三者都未配置时扩展不生效：父会话和未绑定范围的子代理不受影响。
 *
 * 生效时的规则：
 * - read / edit / write / grep / find / ls：解析 path（缺省为 cwd），命中范围
 *   放行，否则拒绝；readOnly 时 edit / write 一律拒绝
 * - bash / powershell / codemode：一律拒绝（没有路径可判，能绕过范围）
 * - structured_output 与 allowTools 里列出的工具：放行（执行器类不可放行）
 * - 其余未知工具：拒绝
 *
 * 通配符：** 任意层目录；* 单层内任意字符；? 单个字符。纯路径 glob 额外匹配
 * 该目录自身与其下所有内容；"dir/**" 也匹配 "dir" 本身。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const BINDINGS_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";
const BINDING_NAMESPACE = "pi-allow-reads";
const ENVALLOWS = "PI_ALLOWED_FILES";
const ENVMAXREADS = "PI_MAX_READS";
const CONFIGFILE = ".pi/allowed-reads.txt";

const READ_TOOL = "read";
const PATH_TOOLS = ["read", "edit", "write", "grep", "find", "ls"];
const WRITE_TOOLS = ["edit", "write"];
const EXEC_TOOLS = ["bash", "powershell", "codemode"];
/** 不碰文件系统的会话级运行时工具，范围生效时照常放行。 */
const SAFE_TOOLS = ["structured_output"];

interface Policy {
	globs: string[];
	regexps: RegExp[];
	source: string;
	readOnly: boolean;
	maxReads: number;
	allowTools: string[];
	active: boolean;
}

const INACTIVE: Policy = {
	globs: [],
	regexps: [],
	source: "未配置",
	readOnly: true,
	maxReads: 0,
	allowTools: [],
	active: false,
};

/** 配置存在但无法使用时的策略：会话保持活跃，但什么都拿不到。 */
function denyAll(source: string): Policy {
	return { globs: [], regexps: [], source, readOnly: true, maxReads: 0, allowTools: [], active: true };
}

function globToRegExp(glob: string): RegExp {
	let re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	re = re
		.replace(/\*\*\//g, "(?:.*/)?")
		.replace(/\*\*/g, ".*")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]");
	return new RegExp(`^${re}$`);
}

/**
 * 展开目录语义后编译。"dir/**" 额外匹配 "dir" 本身；不含通配符的纯路径额外
 * 匹配 "dir/**"，所以范围写 "src" 就覆盖 src 及其下所有内容。
 */
function compile(globs: string[]): RegExp[] {
	const expanded = new Set<string>();
	for (const glob of globs) {
		expanded.add(glob);
		if (glob.endsWith("/**")) expanded.add(glob.slice(0, -3));
		else if (!/[*?]/.test(glob)) expanded.add(`${glob}/**`);
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
		active: true,
	};
}

/** 环境变量来源，只读语义。 */
function envPolicy(): Policy | undefined {
	const env = process.env[ENVALLOWS]?.trim();
	if (!env) return undefined;
	const globs = env.split(",").map((s) => s.trim()).filter(Boolean);
	return {
		globs,
		regexps: compile(globs),
		source: `${ENVALLOWS} 环境变量`,
		readOnly: true,
		maxReads: positiveInt(process.env[ENVMAXREADS]),
		allowTools: [],
		active: true,
	};
}

/** <cwd>/.pi/allowed-reads.txt 来源，只读语义；文件不存在则不生效。 */
function loadFilePolicy(cwd: string): Policy {
	try {
		const text = readFileSync(resolve(cwd, CONFIGFILE), "utf-8");
		const globs = text
			.split(/\r?\n/)
			.map((l) => l.replace(/#.*$/, "").trim())
			.filter(Boolean);
		return {
			globs,
			regexps: compile(globs),
			source: CONFIGFILE,
			readOnly: true,
			maxReads: positiveInt(process.env[ENVMAXREADS]),
			allowTools: [],
			active: true,
		};
	} catch {
		return INACTIVE;
	}
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

function preview(globs: string[]): string {
	if (globs.length === 0) return "（空）";
	const shown = globs.slice(0, 12).join(", ");
	return globs.length > 12 ? `${shown} …` : shown;
}

export default function (pi: ExtensionAPI) {
	// 绑定与环境变量在激活时定格：前台子代理的 bindings 环境变量只在会话启动前
	// 存在，tool_call 里读不到，必须在这里取。
	const staticPolicy = bindingsPolicy(process.env[BINDINGS_ENV]) ?? envPolicy();
	// 文件来源依赖会话 cwd，首次用到时再解析并缓存。
	let file: Policy | undefined;
	let fileResolved = false;
	const currentPolicy = (cwd: string): Policy => {
		if (staticPolicy) return staticPolicy;
		if (!fileResolved) {
			fileResolved = true;
			file = loadFilePolicy(cwd);
		}
		return file ?? INACTIVE;
	};
	let allowedReads = 0;

	pi.on("session_start", async (_event, ctx) => {
		const policy = currentPolicy(ctx.cwd ?? process.cwd());
		if (!policy.active) return;
		const budget = policy.maxReads > 0 ? `，read 预算 ${policy.maxReads} 次` : "";
		const mode = policy.readOnly ? "只读" : "读写";
		const msg = policy.globs.length
			? `任务范围生效（${policy.source}，${policy.globs.length} 条，${mode}${budget}）`
			: `任务范围为空，所有文件访问都被拒绝${budget}`;
		ctx.ui.notify(`pi-allow-reads: ${msg}`, "info");
	});

	pi.on("tool_call", async (event, ctx) => {
		const cwd = ctx.cwd ?? process.cwd();
		const policy = currentPolicy(cwd);
		if (!policy.active) return;
		const deny = (reason: string) => ({ block: true, reason } as const);

		if (EXEC_TOOLS.includes(event.toolName)) {
			return deny(
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
				return deny(`pi-allow-reads: 已达 read 预算上限（${policy.maxReads} 次）`);
			}
			if (WRITE_TOOLS.includes(event.toolName) && policy.readOnly) {
				return deny(`pi-allow-reads: 本会话只读，禁止 ${event.toolName}（来源：${policy.source}）`);
			}
			if (!isAllowed(policy, cwd, target)) {
				return deny(
					`pi-allow-reads: "${target}" 不在任务范围内（来源：${policy.source}）。范围：${preview(policy.globs)}`,
				);
			}
			if (event.toolName === READ_TOOL) allowedReads += 1;
			return undefined;
		}

		return deny(
			`pi-allow-reads: 工具 ${event.toolName} 不在放行名单内，拒绝（fail closed；确需放行就在 extensionBindings 的 allowTools 里列出）`,
		);
	});

	pi.registerCommand("allowed-reads", {
		description: "查看当前任务范围与 read 计数",
		handler: async (_args, ctx) => {
			const policy = currentPolicy(ctx.cwd ?? process.cwd());
			const lines = policy.active
				? [
					`来源: ${policy.source}`,
					`模式: ${policy.readOnly ? "只读" : "读写"}`,
					`已读 ${allowedReads}${policy.maxReads > 0 ? `/${policy.maxReads}` : ""} 次`,
					...policy.globs.map((g) => `  ${g}`),
				]
				: ["未生效（没有 extensionBindings、PI_ALLOWED_FILES 或 .pi/allowed-reads.txt）"];
			ctx.ui.notify(`pi-allow-reads:\n${lines.join("\n")}`, "info");
		},
	});
}
