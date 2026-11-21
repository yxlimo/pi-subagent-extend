/**
 * POLICY / PARSE 层：把 extensionBindings 与 profile 的 permissions 配置解析成
 * `Policy`，以及范围匹配的原语（glob 编译、realpath 比对、绝对授权前缀匹配）。
 * 这一层是纯函数，不持有会话状态；index.ts 只做接线。
 * 模块拆分第一步：以下声明从 index.ts 原样搬出，行为不变。
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { mergeBashConfig, parseBashRule, stringList, type BashRule } from "./bash-match.ts";
import { DEFAULT_MAX_DENIES, DEFAULT_MAX_WRITE_DENIES } from "./budgets.ts";
import { BINDING_NAMESPACE, bindingKey } from "./role-config.ts";
import { canonical } from "./paths.ts";

export const BINDINGS_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";

/**
 * 一个工具的类别声明。
 *
 * `access` 缺省时沿用 `DEFAULT_TOOL_ACCESS` 里按名字给的值；`path` 缺省时从工具自己的
 * 入参 schema 里找（`pathArgFromSchema`），找不到就当 `path`。
 */
export interface ToolDeclaration {
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
export function parseToolDeclarations(value: unknown): {
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

export interface Policy {
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


/**
 * bindings 存在但无法使用时的策略：会话保持活跃，但什么都拿不到。
 *
 * 预算用缺省值而不是 0：0 表示「永不计数」，那会让一次写坏的绑定变成无限重试的会话 ——
 * 每个调用都被拒、却永远不会停，正是这条判据要避免的状态。拒几次就硬停，父代理能从拒绝
 * 文案里看到真实原因（哪一份绑定、哪里写错）。
 */
export function denyAll(source: string): Policy {
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
export function globToRegExp(glob: string): RegExp {
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
export function normalizeGlob(glob: string): string {
	const raw = glob.length > 1 ? glob.replace(/\/+$/, "") || "/" : glob;
	return raw === "." ? "**" : raw.replace(/^\.\//, "");
}

/**
 * 展开目录语义后编译。"dir/**" 额外匹配 "dir" 本身；不含通配符的纯路径额外
 * 匹配 "dir/**"，所以范围写 "src" 就覆盖 src 及其下所有内容。
 */
export function compile(globs: string[]): RegExp[] {
	const expanded = new Set<string>();
	for (const glob of globs) {
		const g = normalizeGlob(glob);
		expanded.add(g);
		if (g.endsWith("/**")) expanded.add(g.slice(0, -3) || "/");
		else if (!/[*?]/.test(g)) expanded.add(`${g}/**`);
	}
	return [...expanded].map(globToRegExp);
}

export function positiveInt(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** `extensionBindings` 里的这两个键属于角色 md，不该影响本次派单的策略。 */
export const PAYLOAD_IGNORED_KEYS = ["setup", "output"] as const;

/** 命名空间层站在 permissions 旁边的块级键；不进策略，交给 worktree 决策。 */
export const NAMESPACE_BLOCK_KEYS = ["worktree"] as const;
/** 命名空间层能识别的全部键；其余键一律拒绝，免得拼写错误被静默忽略。 */
export const NAMESPACE_KEYS = ["permissions", ...NAMESPACE_BLOCK_KEYS, ...PAYLOAD_IGNORED_KEYS] as const;
/** 从 PI_SUBAGENT_EXTENSION_BINDINGS 里取本扩展的 namespace 配置对象；版本不匹配一律拒绝。 */
interface CallConfigResult {
	config?: Record<string, unknown>;
	/** 命名空间层的块级键（如 worktree），不属于 permissions 策略。 */
	blocks?: Record<string, unknown>;
	error?: string;
	/** 命名空间层或 permissions 层出现的、必须只告警一次的键。 */
	ignored?: string[];
}

/**
 * 派单载荷 permissions 里出现 parsePolicyObject 不认识的键时的拒绝文案。
 * `write` / `budgets` 是角色 md 的拼法，这里点名正确的派单拼法，避免用户照 md 抄过来被静默丢弃。
 */
export function unknownPayloadKeysError(keys: readonly string[], prefix: string): string {
	const hints: Record<string, string> = {
		write: 'the dispatch spelling is "writeScope"',
		budgets: 'the dispatch spelling is "maxReads" / "maxDenies"',
	};
	const listed = keys
		.map((key) => (hints[key] ? `"${key}" (${hints[key]})` : `"${key}"`))
		.join(", ");
	return `${prefix}.permissions: unknown key(s) ${listed}; everything is refused`;
}

export function unknownNamespaceKeysError(keys: readonly string[], prefix: string): string {
	const listed = keys.map((key) => `"${key}"`).join(", ");
	const accepted = NAMESPACE_KEYS.map((key) => `"${key}"`).join(", ");
	return `${prefix}: unknown namespace key(s) ${listed}; accepted namespace keys are ${accepted}; everything is refused`;
}

export function extractCallConfig(raw: string | undefined): CallConfigResult {
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
	const namespace = cfg as Record<string, unknown>;
	const expected = `{"extensionBindings":{"${key}":{"permissions":{"scope":["src/**"]}}}}`;
	// 派单载荷和角色 md 的 extend.permissions 是同一个对象；扁平写法不是「少一层语法糖」，
	// 而是另一份契约。放过它会在用户照文档写对时反而拒绝，所以这里只认一层 permissions。
	if (!Object.hasOwn(namespace, "permissions")) {
		return {
			error: `extensionBindings ${key}: missing "permissions" object; the namespace key must contain a permissions object; expected ${expected}; everything is refused`,
		};
	}
	const perms = asObject(namespace.permissions);
	if (!perms) {
		return {
			error: `extensionBindings ${key}.permissions must be an object; expected ${expected}; everything is refused`,
		};
	}
	// 命名空间层只认 permissions / 块级键 / 忽略对；多出来的键直接拒绝，不让拼写错误藏在这里。
	const unknownNamespace = Object.keys(namespace).filter(
		(name) => !(NAMESPACE_KEYS as readonly string[]).includes(name),
	);
	if (unknownNamespace.length > 0) {
		return { error: unknownNamespaceKeysError(unknownNamespace, `extensionBindings ${key}`) };
	}
	const config: Record<string, unknown> = Object.create(null);
	const unknown: string[] = [];
	for (const [name, value] of Object.entries(perms)) {
		// setup / output 是给别的扩展的，本扩展不参与，只告警一次。
		if ((PAYLOAD_IGNORED_KEYS as readonly string[]).includes(name)) continue;
		// 原型键不是声明：Object.create(null) 让它成为普通键，这里直接跳过，不进 config 也不报错。
		if (name === "__proto__") continue;
		if ((POLICY_CONFIG_KEYS as readonly string[]).includes(name)) {
			config[name] = value;
		} else {
			unknown.push(name);
		}
	}
	if (unknown.length > 0) {
		return { error: unknownPayloadKeysError(unknown, `extensionBindings ${key}`) };
	}
	const blocks: Record<string, unknown> = Object.create(null);
	for (const name of NAMESPACE_BLOCK_KEYS) {
		if (Object.hasOwn(namespace, name)) blocks[name] = namespace[name];
	}
	const ignored = PAYLOAD_IGNORED_KEYS.filter(
		(name) => Object.hasOwn(namespace, name) || Object.hasOwn(perms, name),
	);
	return { config, blocks, ignored: [...ignored] };
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
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
	// 掩盖成「可用」，正是 profilePolicy 注释里说的那种掩盖。
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
export function parseWriteScope(
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

/**
 * parsePolicyObject 认识的配置键。派单载荷的 permissions 对象只认这些键，
 * 其余键由 extractCallConfig 在入口拒绝（见 unknownPayloadKeysError），避免
 * 「拼错的收窄字段被静默丢弃」——丢弃一个写范围收窄会把写授权放大到整个读范围。
 */
export const POLICY_CONFIG_KEYS = [
	"scope",
	"writeScope",
	"readOnly",
	"tools",
	"allowTools",
	"bash",
	"probe",
	"maxReads",
	"maxDenies",
	"maxWriteDenies",
	// 不是策略字段：mergeConfig 用它表达「这一层只给这些」，消费后删除。
	"reset",
] as const;

export function parsePolicyObject(
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


/** 目标是否落在某个范围里：相对路径与绝对路径都试，scope 写哪种都认。 */
export function matches(regexps: RegExp[], cwd: string, target: string): boolean {
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
export function underAny(grants: string[], cwd: string, target: string): boolean {
	if (grants.length === 0) return false;
	const abs = canonical(resolve(cwd, target));
	for (const grant of grants) {
		if (abs === grant) return true;
		if (abs.startsWith(grant.endsWith(sep) ? grant : `${grant}${sep}`)) return true;
	}
	return false;
}
