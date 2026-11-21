import { DenyCounter } from "../budgets.ts";
import { bindingKey, type RolePolicy } from "../role-config.ts";
import { BINDINGS_ENV, denyAll, extractCallConfig, parsePolicyObject, type Policy } from "../policy.ts";
import { Probe, parseProbeConfig } from "../probe.ts";

/** agent 角色的默认 bindings 名与 profile 文件路径，由宿主入口（profile()）传入。 */
export interface ActivateOptions {
	/** agent 角色的默认 bindings 名；由 profile() 传入。 */
	profileName?: string;
	/** profile 文件路径，默认 .pi/subagent-bindings.json（相对会话 cwd）。 */
	profileFile?: string;
}

/** 未配置时的策略：全拒、只读、不计数。与 denyAll 的「坏了」不同，这是「没配」。 */
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

/**
 * activate() 的全部可变会话状态。七个事件处理器原本直接读 activate 闭包里的
 * 这批变量；收进一个对象，是为了让处理器可以逐个搬出 index.ts 而不带走闭包。
 * 字段初始化就是 activate() 原来的声明序（见 createWiring）。
 */
export interface WiringState {
	/**
	 * bindings 在激活时定格：前台子代理的 bindings 环境变量只在会话启动前存在，
	 * tool_call 里读不到，必须在这里取。profile 的文件反过来——要按会话 cwd 读，
	 * 所以在 session_start 里解析。
	 */
	call: ReturnType<typeof extractCallConfig>;
	policy: Policy;
	/** 角色 md 的基线：before_agent_start 里按子代理身份填入，只补 bindings / profile 没给的字段。 */
	roleBaseline: RolePolicy | undefined;
	roleSource: string | undefined;
	roleResolved: boolean;
	/**
	 * before_agent_start 可能在 preExec 等待期间再次触发；同一个键的发射者 await 在飞的接线，
	 * 不同键（另一个子会话）各走各的。失败时 finally 删键，下一轮可重试，不缓存 rejected promise。
	 */
	roleWirings: Map<string, Promise<void>>;
	baseConfig: Record<string, unknown> | undefined;
	baseSource: string;
	baseRequireScope: boolean;
	baseBroken: boolean;
	/** toolCallId → 这次 bash 的 spec 摘要（写清单、cwd、是否离线）。 */
	sandboxSpecs: Map<
		string,
		{ write: string[]; cwd: string; offline: boolean; command: string; specFile?: string }
	>;
	denyCounter: DenyCounter;
	/** 写拒单独计数：写拒的正解是换交付方式（回报告），跟「授权写错」不是一类信号。 */
	writeDenyCounter: DenyCounter;
	allowedReads: number;
	/**
	 * 停机是硬停：每个被拦的结果都带 terminate，pi 在整批结果都 terminating 时结束本轮
	 * （docs/extensions.md："terminate only applies to a blocked call; the agent stops early
	 * only when every finalized result in the batch is terminating"）。停止后整批都会被拦，
	 * 所以不留「一切都拒绝、模型还在反复试」的软状态。
	 */
	stopped: boolean;
	currentCtx: { cwd?: string; actions?: unknown; ui?: unknown } | undefined;
	probe: Probe | undefined;
	/**
	 * UI 提示通道：这条告警是给父代理看的配置问题，不该写进模型上下文，所以只走 UI
	 * （ctx.ui.notify）。session_start / judgeToolCall / before_agent_start 每次拿到
	 * 自己的 ctx 时覆盖写入，最近一次写入的生效——告警跟着最新的事件上下文走。
	 */
	uiWarning?: (message: string) => void;
}

/** 状态加上三个改状态的方法：处理器读字段、调方法，不再碰闭包。 */
export interface Wiring extends WiringState {
	stop(reason: string): { block: true; reason: string; terminate: true };
	/** 按当前 policy 建探针。profile 要到 session_start 才读出，所以这里可重跑。 */
	armProbe(): void;
	/**
	 * bindings / profile 已经有值的键优先，md 基线只填缺失的那几个
	 * （scope、writeScope、readOnly、allowTools、maxDenies、maxWriteDenies）。
	 */
	applyRoleBaseline(): void;
}

/**
 * 逐字搬自 activate() 的声明段：先取 call、按坏/好分支定 policy、
 * 再建两个计数器，最后 armProbe()。顺序与条件都保持原样。
 */
export function createWiring(): Wiring {
	const call = extractCallConfig(process.env[BINDINGS_ENV]);
	let policy: Policy = INACTIVE;
	if (call.error) {
		policy = denyAll(call.error);
	} else if (call.config) {
		policy = parsePolicyObject(call.config, `extensionBindings ${bindingKey()}`, { requireScope: true });
	}
	const wiring: Wiring = {
		call,
		policy,
		roleBaseline: undefined,
		roleSource: undefined,
		roleResolved: false,
		roleWirings: new Map<string, Promise<void>>(),
		baseConfig: call.config,
		baseSource: `extensionBindings ${bindingKey()}`,
		baseRequireScope: Boolean(call.config),
		baseBroken: Boolean(call.error),
		sandboxSpecs: new Map<
			string,
			{ write: string[]; cwd: string; offline: boolean; command: string; specFile?: string }
		>(),
		denyCounter: new DenyCounter(policy.maxDenies),
		writeDenyCounter: new DenyCounter(policy.maxWriteDenies, "write"),
		allowedReads: 0,
		stopped: false,
		currentCtx: undefined,
		probe: undefined,
		stop(reason: string) {
			this.stopped = true;
			// 详细理由只回给触发停机的那一次；后续调用拿 stopNotice，见 activate 里的 stopNotice 注释。
			return { block: true, reason, terminate: true } as const;
		},
		armProbe(): void {
			const probeCfg = parseProbeConfig(this.policy.probe);
			this.probe =
				this.policy.active && probeCfg
					? new Probe({
						config: probeCfg,
						readOnly: this.policy.readOnly,
						hooks: {
							warn: (text) => {
								const ui = this.currentCtx?.ui as { notify?: (m: string, t?: string) => void } | undefined;
								ui?.notify?.(`pi-subagents-extend: ${text}`, "warning");
							},
						},
					})
					: undefined;
		},
		applyRoleBaseline(): void {
			if (this.baseBroken || !this.roleBaseline || Object.keys(this.roleBaseline).length === 0) return;
			// 上层自己写了 readOnly 且没写 writeScope：写范围就是空的（与 mergeConfig 同语义），
			// md 不能把写授权重新放出来。
			const readOnlyWithoutWrite = Object.hasOwn(this.baseConfig ?? {}, "readOnly") && this.baseConfig?.readOnly === true && !Object.hasOwn(this.baseConfig ?? {}, "writeScope");
			const fields: Record<string, unknown> = { ...(this.baseConfig ?? {}) };
			let mdContributed = false;
			for (const [key, value] of Object.entries(this.roleBaseline)) {
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
			const mdLabel = this.roleSource ?? "role md";
			const source = this.baseConfig ? `${this.baseSource} + ${mdLabel}` : mdLabel;
			this.probe?.dispose();
			this.policy = parsePolicyObject(fields, source, { requireScope: this.baseRequireScope });
			this.denyCounter = new DenyCounter(this.policy.maxDenies);
			this.writeDenyCounter = new DenyCounter(this.policy.maxWriteDenies, "write");
			this.armProbe();
		},
	};
	wiring.armProbe();
	return wiring;
}
