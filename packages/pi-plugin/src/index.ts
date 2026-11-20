/**
 * pi-subagents-extend — 把一个会话（主要是子代理）能碰的文件限制在任务范围内。
 *
 * 设计目标：父代理委派子代理时指定本次任务的文件/目录范围，子代理会话里
 * 范围之外的 tool_call 一律拒绝（fail closed），防止子代理漫无目的地扫仓库。
 *
 * 配置有两条来源：
 * 1. pi-subagents 的 extensionBindings。父代理在 subagent 工具调用里传：
 *      extensionBindings: { "pi-subagents-extend/1": { "scope": ["src/auth/**"], "maxReads": 20 } }
 *    pi-subagents 把它编码进 PI_SUBAGENT_EXTENSION_BINDINGS 传给子代理，本扩展在
 *    激活时（factory）一次性读取。前台子代理的这个环境变量只在会话启动前存在，
 *    之后父进程环境被恢复，所以不能在 tool_call 里懒读。
 * 2. agent profile（src/profile.ts）：agent 定义里声明一份两行 loader，角色默认值
 *    写在项目 .pi/subagent-bindings.json。调用方的 bindings 按字段合并：白名单
 *    （bash.read / bash.write / allowTools）与 bash.deny 取并集、deny 不可放宽；
 *    scope / writeScope 替换（任务范围可以比角色默认更窄）；其余标量调用方优先。
 *    profile 是文件，按会话 cwd 读，所以在 session_start 解析。
 *
 * 两条都没有时扩展不生效：父会话和未绑定范围的子代理不受影响。
 *
 * 扩展还随包带一个用法 skill（../skills/pi-subagents-extend），经 resources_discover
 * 注册给会话：扩展加载到哪个会话，父代理侧就能看到「委派时如何传 bindings」的约定，
 * 不需要往 AGENTS.md 里写。
 *
 * 生效时的规则：
 * - read / edit / write / grep / find / ls：解析 path（缺省为 cwd），命中范围
 *   放行，否则拒绝；readOnly 时 edit / write 一律拒绝（走写预算，出路是回报告）
 * - bash：默认拒绝。bindings 里写 bash.allow（命令前缀白名单，如 "pnpm run typecheck"）
 *   后，只有命中白名单的命令放行，并且改写成交给沙箱 helper 执行：读写范围由
 *   Landlock 强制（内核 ABI 7 起），网络默认断（bash.network 可开）：断网时连
 *   UDP/DNS 一起断，靠私有网络命名空间 + 盖掉解析器套接字；可写面只有写范围覆盖到的路径
 *   （bash.writable 时）、git 真正要写的目录与 bash.writablePaths，防止用 shell 绕过范围去改文件
 *   读面不收紧（工具链在 /nix/store，收窄读根会打死所有命令）；只读类命令另加一条路径引导：
 *   参数里看起来像路径的 token 按真实路径判，落在范围外就被点名拒绝，并指回去用 read 工具
 * - powershell / codemode：一律拒绝（没有路径可判，能绕过范围）
 * - structured_output 与 allowTools 里列出的工具：放行（执行器类不可放行）
 * - 其余未知工具：拒绝
 *
 * 通配符：** 任意层目录；* 单层内任意字符；? 单个字符。纯路径 glob 额外匹配
 * 该目录自身与其下所有内容；"dir/**" 也匹配 "dir" 本身。
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, type Dirent } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { allEntries, classifyCommand, commandAccess, commandMatches, commandNeedsNoManifest, deniedEntry, deniedEnvAssignment, firstToken, isUnknownProgram, leadingAssignments, listedJoin, MAX_LISTED, mergeBashConfig, parseBashRule, pathCandidates, requiresNetwork, stringList, unreachableEntries, type BashRule, type UnreachableEntry } from "./bash-match.ts";
import { DenyCounter } from "./deny-count.ts";
import { handoffHintFor, withHint } from "./handoff-hint.ts";
import { cpuStallNote, networkFailureNote, writeRefusalNote } from "./sandbox-note.ts";
import { Probe, STOP_NOTICE, parseProbeConfig } from "./probe.ts";
import { shouldDefaultWorktree, WORKTREE_TOOLS } from "./worktree-default.ts";
import { BINDING_NAMESPACE, bindingKey, agentMdDirs, parseRoleName, resolveRoleFromPrompt, resolveAgentFile, readExtendBlock, policyFromBlock, outputFromBlock, setupFromBlock, worktreeFromBlock, type RolePolicy } from "./role-config.ts";
import { deliverableTarget, ensureDeliverableLink, mainRepoRoot } from "./deliverable.ts";

const BINDINGS_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";
/** agent 角色默认 bindings 的默认位置（相对会话 cwd）。 */
const PROFILE_FILE = ".pi/subagent-bindings.json";

/** Phase 3 output.deliverable: the real file in the main checkout, for write grants and refusals. */
let deliverableTargetPath: string | undefined;
const DELIVERABLE_SECTION = "pi_subagents_extend_deliverable";
/**
 * 随包发布的用法 skill 目录，经 resources_discover 注册，扩展加载即生效。
 * 三个：范围与 bash 白名单、探针判据与停机语义、上下文隔离（AGENTS.md 标记与主代理专属文件）。
 */
const SKILL_DIRS = ["pi-subagents-extend", "pi-subagents-extend-probes", "pi-subagents-extend-context"].map((name) =>
	fileURLToPath(new URL(`../skills/${name}`, import.meta.url)),
);

const READ_TOOL = "read";
/**
 * 已知路径类工具的访问类别：读认读范围，写认写范围。
 *
 * 名字只是**默认值**，不是判据的全部。目标路径从工具自己的入参 schema 里取（见
 * `pathArgOf`），父代理还能用 bindings.tools 覆盖。名字表之所以省不掉，是因为
 * 「这个工具会不会改文件」推不出来，必须有人声明。
 *
 * 为什么必须收录 hashline 那一套：pi-hashline-edit-pro 把内置 `edit` 从活动工具集里
 * 删掉（它自己 `setActiveTools(active.filter(t => t !== "edit"))`），换上一组以行锚点
 * 定位的编辑工具。只认 `edit` / `write` 的名单在这种宿主上会把整套编辑能力判成
 * 「未知工具」而拒绝——子代理一个改文件的工具都拿不到。
 */
const DEFAULT_TOOL_ACCESS: Record<string, "read" | "write"> = {
	read: "read",
	grep: "read",
	find: "read",
	ls: "read",
	outline: "read",
	edit: "write",
	write: "write",
	replace: "write",
	replace_match: "write",
	insert: "write",
	copy: "write",
	move: "write",
	undo_last_change: "write",
};
/**
 * 双文件工具的源文件按什么判。`copy` 只读源（源可以只读），`move` 从源里删（源必须可写）。
 * 没在这张表里的双文件工具按 `write` 判 —— 拿不准就往严里判，这是本层的既有取向。
 */
const DEFAULT_TRANSFER_SOURCE: Record<string, "read" | "write"> = {
	copy: "read",
	move: "write",
};

const EXEC_TOOLS = ["bash", "powershell", "codemode"];
/**
 * 不碰文件系统的会话级运行时工具，范围生效时照常放行。
 * contact_supervisor / intercom 是子代理向父代理（监督者）转告的正当通道——探针的
 * 停机判据本来就要它立刻上报，封锁它只会把信息憋在死掉的会话里。
 */
const SAFE_TOOLS = ["structured_output", "contact_supervisor", "intercom"];

/**
 * 命令里是否有**未加引号**的 shell 控制字符。
 *
 * 命令最终以 `bash -lc <command>` 执行，所以引号语义就是 bash 的语义：
 * 单引号内一切惰性；双引号内只有 `$`、反引号、反斜杠仍会展开，`; & | < > ( )`
 * 都是普通字符。之前是纯文本正则匹配，于是 `python3 -c "print(1)"` 这种引号内的
 * 括号也被拒——dogfooding 时一个子代理因此无法自验 YAML。
 *
 * 不进引号的正斜杠也一律拒；引号闭合不对（子代理手写错）也拒，交给它重写。
 */
export function hasUnquotedShellControl(command: string): boolean {
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < command.length; i += 1) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === '"') {
			// 双引号内反斜杠仍会转义，跳过后一个字符（保守：当成惰性）
			if (ch === "\\") {
				i += 1;
				continue;
			}
			if (ch === '"') {
				quote = undefined;
				continue;
			}
			if (ch === "$" || ch === "`") return true;
			continue;
		}
		if (ch === "'") {
			quote = "'";
			continue;
		}
		if (ch === '"') {
			quote = '"';
			continue;
		}
		if (ch === "\\" || ch === "\n" || ch === "\r") return true;
		if (";&|<>()`$".includes(ch)) return true;
	}
	// 引号没闭合：命令本身是坏的，直接拒
	return quote !== undefined;
}

/**
 * 一个工具的类别声明。
 *
 * `access` 缺省时沿用 `DEFAULT_TOOL_ACCESS` 里按名字给的值；`path` 缺省时从工具自己的
 * 入参 schema 里找（`pathArgFromSchema`），找不到就当 `path`。
 */
interface ToolDeclaration {
	access?: "read" | "write";
	path?: string | false;
	/** 双文件工具（copy/move）的源文件按读还是按写判；缺省见 `DEFAULT_TRANSFER_SOURCE`。 */
	transferSource?: "read" | "write";
}

/**
 * 解析 bindings.tools：名字 → 类别覆盖。
 *
 * 写坏就整份绑定作废（fail closed），与 scope / writeScope 的处理一致：一个说不清工具
 * 类别的会话没办法安全地放行任何工具。
 */
function parseToolDeclarations(value: unknown): {
	declarations: Record<string, ToolDeclaration>;
	error?: string;
} {
	// 工具名来自外部输入：用无原型对象，避免 "__proto__" 这类键改写原型链。
	const declarations: Record<string, ToolDeclaration> = Object.create(null);
	if (value === undefined) return { declarations };
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { declarations, error: "tools must be an object of { toolName: { access, path } }" };
	}
	for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return { declarations, error: `tools.${name} must be an object` };
		}
		const entry = raw as { access?: unknown; path?: unknown; transferSource?: unknown };
		if (entry.access !== undefined && entry.access !== "read" && entry.access !== "write") {
			return { declarations, error: `tools.${name}.access must be "read" or "write"` };
		}
		if (
			entry.path !== undefined &&
			entry.path !== false &&
			(typeof entry.path !== "string" || entry.path.trim() === "")
		) {
			return { declarations, error: `tools.${name}.path must be a non-empty string or false` };
		}
		if (
			entry.transferSource !== undefined &&
			entry.transferSource !== "read" &&
			entry.transferSource !== "write"
		) {
			return { declarations, error: `tools.${name}.transferSource must be "read" or "write"` };
		}
		const declaration: ToolDeclaration = {};
		if (entry.access !== undefined) declaration.access = entry.access;
		if (entry.path !== undefined) {
			declaration.path = entry.path === false ? false : (entry.path as string).trim();
		}
		if (entry.transferSource !== undefined) declaration.transferSource = entry.transferSource;
		declarations[name] = declaration;
	}
	return { declarations };
}

interface Policy {
	globs: string[];
	regexps: RegExp[];
	/** 写范围（edit / write 工具）。没配 writeScope 时等于读范围；readOnly 时为空。 */
	writeGlobs: string[];
	/**
	 * writeScope 里写绝对路径的那几条，已 realpath，按前缀比对。
	 *
	 * 相对授权绑在项目树上（`matches` 里「落在工作树之外一律不认」是软链逃逸的唯一防线），
	 * 但「把报告写到某个文件」本来就是树外的事。绝对路径是父代理明确点名的授权，不是子代理
	 * 能自己构造的逃逸，所以单独放行；相对授权的老规则一点不动。
	 */
	absoluteWrite: string[];
	writeRegexps: RegExp[];
	source: string;
	readOnly: boolean;
	maxReads: number;
	allowTools: string[];
	/**
	 * 父代理对工具类别的显式声明，覆盖 `DEFAULT_TOOL_ACCESS`。
	 *
	 * `path: false` 表示这个工具没有可判的路径入参——写类工具这样声明等于「永远拒绝」，
	 * 因为拿不到目标就没有任何授权能覆盖它。
	 */
	tools: Record<string, ToolDeclaration>;
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
	absoluteWrite: [],
	writeRegexps: [],
	source: "not configured",
	readOnly: true,
	maxReads: 0,
	allowTools: [],
	tools: {},
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
		absoluteWrite: [],
		writeRegexps: [],
		source,
		readOnly: true,
		maxReads: 0,
		allowTools: [],
		tools: {},
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
 * scope 写法归一，`compile` 与沙箱可写面共用一份，免得两处对同一个 glob 的理解
 * 慢慢分叉。两件事：
 * - 尾斜杠只是目录写法，去掉后再展开，否则 "dir/" 会变成 "dir//**"。
 * - "." 和 "./" 表示整棵树。不归一的话会编译成 ^\.$ / ^\./.*$，而 matches 比的是
 *   相对路径 —— 仓库根的相对路径是空串、子文件是 "src/a.ts"，两条都命中不了，
 *   于是 scope: ["."]（文档里的「读全仓」写法）什么也授权不了。开头的 "./" 同理
 *   要去掉："." 归一成 "**"（整棵树），"./src" 归一成 "src"。
 */
function normalizeGlob(glob: string): string {
	const raw = glob.length > 1 ? glob.replace(/\/+$/, "") || "/" : glob;
	return raw === "." ? "**" : raw.replace(/^\.\//, "");
}

/**
 * 展开目录语义后编译。"dir/**" 额外匹配 "dir" 本身；不含通配符的纯路径额外
 * 匹配 "dir/**"，所以范围写 "src" 就覆盖 src 及其下所有内容。
 */
function compile(globs: string[]): RegExp[] {
	const expanded = new Set<string>();
	for (const glob of globs) {
		const g = normalizeGlob(glob);
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

/** 从 PI_SUBAGENT_EXTENSION_BINDINGS 里取本扩展的 namespace 配置对象；版本不匹配一律拒绝。 */
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
	const prefix = `${BINDING_NAMESPACE}/`;
	const keys = Object.keys(record).filter((key) => key.startsWith(prefix));
	// 绑定是给别的扩展的，本扩展不参与。
	if (keys.length === 0) return {};
	if (keys.length > 1) {
		return { error: `ambiguous: more than one ${BINDING_NAMESPACE}/* namespace; everything is refused` };
	}
	const key = keys[0];
	if (key !== bindingKey()) {
		return { error: `this build supports ${bindingKey()}, got ${key}; everything is refused` };
	}
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

/**
 * 合并两层配置（profile 层是 `default` → 角色，派单层是合成结果 → 本次 bindings）。
 *
 * 三层是 `default` → 角色 → 派单，方向只有一个：每一层默认在上一层之上**追加**。
 * `default` 是所有角色的地板（角色继承它），派单继承角色的结果；要收窄就写 `reset: true`。
 * 写反了（让上层只能替换）就会得到「角色不能比 default 窄」或「派单不能比角色窄」。
 *
 * 语义按字段区分，不是一层盖住另一层：
 * - 并集（调用方只能往上加，不能悄悄删掉底层已放行的）：`bash.read` / `bash.write`、
 *   `allowTools`。`bash.deny` 也是并集，且是硬底线 —— 任何一层都拆不掉它。
 * - 替换：`scope`、`writeScope`。任务范围必须能比角色默认更窄；并集会把文件访问放大，
 *   方向是错的。
 * - 显式空列表：`bash.read: []` 这类写了空数组 = 该列就是空（清空底层那份），与「没写」不同。
 *   两者都当「加零条」的后果是：派单写 `read: []` + `write: []` 想禁用 bash，profile 的整列
 *   授权却原样留着。
 * - 其余标量调用方优先：`readOnly`、`maxDenies`、`maxWriteDenies`、`maxReads` 等。
 * - `readOnly: true` 且这一层没写 `writeScope`：结果里 `writeScope` 就是空 —— 只读意图不能被
 *   底层那份 `writeScope` 抵消；这一层同时写了 `writeScope` 才算「只读 + 这一个文件」。
 * - `bash` 内部逐字段合并，见 `mergeBashConfig`。
 * - `reset: true`：这一层「只给这些」，bash 白名单与 `allowTools` 都从这一层重新开始；
 *   `bash.deny` 不清（禁令不随白名单一起丢），`scope` / `writeScope` 本来就是替换。
 *   只写在 `bash` 里的 `reset` 仍然只管 bash 白名单。
 *
 * 整块覆盖 `bash` 的旧做法有个实测后果：profile 的 coder 有 27 条白名单，派单只写一条
 * `bash.read`，那 27 条就整块消失 —— 「想加一条授权」被迫变成「把全部重抄一遍」，
 * 派单反而不能放宽权限。
 */
export function mergeConfig(
	base: Record<string, unknown> | undefined,
	over: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!base) return over;
	if (!over) return base;
	const merged: Record<string, unknown> = { ...base, ...over };
	// `reset: true` 是这一层的「只给这些」：它控制合并本身，不是给 parseBashRule /
	// parsePolicyObject 的字段，所以不进结果。
	const reset = over.reset === true;
	delete merged.reset;
	// allowTools：默认并集（底层已经放行的工具不会因为这次派单而消失）；reset 时只认这一层。
	const allowTools = reset
		? stringList(over.allowTools)
		: [...new Set([...stringList(base.allowTools), ...stringList(over.allowTools)])];
	if (allowTools.length > 0 || reset) merged.allowTools = allowTools;
	// 这一层写 `readOnly: true` 却没写 `writeScope`：写范围就是空。否则底层那份 writeScope
	// （review 的报告目录正是这个形状）会把这一层的只读意图抵消掉 —— 两条相反的指令同时生效。
	if (over.readOnly === true && !Object.hasOwn(over, "writeScope")) merged.writeScope = [];
	// 这一层把 bash 写坏了（存在但不是对象）：结果是 bash 被禁，而不是底层的整份 bash 照常下发。
	// 老语义下「写坏」等于「整块替换」，换成本就是空的，于是 bash 关闭；逐字段合并把这份错误
	// 掩盖成了「可用」，正是 profilePolicy 注释里说的那种掩盖。
	if (Object.hasOwn(over, "bash") && over.bash !== undefined && asObject(over.bash) === undefined) {
		delete merged.bash;
		return merged;
	}
	// bash 逐字段合并，不整块覆盖。
	const bash = mergeBashConfig(base.bash, over.bash, reset);
	if (bash) merged.bash = bash;
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
 *   readOnly → 默认等价于空写范围；但**同一层写的 writeScope 优先**，这样「只读会话 + 一个
 *              报告文件」是能表达的，而不是非黑即白。派单只写 readOnly 时不写 writeScope，
 *              `mergeConfig` 已把合并结果里的 writeScope 清成空集，底层 profile 的那份压不过它；
 *   写了 → 只认这一份，写超出即拒，读不受影响。
 */
function parseWriteScope(
	config: Record<string, unknown>,
	globs: string[],
	readOnly: boolean,
	source: string,
): { writeGlobs?: string[]; error?: string } {
	if (readOnly && config.writeScope === undefined) return { writeGlobs: [] };
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
	const toolDeclarations = parseToolDeclarations(config.tools);
	if (toolDeclarations.error)
		return denyAll(`${source}.${toolDeclarations.error}; everything is refused`);
	const allWrite = write.writeGlobs as string[];
	const absoluteWrite = allWrite.filter((g) => isAbsolute(g)).map((g) => canonical(g));
	const writeGlobs = allWrite.filter((g) => !isAbsolute(g));
	const allowTools = Array.isArray(config.allowTools)
		? (config.allowTools as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "")
		: [];
	return {
		globs,
		regexps: compile(globs),
		writeGlobs,
		absoluteWrite,
		writeRegexps: compile(writeGlobs),
		source,
		readOnly,
		maxReads: positiveInt(config.maxReads),
		allowTools,
		tools: toolDeclarations.declarations,
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
 * 绝对授权（writeScope 里的绝对路径）按前缀比对，允许落在树外。
 *
 * 只给写用：读范围继续绑定在项目树上。绝对路径是父代理点名的，子代理无法自己构造，
 * 所以它不破坏「相对授权不能出树」那条防线。
 */
function underAny(grants: string[], cwd: string, target: string): boolean {
	if (grants.length === 0) return false;
	const abs = canonical(resolve(cwd, target));
	for (const grant of grants) {
		if (abs === grant) return true;
		if (abs.startsWith(grant.endsWith(sep) ? grant : `${grant}${sep}`)) return true;
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

function helperPath(): string | undefined {
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
function bashBlocker(helper: string | undefined): string | undefined {
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

/**
 * 目标落在 base 树内就返回它的相对路径，否则 undefined。软链按真实路径判：Landlock
 * 只授权目标 inode，收了指到树外的软链等于把树外那个文件也开了。
 */
function insideTree(base: string, abs: string): string | undefined {
	const rel = relative(base, canonical(abs));
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
	return rel;
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
function dependencyGateVerdict(
	rule: { dependencyGate: string[] | false },
	command: string,
	access: "read" | "write",
	cwd: string,
): string | undefined {
	if (rule.dependencyGate === false || !dependencyGateApplies(command, access)) return undefined;
	return dependencyGateReason(cwd, rule.dependencyGate);
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

/**
 * helper 里的 `PRIVATE_TMP`：spec 不写 `tmp` 时它把私有 tmpfs 挂在这里。
 * 扩展的 XDG_RUNTIME_DIR / MISE_STATE_DIR 也指在它下面，所以这个路径两边必须同一个。
 */
const CONVENTIONAL_TMP = "/tmp";

/**
 * 命令自己用的临时目录：宿主的 TMPDIR（os.tmpdir() 认它），或 bash.env 里钉住的那一个。
 *
 * 它必须和 helper 挂私有 tmpfs 的目录是**同一个**：只授权、不挂载的目录，写下来落在宿主上，
 * 不是落在沙箱里。所以它既写进 spec 的 `tmp`，也被下面的 `write` 引用，两处不再各说各话。
 */
function scratchDir(cwd: string, rule: BashRule): string {
	const pinned = rule.env.TMPDIR?.trim();
	// expandPath 对空串返回 undefined，这里已经排除了空串，剩下的只是类型上的可能。
	const wanted = ((pinned ? expandPath(cwd, pinned) : tmpdir()) ?? "").replace(/\/+$/, "") || "/";
	// 根目录不能当挂载点（会盖掉整棵树），不存在的目录既挂不上、Landlock 也会拒绝整个 spec。
	// 这两种情况退回 /tmp：它对 helper 是既有默认值，不会因为一个坏掉的 TMPDIR 让 bash 全灭。
	return wanted !== "/" && existsSync(wanted) ? wanted : CONVENTIONAL_TMP;
}

/** 这次命令的 spec；`writeRefusalNote` 要拿它的 `write` 判断越界写。 */
/**
 * 会被私有 tmpfs 盖住的目录，与 helper 的 `privatised_dirs` 同一定义：约定 `/tmp` 恒在内，
 * 外加 spec 的 `tmp`（scratch）；但 cwd 落在其中时 helper 不挂（否则会盖掉工作目录）。
 */
export function privatisedDirs(cwd: string, scratch: string): string[] {
	return [...new Set([CONVENTIONAL_TMP, scratch])]
		.map((dir) => dir.replace(/\/+$/, "") || "/")
		.filter((dir) => dir !== "/" && dir !== "." && !(cwd === dir || cwd.startsWith(`${dir}/`)));
}

/**
 * 只读类 bash 命令的参数路径可以指向、且无需再解释的系统目录：设备与系统信息，不是工具。
 *
 * 沙箱的读面仍是 `/`：node、rg、cargo 全在 /nix/store，收窄读根会一次打死所有命令。所以这一层
 * 不判「能不能读」，只在插件层把参数里的路径引到任务范围上 —— 引导，不是墙。
 *
 * 刻意**不**含 /nix/store、/usr、/bin、/sbin、/lib、/lib64：工具住在这些目录里，不代表命令的参数
 * 会包含它们 —— 程序位由 bash 经 PATH 解析，根本不进参数表（见 bash-match 的 `pathCandidates`）。
 * 参数里真的出现 store 或系统二进制目录，就是子代理在工具链里翻东西，正是要把路径引回范围的场景
 * （实测：一个子代理在 258MB 的包体里 rg 了 140 次，全部为空）。
 */
const BASH_READ_EXEMPT_ROOTS = ["/etc", "/proc", "/dev", "/sys"];

/** `path` 是否在 `root` 之下。按路径边界比，`/etc` 不覆盖 `/etc-other`。 */
function underRoot(root: string, path: string): boolean {
	if (path === root) return true;
	return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * 一条只读类命令的参数路径是否可放行。任一条成立即放行：在工作树内 / 在设备与系统信息豁免集内 /
 * 在 cwd 或私有 scratch 之下 / 是沙箱默认可写的设备。
 *
 * 方向是宁可漏放：漏放只是少一次引导，误拒会让一条本来能跑的命令死在插件层，而子代理多半把它读成
 * 「这台机器坏了」，然后换一百个写法再试。
 *
 * 下面 `expandPath` 那道守卫（返回 undefined 即放行）是防御性代码，当前**不可达**：候选由
 * `pathCandidates` 产出，必含斜杠因而非空，而 `expandPath` 只在空串时返回 undefined。
 */
function bashPathArgAllowed(token: string, cwd: string, rule: BashRule, policy: Policy): boolean {
	const expanded = expandPath(cwd, token);
	if (!expanded) return true;
	// 范围判定内部已经按真实路径比过软链，传绝对路径进去不影响它的语义。
	if (matches(policy.regexps, cwd, expanded)) return true;
	// 豁免集要按字面与真实两种形态各比一次：有些系统上 /etc 自己就是软链（macOS 上是 /private/etc），
	// 只比一种会让同一个路径有时豁免、有时不豁免。
	//
	// 真实路径用 `resolveComparable` 而不是 `canonical`：前者是与 helper 的 `fs::canonicalize` 对齐的
	// 实现（OS 的 realpath + 字面拼尾），后者是 Node 的自实现版，两边在部分输入上结果不同。
	const real = resolveComparable(expanded);
	if (BASH_READ_EXEMPT_ROOTS.some((root) => underRoot(root, expanded) || underRoot(root, real))) return true;
	if (underRoot(resolveComparable(cwd), real)) return true;
	// scratch 用 privatisedDirs：cwd 落在 /tmp 之下时 helper 并不挂那个 tmpfs，那就不算
	// 「命令自己的临时目录」，免得 /tmp 顺带把整片宿主机路径放进来。
	for (const dir of privatisedDirs(cwd, scratchDir(cwd, rule))) {
		if (underRoot(resolveComparable(dir), real)) return true;
	}
	return SANDBOX_DEVICE_PATHS.some((device) => underRoot(device, real));
}

/**
 * 只读类命令里第一个指向范围之外的路径参数；没有就返回 undefined。
 *
 * 只看读类命令：写类命令的文件面由 Landlock 与写范围管，而这里判的是「它在读什么」。候选的抽取
 * 在 bash-match 里（纯字符串），放行判定留在这里，因为豁免集、scratch 与 `resolveComparable` 都在这边。
 */
function foreignBashPath(command: string, cwd: string, rule: BashRule, policy: Policy): string | undefined {
	return pathCandidates(command).find((token) => !bashPathArgAllowed(token, cwd, rule, policy));
}

/**
 * 把路径解析到「可比形态」，与 helper 的 `resolve_comparable` 对齐：对最深的**已存在**祖先做
 * realpath，再把不存在的尾巴原样接回去。两边都用 OS 的 realpath（Node 用 `.native`）并原样拼尾巴，
 * 因此对存在的路径与「祖先软链 + 缺失尾巴」两类结果逐字节一致。
 *
 * 整体 realpath 在这里用不了：授权指向的路径可能还不存在（命令本来就要创建它），而挂载之后它更
 * 是不存在。软链必须先解析，否则「经软链指向 /tmp/x 的授权」在插件侧看着不在 /tmp 之下，helper 却
 * 解析成 /tmp/x 把整份 spec 拒掉 —— 那正是这套逻辑要避免的「一条命令都跑不了」。
 */
export function resolveComparable(path: string): string {
	const tail: string[] = [];
	let current = path;
	for (;;) {
		try {
			// `realpathSync.native` 而不是 `realpathSync`：helper 用的是 Rust 的 `fs::canonicalize`，
			// 它落到 OS 的 realpath(3)，而 Node 的 `realpathSync` 是自实现版本，两者在部分输入上结果不同。
			// 尾巴用字面拼接而不是 `resolve`：`resolve` 会把 `..` 归一化，Rust 那边是原样 push 进去的，
			// 归一化会让「授权路径还没创建」这一类判断与 helper 不一致。
			const base = realpathSync.native(current);
			return tail.length === 0 ? base : `${base.replace(/\/+$/, "")}/${tail.join("/")}`;
		} catch {
			const parent = dirname(current);
			if (parent === current) return path;
			tail.unshift(basename(current));
			current = parent;
		}
	}
}

/**
 * 剔掉「拿到手也用不上」的写授权。
 *
 * helper 在私有化的目录上挂 tmpfs 之后，落在其**下**的授权路径从它的视图里消失，于是它拒掉整份
 * spec（exit 77），bash 全灭。授权那个目录**本身**仍然有效（挂载点还在），所以只剔严格在下的。
 *
 * 两边都按 `resolveComparable` 解析，否则软链会造成两种错判：插件保留而 helper 拒（bash 全灭），
 * 或插件剔掉而 helper 本来会接受（白白丢掉一条能用的授权）。
 *
 * 同时也把剔掉的交回去：静默丢弃会让子代理反复撞「写不进去」而不知道为什么。
 */
export function dropHiddenGrants(
	write: string[],
	cwd: string,
	scratch: string,
): { kept: string[]; dropped: string[] } {
	const dirs = privatisedDirs(cwd, scratch).map(resolveComparable);
	const kept: string[] = [];
	const dropped: string[] = [];
	for (const path of write) {
		const resolved = resolveComparable(path);
		if (dirs.some((dir) => resolved !== dir && resolved.startsWith(`${dir}/`))) dropped.push(path);
		else kept.push(path);
	}
	return { kept, dropped };
}

/** 已提示过的被剔授权：每条命令一份 spec，不记下来就会每调一次重复提示一次。 */
const reportedHiddenGrants = new Set<string>();
/** worktree 默认值依赖的 profile 文件：确认未被 git 跟踪的只提示一次（session_start 清空）。 */
const reportedUntrackedWorktreeProfiles = new Set<string>();
/** 迁移告警：legacy bash.read / bash.write 只说一次（session_start 清空）。 */
const warnedLegacyBashColumns = new Set<string>();
/**
 * UI 提示通道，由 `judgeToolCall` 绑定的会话上下文注入：模块级函数拿不到 `ctx`，而这条告警是给
 * 父代理看的配置问题，不该写进模型上下文，所以只走 UI。
 */
let uiWarning: ((message: string) => void) | undefined;

/**
 * 把「授权落在私有 tmpfs 之下、已被剔掉」这件事告诉父代理一次。
 *
 * 不提示的话，子代理只会看到自己的写被 Landlock 拒掉，而真正的原因在配置里：那个目录每次调用都
 * 被挂上一个空的 tmpfs。提示走 UI，不进模型上下文 —— 这是给父代理看的配置告警，不是给子代理的
 * 行动指令（子代理那边已经有「拿报告代替写文件」的既定退路）。
 */
function reportHiddenGrants(dropped: string[]): void {
	const fresh = dropped.filter((path) => !reportedHiddenGrants.has(path));
	if (fresh.length === 0) return;
	for (const path of fresh) reportedHiddenGrants.add(path);
	uiWarning?.(
		`pi-subagents-extend: write grant(s) dropped: the sandbox mounts a private tmpfs over that path when it can, and a grant below a mount point is hidden inside it: ${fresh.join(", ")}. Write the file with the write tool, or point bash.env.TMPDIR outside /tmp.`
	);
}

/** 沙箱注解的前缀：与 `sandbox-note.ts` 里的注解同一个标记。 */
const SANDBOX_MARK = "[sandbox]";

/**
 * 「没有候选包带这个脚本」这一句：告警和工具结果共用，措辞只能有一份。
 *
 * 分成两处各写一遍，两边的措辞就会慢慢分开（一边大写、一边小写就够让读者以为是两件
 * 不同的事），而这条消息的全部价值就在于它说的是一件确定的事。
 */
function scriptMissingClause(script: string): string {
	return `no candidate has a \`${script}\` script`;
}

/** 同一句话放在句首时用这个：只动首字母，措辞不另写一份。 */
function sentenceCase(text: string): string {
	return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** 候选超过上限时的补充说明；没被截断时不给。 */
function truncationNote(list: string[]): string {
	return list.length > MAX_LISTED ? ` (only the first ${MAX_LISTED} are listed)` : "";
}

/**
 * 候选提示：给不出可靠改法时，把候选列出来让父代理挑。
 *
 * 多个包时「这条授权原本指哪个包」只有父代理知道：随便挑一个再给一条 `--dir`
 * 建议，会把命令指到别的包上。
 *
 * `scriptMissing` 有值时不许再写「挑一个」：那个包里连脚本都没有，挑它跑出来是
 * "Command not found"，改包目录治不好这件事。说清「没有候选带这个脚本」才是真事实。
 * 候选超过上限时截断（见 `listedJoin`），并用 `truncationNote` 说一句「没列全」：
 * 几百个包路径拼进一条告警没人读得完，但让人去挑看不见的那几个同样不行。
 */

function candidateHint(item: UnreachableEntry): string {
	if (item.fix) return "";
	if (item.scriptMissing) return `; ${scriptMissingClause(item.scriptMissing)}`;
	const list = item.candidates ?? [];
	if (!list.length) return "";
	return `; candidates: ${listedJoin(list)} — pick the one this entry meant${truncationNote(list)}`;
}

/**
 * 注解里「那该怎么办」的那一句。四种事实各说各的，不含糊：
 *
 * - 有可靠改法（恰好一个候选、且它有这个脚本）→ 直接给改法；
 * - 一个候选但缺脚本 → 说清「没有候选带这个脚本」，别再让人去挑；
 * - 多个候选 → 列出来让父代理挑（它才知道这条授权原本指谁）；
 * - 连候选都没有 → 只能由父代理指明一个带 manifest 的目录。
 *
 * 顺序不能换：`scriptMissing` 一定同时有 `candidates`，先判候选就会把「脚本不存在」
 * 说成「包选错了」，而改包目录治不好后者。
 */
function remedyFor(item: UnreachableEntry): string {
	if (item.fix) return `Use ${item.fix} instead.`;
	if (item.scriptMissing) return `${sentenceCase(scriptMissingClause(item.scriptMissing))}.`;
	if (item.candidates && item.candidates.length) {
		return `Candidates: ${listedJoin(item.candidates)} — pick the one this entry meant${truncationNote(item.candidates)}.`;
	}
	return "The parent has to point this entry at a directory that has the manifest.";
}

/**
 * 「命令被放行了，但它在 cwd 下跑不起来」的注解。
 *
 * 白名单里的命令进了沙箱，包管理器自己报 "No package.json found"：子代理只看到那句
 * 原始报错，看不出这是配置问题（授权指向的地方没有 manifest）。这条注解把原因与改法
 * 写进工具结果，父代理与子代理在同一条消息里看到。
 *
 * 只在失败时补：成功的输出里混一句「跑不起来」会误导。
 */
function unreachableCommandNote(text: string, command: string, rule: BashRule, cwd: string): string | undefined {
	if (text.includes(SANDBOX_MARK)) return undefined;
	// 别在这里再推一遍匹配：直接问 allowlist「是**哪一条**放行这条命令的」，再查那一条是否
	// 不可达。自己匹配会出错，而且已经错过两次：按首 token 比，会让同程序名的无关条目被点名；
	// 在不可达子集里按 `allEntries` 顺序取第一条命中，会让一条**比命令更短**的宽条目（`pnpm`）
	// 顶替真正放行它的那条。`classifyCommand` 用的是判定本身的规则（write 列优先、第一条命中），
	// 所以它给的答案就是唯一的答案。
	// 命令**自己**不需要 manifest 时，一句都不要说：宽条目 `pnpm` 会被判成不可达，但它放行的
	// `pnpm --version` / `pnpm store path` / `pnpm --dir x run build` 跟 cwd 有没有 manifest
	// 无关，失败原因是别的东西。把原因安到不成立的前提上，比不说更糟。
	if (commandNeedsNoManifest(command)) return undefined;
	const granted = classifyCommand(rule, command);
	const bad = granted === undefined ? undefined : unreachableEntries([granted.entry], cwd)[0];
	if (!bad) return undefined;
	const remedy = remedyFor(bad);
	return `${SANDBOX_MARK} this command ran, but "${bad.entry}" cannot work from ${bad.lookedIn ?? cwd}: ${bad.why}. ${remedy}`;
}

/**
 * 把「授权写了却永远命中不了」这件事告诉父代理一次。
 *
 * 命中不了指的不是语法不匹配（那种情况命令会被拒，拒绝文案里会说清），而是这条命令在会话的
 * 工作目录下**根本跑不起来**：仓库根没有 package.json，`pnpm run x` 只会报
 * "No package.json found"。子代理没有 `cd`、也没有 `&&`，于是这条授权永远用不上，它只能
 * 自己找一个等价写法 —— 那正是要避免的坑。
 *
 * 聚合成一条发出去：一条警告说清全部，比 N 条各说一条更容易被父代理一次读完。
 */
function reportUnreachableEntries(rule: BashRule, cwd: string): void {
	const unreachable = unreachableEntries(allEntries(rule), cwd);
	if (unreachable.length === 0) return;
	// 条目本身也要封顶：一个大白名单里十几条 pnpm 条目同时不可达时，一条告警会长到没人读。
	const shown = unreachable.slice(0, MAX_LISTED);
	const hidden = unreachable.length - shown.length;
	const list = `${shown.map((item) => `${item.entry} (${item.why}${candidateHint(item)})`).join(", ")}${hidden > 0 ? `, … and ${hidden} more` : ""}`;
	// 改法按条目给：每条建议里带着自己的脚本名，读者能对上是哪一条。
	const fixes = shown.map((item) => item.fix).filter((fix): fix is string => fix !== undefined);
	// 隐藏条目的改法换不出来：候选是同一份列表，全列一遍只会让这条告警更长。总数照实说，
	// 并明说下面的改法只覆盖列出来的这几条 —— 不说的话读者会以为改法覆盖了全部。
	const covered = hidden > 0 ? " (the forms below cover the listed entries only)" : "";
	const tail = fixes.length > 0 ? ` Use the package-relative form instead: ${fixes.join("; ")}${covered}` : "";
	uiWarning?.(
		`pi-subagents-extend: ${unreachable.length} allowlist entries can never match from ${unreachable[0]?.lookedIn ?? cwd}: ${list}. Commands run in the session's working directory; there is no \`cd\`.${tail}`
	);
}

/**
 * 拒绝文案里的「同首 token 条目」提示。
 *
 * 命令被拒时，子代理最想知道的是「为什么没匹配上、该改哪里」。同首 token 的条目就是它该看的
 * 地方：条目按词前缀匹配，`pnpm run lint` 放行 `pnpm run lint --x`，但不放行
 * `pnpm run typecheck`。首 token 不同的条目与此无关，不写进来（不臆测）。
 *
 * 这些条目里若有永远命中不了的（见 `unreachableEntries`），把「为什么」与「改成什么」一起
 * 写进这条拒绝文案：撞墙的原因和出路在同一条消息里，子代理不必再猜。
 */
function headEntriesHint(rule: BashRule, command: string, cwd: string): string {
	// 前缀赋值先剥掉：匹配时剥得掉，这里也得剥，否则 `HOME=/tmp/x pnpm test` 的首 token
	// 会算成 `HOME=/tmp/x`，与白名单里的 `pnpm` 对不上。
	const head = firstToken(leadingAssignments(command).rest);
	if (!head) return "";
	const siblings = allEntries(rule)
		.filter((entry) => !entry.startsWith("re:") && firstToken(entry) === head)
		.slice(0, 3);
	if (siblings.length === 0) return "";
	const unreachable = unreachableEntries(allEntries(rule), cwd);
	const details = siblings.map((entry) => {
		const bad = unreachable.find((item) => item.entry === entry);
		if (!bad) return entry;
		const fix = bad.fix ? `; use instead: ${bad.fix}` : "";
		return `${entry} (${bad.why}${candidateHint(bad)}${fix})`;
	});
	// 被拒的这条命令本身也可能跑不起来（同一个 cwd、同一个程序名）：那是子代理真正要改的
	// 东西，所以它的改法也写进去。
	const own = unreachableEntries([command], cwd)[0];
	const ownFix = own?.fix ? `; run it as: ${own.fix}` : "";
	return ` — entries for \`${head}\`: ${details.join(", ")}; a prefix entry matches only if the command starts with it word for word, and there is no \`cd\` — commands run in ${cwd}${ownFix}`;
}

export function buildSpec(cwd: string, rule: BashRule, policy: Policy) {
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
	reportHiddenGrants(dropped);
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
function writeSpecFile(spec: ReturnType<typeof buildSpec>, toolCallId: string): string | undefined {
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
function dropSpecFile(entry: { specFile?: string } | undefined): void {
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
function sweepStaleSpecFiles(): void {
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
 * 读 agent 角色的默认 bindings："default" 是**所有角色的地板**，角色名那一层在它之上追加。
 * 同一次 `mergeConfig`，所以 `reset: true` 在这里同样生效：角色想比 default 更窄就写它。
 * 早先这里的注释写着「用角色名那一层覆盖」，而实现是并集 —— 文档与行为各说一套。
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
 * profile 定下的策略：默认值打底，本次调用的 bindings 按字段合上去（见 `mergeConfig`）。
 * 本次 bindings 整体写坏时返回 undefined，由调用方保持全拒——不让 profile 把错误掩盖成
 * 「可用」。里面某一段（比如 `bash`）写坏时方向相同：`mergeConfig` 让那一段变成「关闭」，
 * 而不是让 profile 那一层的同名段补成「可用」。
 */
interface ResolvedProfile {
	policy: Policy;
	config?: Record<string, unknown>;
	source: string;
	broken?: boolean;
}

function profilePolicy(
	cwd: string,
	options: ActivateOptions,
	call: Record<string, unknown> | undefined,
	callBroken: boolean,
): ResolvedProfile | undefined {
	if (!options.profileName || callBroken) return undefined;
	const resolved = readProfile(cwd, options.profileName, options.profileFile);
	if (resolved.error) return { policy: denyAll(resolved.error), source: resolved.source, broken: true };
	// 合成后的 config 会被 reset / 显式空列清掉底层的 legacy 列，只看它会漏报项目 profile 的旧拼法；
	// 每层按自己的来源告警，护栏按来源去重（同一来源一次会话只说一次）。
	warnLegacyBashColumns(resolved.config, resolved.source);
	const merged = mergeConfig(resolved.config, call) ?? {};
	// 来源要说实话：生效的规则是 profile 与本次派单**合成**的，只写 profile 会让父代理
	// 改错文件（那条授权不在 profile 里）。拒绝文案里的 `source:` 是父代理判断
	// 「该改哪个文件」的唯一线索，所以合成时必须把两层都写出来。
	const source = call ? `${resolved.source} + extensionBindings` : resolved.source;
	return { policy: parsePolicyObject(merged, source, { requireScope: false }), config: merged, source };
}

/**
 * 派单目标角色的 worktree 默认值。按 input.agent 从 profile 里解析：default 打底，
 * 角色层与本次 bindings 依次覆盖（标量调用方优先）。读不到对应角色时，只有调用方
 * bindings 里的 `worktree === true` 才算策略（写 false、字符串等都不算）；两者都没有
 * 就返回 undefined（fail open）。
 *
 * `fromProfile` 标记这个值是否来自磁盘 profile 文件：派单自带 bindings 走的不是文件，
 * 补值时不需要提示「worktree 副本里没有那份 profile」。
 */
interface WorktreeStrategy {
	worktree?: unknown;
	fromProfile: boolean;
}

function worktreePolicyFor(
	cwd: string,
	options: ActivateOptions,
	call: Record<string, unknown> | undefined,
	agent: string,
): WorktreeStrategy {
	const resolved = readProfile(cwd, agent, options.profileFile);
	if (!resolved.config) {
		return call?.worktree === true ? { worktree: true, fromProfile: false } : { fromProfile: false };
	}
	const merged = mergeConfig(resolved.config, call);
	const fromProfile = call?.worktree === undefined && resolved.config.worktree === true;
	return { worktree: merged?.worktree, fromProfile };
}

/**
 * profile 文件在 git 里是否被跟踪。三态：true 已跟踪、false 确认未跟踪、undefined 判不了
 * （不在仓库里、git 不在 PATH、超时）。`--error-unmatch` 的退出码 1 才是「没跟踪」这个确定
 * 答案；其它失败一律当未知，宁可少说也不误报。
 */
function profileTrackedInGit(cwd: string, relPath: string): boolean | undefined {
	try {
		execFileSync("git", ["ls-files", "--error-unmatch", "--", relPath], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && (error as { status?: number }).status === 1
			? false
			: undefined;
	}
}

/** 还在用 legacy bash.read / bash.write 的配置提示一次：新写法是单列 bash.allow。 */
function warnLegacyBashColumns(config: Record<string, unknown> | undefined, source: string): void {
	if (!config || warnedLegacyBashColumns.has(source)) return;
	const bash = config.bash;
	if (!bash || typeof bash !== "object" || Array.isArray(bash)) return;
	const legacy = ["read", "write"].filter((key) => Object.hasOwn(bash, key));
	if (legacy.length === 0) return;
	warnedLegacyBashColumns.add(source);
	uiWarning?.(
		`pi-subagents-extend: ${source} still spells bash.${legacy.join(" and bash.")}, which are legacy columns; bash.allow is the single allowlist column now and read/write is judged internally. The legacy columns keep working until the compatibility layer is removed.`
	);
}
/**
 * 补 worktree 默认值时，若策略来自磁盘 profile 而该文件没被 git 跟踪，告诉父代理一次：
 * worktree 副本里不会有这个文件，子代理读不到 profile 会被全拒。只在确认未跟踪时提示，
 * 判不了就不说；同一路径只提示一次（集合在 session_start 清空）。
 */
function warnUntrackedWorktreeProfile(cwd: string, options: ActivateOptions): void {
	const file = resolve(cwd, options.profileFile ?? PROFILE_FILE);
	if (reportedUntrackedWorktreeProfiles.has(file)) return;
	const relPath = relative(cwd, file);
	if (profileTrackedInGit(cwd, relPath) !== false) return;
	reportedUntrackedWorktreeProfiles.add(file);
	uiWarning?.(
		`pi-subagents-extend: \`worktree: true\` runs the subagent in a worktree copy, but the profile file ${relPath} is not tracked by git, so the copy will not contain it and the subagent will be denied every call because it cannot read its profile. Commit that file, or pass the configuration in the dispatch's own bindings instead.`
	);
}

/**
 * 交付物授权只给主检出里的一个普通文件：目录会把整棵子树变成写面，软链会把授权指到树外。
 * 不存在时用 wx 落位——检查和落位之间被换成软链就宁可失败，绝不跟着链接写。
 * 落位前后都按 canonical 的主检出根做边界检查：先挡住软链父目录，再校验最终授权。
 */
function deliverableGrant(target: string, root: string, warn: (message: string) => void): string | undefined {
	let stat: ReturnType<typeof lstatSync> | undefined;
	try {
		stat = lstatSync(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			warn(`pi-subagents-extend: cannot inspect deliverable ${target}: ${error instanceof Error ? error.message : String(error)}; granting nothing`);
			return undefined;
		}
	}
	if (stat) {
		if (stat.isSymbolicLink() || !stat.isFile()) {
			const kind = stat.isSymbolicLink() ? "a symbolic link" : "a directory or special file";
			warn(`pi-subagents-extend: deliverable ${target} is not a regular file (${kind}); granting nothing (a directory would open its whole subtree, a link could point outside the main checkout)`);
			return undefined;
		}
	}

	const rootCanonical = canonical(root);
	const insideCheckout = (candidate: string): boolean =>
		candidate === rootCanonical || candidate.startsWith(rootCanonical + sep);

	// 落位前先解析父目录（取最深已存在祖先）：软链父目录会把新文件写到主检出之外。
	// 旧的 realpathSync(grant) !== resolve(grant) 是空操作——grant 已由 canonical 解析，两边必然相等。
	const parentCanonical = canonical(dirname(target));
	if (!insideCheckout(parentCanonical)) {
		warn(`pi-subagents-extend: deliverable ${target} resolves outside the main checkout (${join(parentCanonical, basename(target))}); granting nothing`);
		return undefined;
	}

	if (!stat) {
		try {
			// helper 只接受已存在的路径；空文件先落位，真正的写入仍交给子代理。
			mkdirSync(dirname(target), { recursive: true });
			closeSync(openSync(target, "wx"));
		} catch (error) {
			warn(`pi-subagents-extend: unable to create deliverable file ${target}: ${error instanceof Error ? error.message : String(error)}; granting nothing`);
			return undefined;
		}
	}

	const grant = canonical(target);
	if (!insideCheckout(grant)) {
		warn(`pi-subagents-extend: deliverable ${target} resolves outside the main checkout (${grant}); granting nothing`);
		return undefined;
	}
	return grant;
}

/**
 * output.deliverable 的接线：建软链、把真实文件加进写授权、并给子代理一条提示段落。
 * 抽成具名函数是为了让阶段 3 的测试能直接走同一条路径，而不是复制一份判定。
 */
export function wireDeliverable(
	cwd: string,
	block: Record<string, unknown> | undefined,
	policy: { absoluteWrite: string[] },
	options: { sections?: Record<string, string> } | undefined,
	warn: (message: string) => void,
): { link?: ReturnType<typeof ensureDeliverableLink>; target?: string } {
	deliverableTargetPath = undefined;
	const { output, problems } = outputFromBlock(block ?? {});
	for (const problem of problems) warn(`pi-subagents-extend: ${problem}`);
	if (!output?.deliverable) return {};
	const deliverable = output.deliverable;
	const anchor = mainRepoRoot(cwd);
	if (anchor.root === null) {
		warn(`pi-subagents-extend: cannot locate the main repository from ${cwd}; tried: ${anchor.tried.join(" | ")}`);
		return {};
	}
	const link = ensureDeliverableLink(cwd, anchor.root, deliverable);
	if ("warning" in link) warn(`pi-subagents-extend: ${link.warning}`);
	const target = deliverableTarget(anchor.root, deliverable);
	const grant = deliverableGrant(target, anchor.root, warn);
	if (!grant) return { link, target };
	if (!policy.absoluteWrite.includes(grant)) policy.absoluteWrite.push(grant);
	deliverableTargetPath = grant;
	if (options) {
		options.sections = {
			...(options.sections ?? {}),
			[DELIVERABLE_SECTION]: `Write the deliverable to \`${deliverable}\`. Name the file in your final message; the parent reads it at \`${grant}\`.`,
		};
	}
	return { link, target };
}


/** 会话级记住 nodeModules 的选择；写在拒绝文案里的提示只在 keep / 缺席时给，remove 后给就是假提示。 */
let worktreeNodeModules: "keep" | "remove" = "keep";

/** 写目标是否穿过 cwd/node_modules 这条软链，包括子代理直接写出主检出的真实路径。 */
export function nodeModulesWriteHint(cwd: string, target: string): string {
	if (worktreeNodeModules !== "keep") return "";
	const link = resolve(cwd, "node_modules");
	let absolute: string;
	try {
		if (!lstatSync(link).isSymbolicLink()) return "";
		absolute = resolve(cwd, target);
	} catch {
		return "";
	}
	if (absolute !== link && !absolute.startsWith(link + sep)) {
		try {
			const real = realpathSync(link);
			if (!absolute.startsWith(real + sep)) return "";
		} catch {
			return "";
		}
	}
	return " Set worktree.nodeModules: remove in the role md to unlink the shared node_modules link.";
}

/** worktree.nodeModules: remove 只解掉工作树侧的软链，目标（主检出里的依赖）必须留下。 */
export function wireWorktree(
	cwd: string,
	block: Record<string, unknown> | undefined,
	warn: (message: string) => void,
): { action: "none" | "removed" | "skipped" } {
	const { worktree, problems } = worktreeFromBlock(block ?? {});
	for (const problem of problems) warn(`pi-subagents-extend: ${problem}`);
	worktreeNodeModules = worktree?.nodeModules ?? "keep";
	if (worktree?.nodeModules !== "remove") return { action: "none" };

	const link = resolve(cwd, "node_modules");
	let target: string;
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(link);
	} catch {
		return { action: "none" };
	}
	if (!stat.isSymbolicLink()) {
		warn(`pi-subagents-extend: ${link} is a real directory; left it untouched`);
		return { action: "skipped" };
	}
	try {
		target = resolve(dirname(link), readlinkSync(link));
	} catch (error) {
		warn(`pi-subagents-extend: unable to read link ${link}: ${error instanceof Error ? error.message : String(error)}`);
		return { action: "skipped" };
	}
	const anchor = mainRepoRoot(cwd);
	if (anchor.root === null || (target !== anchor.root && !target.startsWith(anchor.root + sep))) {
		warn(`pi-subagents-extend: ${link} points to ${target}, outside the main checkout; left it untouched`);
		return { action: "skipped" };
	}
	try {
		unlinkSync(link);
	} catch (error) {
		warn(`pi-subagents-extend: unable to unlink ${link}: ${error instanceof Error ? error.message : String(error)}`);
		return { action: "skipped" };
	}
	warn(`pi-subagents-extend: removed ${link}; the target ${target} was left untouched`);
	return { action: "removed" };
}

/** setup.preExec 每个子会话跑一次；失败只告警，绝不让派单半路停下。 */
export async function wirePreExec(
	cwd: string,
	block: Record<string, unknown> | undefined,
	warn: (message: string) => void,
): Promise<{ ran: boolean; status?: number | null }> {
	const { setup, problems } = setupFromBlock(block ?? {});
	for (const problem of problems) warn(`pi-subagents-extend: ${problem}`);
	const command = setup?.preExec;
	if (!command) return { ran: false };

	// 冷工作树里装依赖常常要好几分钟，所以给足 10 分钟。这里故意不走 helper：命令要往
	// 工作树（以及包管理器缓存）里写，而 helper 的可写面只覆盖本次写授权，天然罩不住安装。
	let child: ReturnType<typeof spawn>;
	try {
		// detached 让命令自带进程组；超时杀整组，不留装依赖时 fork 出去的孙进程。
		child = spawn(command, { shell: true, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	} catch (error) {
		warn(`pi-subagents-extend: setup.preExec could not start: ${error instanceof Error ? error.message : String(error)}; continuing`);
		return { ran: true };
	}

	const pid = child.pid;
	const maxOutput = 4 * 1024 * 1024;
	let output = "";
	const collect = (chunk: Buffer | string): void => {
		output = (output + chunk.toString("utf8")).slice(-maxOutput);
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		if (pid !== undefined) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// 进程组已经退出；组杀失败无需处理。
			}
		}
	}, 600_000);
	// 子进程及其 stdout/stderr 管道会撑住事件循环，超时对运行中的子进程照样生效；unref 只防止
	// 会话先结束时被这个十分钟的定时器吊住（进程退出时 clearTimeout 会把它摘掉）。
	timer.unref();

	const outcome = await new Promise<{ status: number | null; error?: Error }>((resolve) => {
		child.once("error", (error) => {
			clearTimeout(timer);
			resolve({ status: null, error });
		});
		child.once("close", (status) => {
			clearTimeout(timer);
			resolve({ status });
		});
	});

	if (outcome.error || outcome.status !== 0) {
		const tail = output.split(/\r?\n/).slice(-20).join("\n").slice(-2000) || "(no output)";
		const code = outcome.error
			? `no exit code (${outcome.error.message})`
			: timedOut
				? "no exit code (timed out after 600000ms; killed the process group)"
				: outcome.status === null
					? "no exit code (killed by signal)"
					: String(outcome.status);
		warn(`pi-subagents-extend: setup.preExec exited with code ${code}; continuing. Output tail:\n${tail}`);
	}
	return { ran: true, status: outcome.status };
}

export function activate(pi: ExtensionAPI, options: ActivateOptions = {}) {
	// bindings 在激活时定格：前台子代理的 bindings 环境变量只在会话启动前存在，
	// tool_call 里读不到，必须在这里取。profile 的文件反过来——要按会话 cwd 读，
	// 所以在 session_start 里解析。
	const call = extractCallConfig(process.env[BINDINGS_ENV]);
	let policy: Policy = INACTIVE;
	// 角色 md 的基线：before_agent_start 里按子代理身份填入，只补 bindings / profile 没给的字段。
	let roleBaseline: RolePolicy | undefined;
	let roleSource: string | undefined;
	let roleResolved = false;
	// before_agent_start 可能在 preExec 等待期间再次触发；同一个键的发射者 await 在飞的接线，
	// 不同键（另一个子会话）各走各的。失败时 finally 删键，下一轮可重试，不缓存 rejected promise。
	const roleWirings = new Map<string, Promise<void>>();
	let baseConfig = call.config;
	let baseSource = `extensionBindings ${bindingKey()}`;
	let baseRequireScope = Boolean(call.config);
	let baseBroken = Boolean(call.error);
	/** toolCallId → 这次 bash 的 spec 摘要（写清单、cwd、是否离线）。 */
	const sandboxSpecs = new Map<
		string,
		{ write: string[]; cwd: string; offline: boolean; command: string; specFile?: string }
	>();
	if (call.error) {
		policy = denyAll(call.error);
	} else if (call.config) {
		policy = parsePolicyObject(call.config, `extensionBindings ${bindingKey()}`, { requireScope: true });
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
	/** 停机之后每次调用收到的话：只讲状态，不复述触发停机的那次动作。 */
	const stopNotice = STOP_NOTICE;
	const stop = (reason: string) => {
		stopped = true;
		// 详细理由只回给触发停机的那一次；后续调用拿 stopNotice，见上面。
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
							ui?.notify?.(`pi-subagents-extend: ${text}`, "warning");
						},
					},
				})
				: undefined;
	};
	armProbe();

	/**
	 * bindings / profile 已经有值的键优先，md 基线只填缺失的那几个
	 * （scope、writeScope、readOnly、allowTools、maxDenies、maxWriteDenies）。
	 */
	const applyRoleBaseline = (): void => {
		if (baseBroken || !roleBaseline || Object.keys(roleBaseline).length === 0) return;
		// 上层自己写了 readOnly 且没写 writeScope：写范围就是空的（与 mergeConfig 同语义），
		// md 不能把写授权重新放出来。
		const readOnlyWithoutWrite = Object.hasOwn(baseConfig ?? {}, "readOnly") && baseConfig?.readOnly === true && !Object.hasOwn(baseConfig ?? {}, "writeScope");
		const fields: Record<string, unknown> = { ...(baseConfig ?? {}) };
		let mdContributed = false;
		for (const [key, value] of Object.entries(roleBaseline)) {
			if (key === "writeScope" && readOnlyWithoutWrite) continue;
			if (!Object.hasOwn(fields, key)) {
				fields[key] = value;
				mdContributed = true;
			}
		}
		// md 一个字段都没补进来就不重算策略：来源也不能凭空多出一层。
		if (!mdContributed) return;
		// 拒绝文案里的 source 是父代理判断「该改哪个文件」的唯一线索，只列真正贡献过的层。
		// baseSource 已经是 profile 与本次 bindings 的合成结果（见 profilePolicy），排在 md 之前。
		const mdLabel = roleSource ?? "role md";
		const source = baseConfig ? `${baseSource} + ${mdLabel}` : mdLabel;
		probe?.dispose();
		policy = parsePolicyObject(fields, source, { requireScope: baseRequireScope });
		denyCounter = new DenyCounter(policy.maxDenies);
		writeDenyCounter = new DenyCounter(policy.maxWriteDenies, "write");
		armProbe();
	};

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
type AnchorResolution =
	| { path: string }
	| { miss: "unknown" }
	| { miss: "disagree"; files: string[] };
function anchorTargetPath(
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
const ANCHOR_ARGS = [
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
const TRANSFER_SOURCE_ARGS = ["source_from", "source_to"];
const TRANSFER_DEST_ARGS = ["anchor"];

	/** 工具名 → schema 里的路径入参名；一处缓存，避免每次调用都问一遍注册表。 */
	const schemaPathArgs = new Map<string, string | undefined>();

	const pathArgFromSchema = (toolName: string): string | undefined => {
		if (schemaPathArgs.has(toolName)) return schemaPathArgs.get(toolName);
		let found: string | undefined;
		try {
			const registered = (
				pi as { getAllTools?: () => { name: string; parameters?: unknown }[] }
			).getAllTools?.();
			const tool = registered?.find((entry) => entry.name === toolName);
			const properties = (tool?.parameters as { properties?: Record<string, { type?: string }> } | undefined)
				?.properties;
			if (properties?.path?.type === "string") found = "path";
			else if (properties?.file_path?.type === "string") found = "file_path";
		} catch {
			// 宿主没暴露 getAllTools（老版本、测试桩）：退回缺省的 "path"。
		}
		schemaPathArgs.set(toolName, found);
		return found;
	};

	/**
	 * 名字 → 类别。undefined 表示它不是路径类工具，交给 allowTools 那条路。
	 *
	 * 路径入参名的取值顺序：父代理显式声明 → 工具自己的 schema → "path"。中间那层是为了
	 * 不靠猜：hashline 那套工具的 schema 里就有 `path`，而换个宿主可能叫 `file_path`。
	 */
	const toolKindOf = (
		toolName: string,
	): { access: "read" | "write"; pathArg: string | false; transferSource?: "read" | "write" } | undefined => {
		const declared = Object.hasOwn(policy.tools, toolName) ? policy.tools[toolName] : undefined;
		const fallback = Object.hasOwn(DEFAULT_TOOL_ACCESS, toolName) ? DEFAULT_TOOL_ACCESS[toolName] : undefined;
		const access = declared?.access ?? fallback;
		if (!access) return undefined;
		return {
			access,
			pathArg: declared?.path ?? pathArgFromSchema(toolName) ?? "path",
			...(declared?.transferSource === undefined ? {} : { transferSource: declared.transferSource }),
		};
	};

	const pathToolVerdict = (
		event: { toolName: string; input?: unknown },
		cwd: string,
		kind: { access: "read" | "write"; pathArg: string | false; transferSource?: "read" | "write" },
		sessionFile: string | undefined,
	): { block: true; reason: string; terminate?: boolean } | undefined => {
		const isWrite = kind.access === "write";
		// 声明成写工具却没有可判的路径入参：目标拿不到，就没有任何授权能覆盖它。永远拒绝，
		// 而且这是用法/配置问题，不计入撞权限预算。
		if (isWrite && kind.pathArg === false) {
			return deny(
				`pi-subagents-extend: ${event.toolName} is declared as a write tool with no path argument, so its target cannot be checked (source: ${policy.source}). Declare tools.${event.toolName}.path in the bindings, or let the parent perform this write.`,
			);
		}
		const input = (event as { input?: Record<string, unknown> }).input;
		const pathValue = kind.pathArg === false ? undefined : input?.[kind.pathArg];
		let raw = typeof pathValue === "string" ? pathValue.trim() : "";
		// 写类工具没带路径时，先按「锚点归属」把目标找回来：锚点编辑工具的目标就是锚点所属的
		// 文件，归属记在宿主扩展的会话 sidecar 里。解析不出来就保持空 → 下面拒绝。
		const anchorTextOf = (keys: string[]): string[] =>
			keys
				.map((key) => input?.[key])
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter((value) => value !== "");

		let anchorsTried: string[] = [];
		// 解析失败要分清是哪一种：模型看到的文案不同，出路也不同（重读一次 vs 拆成两次调用）。
		let anchorMiss: { miss: "unknown" } | { miss: "disagree"; files: string[] } | undefined;
		if (isWrite && !raw) {
			anchorsTried = anchorTextOf(ANCHOR_ARGS);
			const resolved = anchorTargetPath(sessionFile, anchorsTried);
			if ("path" in resolved) raw = resolved.path;
			else anchorMiss = resolved;
		}

		const readable = (path: string): boolean => matches(policy.regexps, cwd, path);
		const writable = (path: string): boolean =>
			matches(policy.writeRegexps, cwd, path) || underAny(policy.absoluteWrite, cwd, path);

		// 锚点分属两个文件：这不是「读不到」，重读一百次还是同一个入参 —— 只能拆成两次调用。
		const disagreeText = (files: string[]): string =>
			`pi-subagents-extend: ${event.toolName} was given anchors that belong to different files (${files.join(", ")}), so there is no single file whose access could be checked (source: ${policy.source}). One call edits one file — split this into one call per file.\nWrite scope: ${preview(policy.writeGlobs)}`;
		const transferUnknownText = (side: string): string =>
			`pi-subagents-extend: ${event.toolName} moves content between two files, and the ${side} anchors are not in this session's anchor registry, so that file is unknown. Both sides have to be known before either can be checked (source: ${policy.source}). Re-read the file (anchors expire), enable the host's force-path option (pi-hashline-edit-pro: requirePath), or pass the path explicitly.\nWrite scope: ${preview(policy.writeGlobs)}`;

		// 双文件工具（copy / move）：`source_*` 属于源文件，`anchor`（与 `remove_*`）属于目标
		// 文件，两份文件必须分别判定。合成一组去查只会拿到先命中的那一侧，另一侧完全没判 ——
		// 源在写范围内、目标在范围外时会被放行，而这类工具在子进程里直接落盘，没有 Landlock
		// 兜底，放行就是一次真正的写越界。
		const sourceAnchors = isWrite ? anchorTextOf(TRANSFER_SOURCE_ARGS) : [];
		const destAnchors = isWrite ? anchorTextOf(TRANSFER_DEST_ARGS) : [];
		if (isWrite && sourceAnchors.length > 0 && destAnchors.length > 0) {
			const sourceRes = anchorTargetPath(sessionFile, sourceAnchors);
			const destRes = anchorTargetPath(sessionFile, destAnchors);
			if (!("path" in sourceRes)) {
				return deny(sourceRes.miss === "disagree" ? disagreeText(sourceRes.files) : transferUnknownText("source"));
			}
			if (!("path" in destRes)) {
				return deny(destRes.miss === "disagree" ? disagreeText(destRes.files) : transferUnknownText("destination"));
			}
			const sourcePath = sourceRes.path;
			const destPath = destRes.path;
			// 宿主开了 requirePath 时显式 path 指向其中一侧；对不上就说明声明与锚点不一致。
			// 必须按**解析后**的绝对路径比：注册表里存的是 toCwd 之后的绝对路径，宿主自己也是把
			// providedPath resolve 到 cwd 再与锚点归属比对（fs-write.ts 的 resolveInCwd → toCwd，
			// paths.ts 里非绝对路径就 resolve(cwd, p)）。早先拿原始字符串直接比，任何相对写法
			// （`docs/b.md`、`./docs/b.md`）都永远对不上，于是把宿主本来会执行的调用一律拒掉 ——
			// 而相对写法正是模型最常给的形式，也是宿主 read 输出里的显示形式。
			const rawAbs = raw ? resolve(cwd, raw) : "";
			if (rawAbs && rawAbs !== sourcePath && rawAbs !== destPath) {
				return deny(
					`pi-subagents-extend: ${event.toolName} was given path "${raw}", which matches neither file its anchors belong to ("${sourcePath}" and "${destPath}") (source: ${policy.source}). Pass the path of the file the anchors came from, or omit it.`,
				);
			}
			// 表按 Object.hasOwn 读：工具名是外部输入，`__proto__` / `constructor` 这类名字
			// 走普通下标会取到原型链上的对象。表里现在只有 copy / move，撞不到，但这是本文件里
			// 最后一处没设防的表读取，别留着。
			const defaultSource = Object.hasOwn(DEFAULT_TRANSFER_SOURCE, event.toolName)
				? DEFAULT_TRANSFER_SOURCE[event.toolName]
				: undefined;
			const sourceAccess = kind.transferSource ?? defaultSource ?? "write";
			if (sourceAccess === "read") {
				if (!readable(sourcePath)) {
					return bail(
						`pi-subagents-extend: ${event.toolName} reads "${sourcePath}", which is outside the read scope — copying content out of it would carry that content past this layer (source: ${policy.source}). Say what you need from it instead.\nRead scope: ${preview(policy.globs)}`,
					);
				}
			} else if (!writable(sourcePath)) {
				return writeBail(
					`pi-subagents-extend: ${event.toolName} changes the source file "${sourcePath}" (a move deletes the lines it takes), and that file is readable but not writable — the write scope is ${preview(policy.writeGlobs)} (source: ${policy.source}). Copy instead of moving if the source may only be read.${nodeModulesWriteHint(cwd, sourcePath)}`,
				);
			}
			if (!writable(destPath)) {
				return writeBail(
					`pi-subagents-extend: "${destPath}" is readable but not writable, so ${event.toolName} cannot place the block there — the write scope is ${preview(policy.writeGlobs)} (source: ${policy.source}). Deliver a report instead of writing a file; use contact_supervisor if it really has to be written.${nodeModulesWriteHint(cwd, destPath)}`,
				);
			}
			const junk = probe?.checkWriteTarget(destPath);
			if (junk) return { block: true, reason: junk.reason, terminate: false };
			probe?.noteWriteActivity();
			// 两侧都过了：不要落回下面的单路径判定（它会把源当成写目标再判一次）。
			return undefined;
		}

		const target = raw || ".";
		const writeHint = isWrite ? nodeModulesWriteHint(cwd, target) : "";
		if (event.toolName === READ_TOOL && policy.maxReads > 0 && allowedReads >= policy.maxReads) {
			return bail(`pi-subagents-extend: read budget exhausted (${policy.maxReads} reads).`);
		}
		const canWrite = policy.writeGlobs.length > 0 || policy.absoluteWrite.length > 0;
		// 只对 readOnly 早退：`writeScope: []`（不是 readOnly）走下面那条「readable but not
		// writable」，它说清了「读还是能读」，比一句「没有写授权」有用。
		if (isWrite && policy.readOnly && !canWrite) {
			// 一条写授权都没有（readOnly 且没写 writeScope，或 writeScope: []）与「写不进去」是同一种
			// 处境：放宽读范围解决不了，所以走写预算。出路是改成交报告，而不是去求援——记到授权
			// 预算上会让子代理连撞 5 次、还被指去 contact_supervisor，而它求不到任何东西。
			return writeBail(
				`pi-subagents-extend: this session has no write grant; ${event.toolName} is refused (source: ${policy.source}). Deliver the finding as a report instead of writing a file; use contact_supervisor if it really has to be written.${writeHint}`,
			);
		}
		// 写操作没有 path 就无法判断目标：直接说清，不要报成「路径不在范围内」。
		// 这是用法错误不是权限错误，不计入撞权限计数。
		if (isWrite && !raw) {
			// 锚点分属两个文件是入参自相矛盾，不是「读不到」：文案要指出去拆调用，别让模型去重读。
			if (anchorMiss?.miss === "disagree") return deny(disagreeText(anchorMiss.files));
			return deny(
				anchorsTried.length > 0
					? `pi-subagents-extend: ${event.toolName} has no target path — no "${kind.pathArg}" was passed, and the anchor it points at is not in this session's anchor registry, so the owning file is unknown. Without a target nothing can be checked, so no scope can allow it (source: ${policy.source}). Re-read the file (anchors expire), enable the host's force-path option (pi-hashline-edit-pro: requirePath), or pass the path explicitly.\nWrite scope: ${preview(policy.writeGlobs)}`
					: `pi-subagents-extend: ${event.toolName} has no "${kind.pathArg}" — without a target nothing can be checked, so no scope can allow it (source: ${policy.source}). Pass it explicitly.\nWrite scope: ${preview(policy.writeGlobs)}`,
			);
		}
		const readOk = matches(policy.regexps, cwd, target);
		if (isWrite) {
			if (!matches(policy.writeRegexps, cwd, target) && !underAny(policy.absoluteWrite, cwd, target)) {
				// 读得到、写不到：这是最常见也最容易误导的拒绝，文案要直说撞的是写范围，
				// 并给出正解——回报告——而不是「换个路径再试」。
				if (readOk) {
					return writeBail(
						`pi-subagents-extend: "${target}" is readable but not writable — the write scope is ${preview(policy.writeGlobs)} (source: ${policy.source}). Deliver a report instead of writing a file; use contact_supervisor if it really has to be written.${writeHint}`,
					);
				}
				return bail(
					`pi-subagents-extend: "${target}" is outside the scope — neither readable nor writable (source: ${policy.source}). Do not retry outside paths; if you need this one, say what and why.\nRead scope: ${preview(policy.globs)}\nWrite scope: ${preview(policy.writeGlobs)}${writeHint}`,
				);
			}
		} else if (!readOk) {
			// 缺 path 时目标其实是 cwd，说清这一点，免得被当成「子代理走错目录」。
			if (!raw) {
				// 缺 path：用法错误，不计入撞权限计数。
				return deny(
					`pi-subagents-extend: no path was given; the working directory (${cwd}) was assumed and is outside the read scope (source: ${policy.source}). Pass a path inside the scope.\nRead scope: ${preview(policy.globs)}`,
				);
			}
			// cwd / 仓库根：读起来像 scope 写错，其实多半是「想要全仓搜索」。计数（这是
			// 授权问题），但要说清这不是某个文件路径写错。
			if (isRootish(raw, cwd)) {
				return bail(
					`pi-subagents-extend: "${raw}" is the repository root, not a file in the read scope (source: ${policy.source}). Pass the concrete path; if repo-wide access is really needed, say so and the parent can widen the scope.\nRead scope: ${preview(policy.globs)}`,
				);
			}
			return bail(
				`pi-subagents-extend: "${target}" is outside the read scope (source: ${policy.source}). Do not retry outside paths; if you need this one, say what and why.\nRead scope: ${preview(policy.globs)}`,
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
	pi.on("before_agent_start", async (event, ctx) => {
		const raw = (event as { systemPrompt?: unknown }).systemPrompt;
		const prompt = typeof raw === "string" ? raw : "";
		const cwd = ctx.cwd ?? process.cwd();
		// 实测：前台子代理的 process.env.PI_SUBAGENT_CHILD 是 null —— pi-subagents 只为
		// host === "runner" 的后台子代理设它，前台在父进程里 restoreProcessEnv。
		// 所以子会话另看 bindings 载荷与提示里的角色身份；别把这行简化回只看 PI_SUBAGENT_CHILD。
		const child =
			process.env.PI_SUBAGENT_CHILD === "1" ||
			call.config !== undefined ||
			call.error !== undefined ||
			parseRoleName(prompt) !== null ||
			resolveRoleFromPrompt(prompt, cwd, homedir()).role !== null;
		if (!child || roleResolved) return;
		const tag = parseRoleName(prompt);
		const wiringKey = `${cwd}\u0000${tag}`;
		const inFlight = roleWirings.get(wiringKey);
		if (inFlight) {
			await inFlight;
			return;
		}
		let finishWiring!: () => void;
		const wiring = new Promise<void>((resolve) => { finishWiring = resolve; });
		roleWirings.set(wiringKey, wiring);
		try {
			// 模块级状态在子会话开始时清零，不依赖 session_start 与 before_agent_start 的先后顺序。
			deliverableTargetPath = undefined;
			worktreeNodeModules = "keep";
			const ui = ctx.ui as { notify?: (m: string, t?: string) => void } | undefined;
			uiWarning = (message) => { ui?.notify?.(message, "warning"); };
			if (call.config && Object.hasOwn(call.config, "setup")) {
				uiWarning?.("pi-subagents-extend: setup in extensionBindings is ignored; put setup.preExec in the role md");
			}
			const home = homedir();
			// 标签找不到时再用正文探针认角色（systemPromptMode: replace 会丢标签）。
			// 扫描只在这里发生：前面的 roleResolved / roleWirings 闸门保证每轮接线最多跑一次。
			const resolved = resolveRoleFromPrompt(prompt, cwd, home);
			for (const warning of resolved.warnings) uiWarning?.(warning);
			const role = resolved.role;
			if (!role) {
				let warning = policy.active
					? `pi-subagents-extend: no active_agent role was found in the system prompt, so the role md limits are NOT applied; the only configuration in effect is ${policy.source}.`
					: "pi-subagents-extend: no active_agent role was found in the system prompt, so the role md limits are NOT applied; no configuration is in effect, so tool calls in this child are unconstrained.";
				if (resolved.extendMdSeen) {
					// 有 md 声明了 extend 却没认出身份，点明最可能的成因与改法，免得反复撞限制。
					warning += `\npi-subagents-extend: a role md declares an extend block, but the prompt has no <active_agent> tag and no md body matched; systemPromptMode: replace drops the tag — use append (or keep the md body intact) so the role can be identified.`;
				}
				uiWarning?.(warning);
				roleResolved = true;
				return;
			}
			const file = resolveAgentFile(role, cwd, home);
			if (!file) {
				uiWarning?.(
					`pi-subagents-extend: no role md was found for role "${role}"; the role md limits are NOT applied. Looked in: ${agentMdDirs(cwd, home).join(", ")}`,
				);
				roleResolved = true;
				return;
			}
			const read = readExtendBlock(file);
			const converted = read.block ? policyFromBlock(read.block) : { problems: [] as string[] };
			for (const problem of [...read.problems, ...converted.problems]) {
				uiWarning?.(`pi-subagents-extend: ${role} (${file}): ${problem}`);
			}
			if (converted.policy && Object.keys(converted.policy).length > 0) {
				roleBaseline = converted.policy;
				roleSource = `role md ${file}`;
				applyRoleBaseline();
			}
			wireDeliverable(
				cwd,
				read.block,
				policy,
				(event as { systemPromptOptions?: { sections?: Record<string, string> } }).systemPromptOptions,
				(message) => uiWarning?.(message),
			);
			wireWorktree(cwd, read.block, (message) => uiWarning?.(message));
			await wirePreExec(cwd, read.block, (message) => uiWarning?.(message));
		} finally {
			roleWirings.delete(wiringKey);
			finishWiring();
		}
		roleResolved = true;
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		// 提示状态按会话重置：一个进程可能服务多个会话，模块级的 set 留到下一个会话就会把
		// 本该发出的告警吞掉（那是「lost, not duplicated」的一种，且完全没有痕迹）。
		reportedHiddenGrants.clear();
		reportedUntrackedWorktreeProfiles.clear();
		warnedLegacyBashColumns.clear();
		// UI 提示通道在这里接上会话的 ctx：`judgeToolCall` 只在工具调用时绑定，session_start
		// 里的告警要发得出去，就不能等第一次工具调用。
		uiWarning = (message) => {
			const ui = ctx.ui as { notify?: (m: string, t?: string) => void } | undefined;
			ui?.notify?.(message, "warning");
		};
		const cwd = ctx.cwd ?? process.cwd();
		// profile 只在声明了它的入口里生效：agent 的 subagentOnlyExtensions 会加载
		// 那份两行 loader，主会话不会加载，所以主会话不会被项目默认值误锁。
		const resolved = profilePolicy(cwd, options, call.config, Boolean(call.error));
		if (resolved) {
			probe?.dispose();
			policy = resolved.policy;
			baseConfig = resolved.config;
			baseSource = resolved.source;
			baseRequireScope = false;
			baseBroken = resolved.broken === true;
			denyCounter = new DenyCounter(policy.maxDenies);
			writeDenyCounter = new DenyCounter(policy.maxWriteDenies, "write");
			allowedReads = 0;
			armProbe();
			applyRoleBaseline();
		}
		warnLegacyBashColumns(call.config, `extensionBindings ${bindingKey()}`);
		if (!policy.active) return;
		const budget = policy.maxReads > 0 ? `, read budget ${policy.maxReads}` : "";
		const bash = policy.bash
			? `, bash ${policy.bash.read.length} read / ${policy.bash.write.length} write`
			: ", bash off";
		const probeLine = probe ? ", probe on" : "";
		const storeLine = policy.bash ? `, pnpm store ${detectPnpmStore(cwd).path ?? "detection failed"}` : "";
		const writeGrants = [...policy.writeGlobs, ...policy.absoluteWrite];
		let mode = "read-write";
		if (policy.readOnly) mode = writeGrants.length > 0 ? "read-only, except the granted writes" : "read-only";
		const sameWrite = policy.writeGlobs.join("\n") === policy.globs.join("\n");
		const writeNote = sameWrite ? "" : `, write scope ${policy.writeGlobs.length} entries`;
		const msg = policy.globs.length
			? `scope active (${policy.source}, ${policy.globs.length} entries${writeNote}, ${mode}${budget}${bash}${probeLine}${storeLine})`
			: `scope is empty: every file access is refused${budget}${bash}${probeLine}${storeLine}`;
		ctx.ui.notify(`pi-subagents-extend: ${msg}`, "info");
		// 只在该会话真的会跑 bash 时才喊：父会话没 bindings 时 bash 不受管，不必打扰。
		if (policy.bash) {
			const blocker = bashBlocker(helperPath());
			if (blocker) ctx.ui.notify(`pi-subagents-extend: ${blocker}`, "warning");
			// 授权写了却永远命中不了：告诉父代理一次（走 UI，不进模型上下文）。
			reportUnreachableEntries(policy.bash, cwd);
		}
	});

	pi.on("session_shutdown", async () => {
		probe?.dispose();
		// 兜底：清掉本次会话（以及之前被中断的会话）遗留的 spec 文件。
		sweepStaleSpecFiles();
	});

	// tool_result 干三件事：
	// 1. 探针 3 要看 bash 的输出；
	// 2. 子代理的 worktree 单会在这里返回交接单路径，就地补一句「该看哪个键」；
	// 3. 离线沙箱里的网络失败要就地说明「这是主代理没授权」，否则子代理会当成
	//    环境坏了，换 registry / 加 timeout 反复重试。
	pi.on("tool_result", async (event) => {
		const text = textOf(event.content);
		const isBash = event.toolName === "bash";
		if (probe && isBash) probe.noteBashResult(text, event.toolCallId);
		// bash 没开时命令根本没跑，别去解释它的结果。
		const offline = policy.bash !== undefined && policy.bash.network !== true;
		const ran = sandboxSpecs.get(event.toolCallId);
		if (ran) {
			sandboxSpecs.delete(event.toolCallId);
			// helper 早已读过它；留着只会堆垃圾文件（每个 bash 调用一份）。
			if (ran.specFile) {
				try {
					rmSync(ran.specFile, { force: true });
				} catch {
					// 删不掉不影响判定，忽略。
				}
			}
		}
		// allow 列里表里没有的程序跑成只读、随后写越界时，注解要说清为什么它是只读的。
		let readOnlyAllow = false;
		if (isBash && ran && policy.bash) {
			const bashMatch = classifyCommand(policy.bash, ran.command);
			readOnlyAllow = bashMatch?.column === "allow" && bashMatch.access === "read" && isUnknownProgram(ran.command);
		}
		const hints = [
			handoffHintFor(text),
			// 两道注解都以「这条命令真的失败了」为前提。不看 isError 时，成功命令的**输出内容**里
			// 出现 EACCES / ENETUNREACH 字样也会命中：实测一个子代理跑 `git diff`，diff 正文里
			// 含这些字符串，于是它自己的一份正确改动被追加了「这在授权之外，去要 writablePaths」。
			// 判断事实而不猜文案：工具结果自带 isError。
			isBash && event.isError ? networkFailureNote(text, offline) : undefined,
			isBash && event.isError ? cpuStallNote(text) : undefined,
			isBash && ran && event.isError ? writeRefusalNote(text, ran.write, ran.cwd, readOnlyAllow, policy.bash?.writable ?? true) : undefined,
			isBash && ran && event.isError && policy.bash
				? unreachableCommandNote(text, ran.command, policy.bash, ran.cwd)
				: undefined,
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
		uiWarning = (message) => {
			const ui = ctx.ui as { notify?: (m: string, t?: string) => void } | undefined;
			ui?.notify?.(message, "warning");
		};
		// 派单默认值先于范围判定：父会话没有 bindings 时同样按角色 profile 补上。
		// 补值不是拒绝，不进 deny 预算；策略解析不到就什么都不做。
		if (WORKTREE_TOOLS.has(event.toolName)) {
			const candidate = event.input as { agent?: unknown; worktree?: unknown; extensionBindings?: unknown } | undefined;
			const agent = candidate?.agent;
			if (candidate && typeof agent === "string" && agent.trim()) {
				const cwd = ctx.cwd ?? process.cwd();
				// 只有 worktree 这一个决策把本次派单自带的 bindings 叠在会话 bindings 之上；
				// 其余策略解析仍用会话启动时定格的那一份，范围不因单次派单而变。
				const own = asObject(candidate.extensionBindings)?.[bindingKey()];
				const strategy = worktreePolicyFor(cwd, options, { ...call.config, ...asObject(own) }, agent.trim());
				if (shouldDefaultWorktree(strategy, event.toolName, event.input)) {
					candidate.worktree = true;
					if (strategy.fromProfile) warnUntrackedWorktreeProfile(cwd, options);
				}
			}
		}
		if (!policy.active) return;
		const cwd = ctx.cwd ?? process.cwd();
		// 求援通道不受任何停机影响：被停住的子代理最需要的就是「报告我卡在哪」。
		if (SAFE_TOOLS.includes(event.toolName)) return undefined;
		if (stopped) return { block: true, reason: stopNotice, terminate: true };
		// 探针在边界上的 warn / 到期停机，先于本工具的判定。
		const boundary = probe?.atToolBoundary();
		if (boundary) {
			if (boundary.stop) return stop(boundary.reason);
			return { block: true, reason: boundary.reason, terminate: false };
		}

		// 拒绝分三类，分类标准只有一条：**父代理放宽授权能不能解决**。
		//   能 → 撞权限计数（bail）：范围外路径、命令不在白名单、read 预算、
		//         工具不在 allowTools、整个 bash 被关。这些是「授权与任务不匹配」的信号。
		//   写不了 → 写预算（writeBail）：写范围外、readOnly 会话里的写。放宽授权也解决不了，
		//          正解是改成交报告，所以计数与文案都跟授权那类分开。
		//   不能 → 只拒不计（deny）：用法错误（缺 path、空命令、shell 元字符）、
		//          项目 profile 的硬禁令、永远不开放的工具、环境/内核缺能力。
		// 把后一类算进预算，会让一次参数写错就提前判死长任务。

		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown })?.command ?? "").trim();
			const rule = policy.bash;
			if (!rule) {
				return bail(
					`pi-subagents-extend: bash is not allowed here (source: ${policy.source}). For tests or a typecheck the parent must list the commands in bash.read / bash.write.`,
				);
			}
			if (!command) return deny("pi-subagents-extend: empty bash command");
			// 禁止列表先于一切判定：它来自项目 profile，调用方的白名单不能放宽它。
			const forbidden = deniedEntry(rule, command);
			if (forbidden) {
				return deny(
					`pi-subagents-extend: command blocked by the project profile: "${forbidden}" (source: ${policy.source}); extensionBindings cannot lift it.`,
				);
			}
			if (hasUnquotedShellControl(command)) {
				return deny(
					`pi-subagents-extend: shell metacharacters are not allowed (; & | < > \` $ …): run one allowlisted command. Refused: ${preview([command])} — allowed: ${preview(allEntries(rule))}`,
				);
			}
			// 前置赋值能把「被允许的命令」变成「跑我自己的代码」：`NODE_OPTIONS=--require=/tmp/x.js node`
			// 实测直接执行 /tmp/x.js，`GIT_EXTERNAL_DIFF` 对 git 同理。已知入口一律拒并点名；
			// 其余名字照常剥离放行（这一层是辅助上轨道，不是严格沙箱 —— 放行多了可以事后补）。
			const deniedEnv = deniedEnvAssignment(command);
			if (deniedEnv) {
				return deny(
					`pi-subagents-extend: bash refused: the leading assignment "${deniedEnv}=…" can change which program runs or load code into it, which would let an allowlisted command run arbitrary code. Drop it, or have the parent set it in bash.env. Refused: ${preview([command])}`,
				);
			}
			const match = classifyCommand(rule, command);
			if (!match) {
				// 模型能看见这段文案，所以把它需要的路径直接写进去，省得它再猜。
				const store = detectPnpmStore(cwd);
				const storeHint = store.path
					? ` (pnpm store at ${store.path}, not writable; the parent can add it to bash.writablePaths)`
					: "";
				// 点名被拒的**命令**，再列允许项。只印允许列表时，读起来像「列表里那条命令不被接受」：
				// 实测真有人把 `command not in the allowlist: ls` 读成「ls 被拒」，而实际拒的是别的命令。
				// 同首 token 的条目：让子代理知道**为什么**没匹配上、该改哪里。
				const headHint = headEntriesHint(rule, command, cwd);
				return bail(
					`pi-subagents-extend: command not in the allowlist: "${preview([command])}" — allowed: ${preview(allEntries(rule))} (source: ${policy.source})${storeHint}${headHint}`,
				);
			}
			// allow 列放行的写类命令，role 却没给写权限：这是写拒，计入写预算而非撞权限预算。
			// 判据是「确实有一条 allow 授权」+ 命令本身会写 + writable:false，不看 classifyCommand 报的列：
			// 同一条命令也命中 legacy 列时那列会先被报出来，但 legacy 不授予写权限。
			// classifyCommand 在 writable=false 时已把 access 压成 read，这里用固有判定（传 true）
			// 认出「这条命令本来会写」，否则它会以只读的名义被放行去写。
			if (rule.allow.some((entry) => commandMatches(entry, command)) && rule.writable === false && commandAccess(command, true) === "write") {
				return writeBail(
					`pi-subagents-extend: the role may run this command (it is in bash.allow)${match.column === "allow" ? "" : ` (matched the legacy ${match.column} column, which does not grant writes)`}, but bash.writable: false gives no write access: "${preview([command])}". This is a write refusal, not a grant error — deliver the result as a report, or have the parent set bash.writable: true.`
				);
			}
			// 只读类命令的参数路径：沙箱读面是 `/`（工具链要读 /nix/store），所以路径引导放在插件层。
			// 位置在元字符与注入型赋值之后、依赖闸门之前：前两条决定「这条命令能不能跑」，
			// 闸门判的是环境，这一条只是把参数里的路径引回范围，三者互不重叠。
			if (match.access === "read") {
				const foreign = foreignBashPath(command, cwd, rule, policy);
				if (foreign) {
					// 计入撞权限预算（bail）：父代理放宽范围就能解决，正是这一类。
					return bail(
						`pi-subagents-extend: "${foreign}" is outside the working tree (source: ${policy.source}). This is a path nudge, not a wall: the command runs in ${cwd}, and a file outside it is not yours to read — say what you need from it instead.\nWorking tree: ${cwd}`,
					);
				}
			}
			// 离线时网络是裸 netns：包被丢弃而不是被拒绝，curl 这类命令没有输出也没有错误，
			// 事后注解等不到触发文本，只能挂到超时。所以在 spawn 之前按名单拒掉确定要往返的
			// 工具；名单只收确定项，拿不准的一律放行（引导，不是沙箱边界）。
			if (rule.network !== true) {
				const networkTool = requiresNetwork(command);
				if (networkTool) {
					return bail(
						`pi-subagents-extend: the network is off per the parent's bindings — a permission, not a broken machine. \`${networkTool}\` would hang here rather than fail (packets are dropped, not refused). Ask the parent via contact_supervisor for "network": true.\n(source: ${policy.source})`,
					);
				}
			}
			// 依赖完整性闸门判的是环境，不是授权，子代理重试也不会变好，所以只拒不计。
			// 它已不再是「先于一切」的那一条：上面的路径 nudge 排在它之前，而且计入撞权限预算 ——
			// 路径出了工作树属于「授权与任务不匹配」，父代理放宽范围能解决。
			const gate = dependencyGateVerdict(rule, command, match.access, cwd);
			if (gate) return deny(gate);
			const repeatEvent = probe?.noteBashStart(command, match.access, event.toolCallId);
			if (repeatEvent) {
				return repeatEvent.stop
					? stop(repeatEvent.reason)
					: { block: true, reason: repeatEvent.reason, terminate: false };
			}
			const helper = helperPath();
			if (!helper) {
				return deny(
					"pi-subagents-extend: the sandbox helper (pi-subagents-extend-helper) was not found; run `pnpm run build:helper` in pi-plugin, or set PI_SUBAGENTS_EXTEND_HELPER.",
				);
			}
			const caps = describeHelper(helper);
			if (!caps?.landlock.supported) {
				const reason = caps?.landlock.reason ?? "helper --describe returned no usable information";
				return deny(`pi-subagents-extend: this kernel cannot enforce the task scope: ${reason}`);
			}
			const spec = buildSpec(cwd, rule, policy);
			const specFile = writeSpecFile(spec, event.toolCallId);
			if (!specFile) {
				return deny("pi-subagents-extend: cannot write the sandbox spec; check that ~/.cache/pi-subagents-extend is writable");
			}
			// 记下这条命令的写权限清单：tool_result 判「写越界」时要用它当事实依据，
			// 不靠文案猜。
			// 挡住条数上限，避免结果永远不回来的调用把表撑大。被挤出表的条目，结果按定义
			// 不会再回来，所以它的 spec 文件也得删 —— 只 delete 不删文件，「一次调用一份
			// 文件」就会变成永远堆在 ~/.cache 里的垃圾。
			if (sandboxSpecs.size >= 64) {
				const oldest = sandboxSpecs.keys().next().value as string | undefined;
				if (oldest !== undefined) {
					dropSpecFile(sandboxSpecs.get(oldest));
					sandboxSpecs.delete(oldest);
				}
			}
			// 同一个 toolCallId 又来一次（模型输出了重复 id）时，只覆盖条目、**不**删旧文件：
			// 重复 id 在真 pi 里只可能是畸形响应，我们无法判断先那次是否已经启动，删掉它就会让
			// 一个还在途的 helper 以 exit 77 死在「读不到 spec」上。留下的孤儿由 shutdown 清扫
			// 按年龄回收 —— 代价是多一份文件，和打死一条命令完全不对称。
			sandboxSpecs.set(event.toolCallId, {
				write: spec.write,
				cwd,
				command,
				offline: spec.offline,
				specFile,
			});
			(event.input as { command?: string }).command = wrapInSandbox(command, specFile, helper);
			return undefined;
		}
		if (EXEC_TOOLS.includes(event.toolName)) {
			// 从来不可用：给多宽的范围、多长的命令白名单都不会打开，所以不计入撞权限。
			return deny(
				`pi-subagents-extend: ${event.toolName} is never available in a scoped session; no grant can widen it. Use a path tool (read / write / the host's edit family) or an allowlisted bash command.`,
			);
		}
		// 路径类工具先判：它们的授权来自范围，不来自 allowTools。顺序反过来就意味着父代理
		// 一旦把名字写进 allowTools，路径判定整个被跳过——写范围在那种宿主上等于失效
		// （实测：allowTools 里写 replace 时，树外路径照写不误）。
		const kind = toolKindOf(event.toolName);
		if (kind) {
			const sessionFile =
				ctx?.sessionManager?.getSessionFile?.() ?? process.env.PI_SESSION_FILE ?? undefined;
			return pathToolVerdict(event as { toolName: string; input?: unknown }, cwd, kind, sessionFile);
		}

		// SAFE_TOOLS 已经在最前面处理过，这里只管调用方显式放行的工具。
		if (policy.allowTools.includes(event.toolName)) return undefined;

		return bail(
			`pi-subagents-extend: tool ${event.toolName} is not on the allow list (fail closed; the parent can add it to allowTools). Tools this layer already judges by scope: ${preview(Object.keys(DEFAULT_TOOL_ACCESS))}.`,
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
			// helper 只查一次：它要 fork 一个进程读 --describe。
			const helper = helperPath();
			const helperLine = policy.bash
				? `Helper: ${bashBlocker(helper) ?? helper}`
				: undefined;
			const lines = policy.active
				? [
					`Source: ${policy.source}`,
					`Mode: ${policy.readOnly ? "read-only" : "read-write"}`,
					policy.readOnly || [...policy.writeGlobs, ...policy.absoluteWrite].join("\n") === policy.globs.join("\n")
						? undefined
						: `Write scope: ${[...policy.writeGlobs, ...policy.absoluteWrite].join(" | ") || "(none)"}`,
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
					helperLine,
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
				: ["Inactive (no pi-subagents-extend bindings and no profile declared in this session)"];
			ctx.ui.notify(`pi-subagents-extend:\n${lines.join("\n")}`, "info");
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
