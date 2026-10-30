/**
 * 探针：检测子代理的无效工作，warn → abort 两级停机。
 *
 * 四条判据（全部可选，零配置不激活）：
 * 1. 只读空转：idleWriteMs 内没有任何「写入活动」→ warn；再过 abortGraceMs → abort。
 *    「写入活动」只算 edit/write 工具调用与命中 bash write 列的命令；read 列的 bash
 *    与 read/grep/find/ls 一律不算，否则拿 bash 只读打转就绕过了这条判据。
 * 2. 原地打转：同一条 bash 命令原文重复 repeatBash 次 → warn；再多一次 → abort。
 * 3. 早可收工：bash 输出命中 successPatterns 后起 successIdleMs 计时，期间无写入活动 → abort。
 * 4. 造杂物：write/edit 目标路径命中 forbidWritePatterns → 直接拒绝。
 *
 * warn 的载体是「拦截下一次 tool_call」：定时器到点自己拦不了正在跑的调用，边界才是
 * 能保证模型看到文案的地方。abort 用 ctx 的 abort()，不等边界。
 */

import type { BashRule } from "./bash-match.ts";

export interface ProbeConfig {
	idleWriteMs: number;
	abortGraceMs: number;
	repeatBash: number;
	successIdleMs: number;
	successPatterns: string[];
	forbidWritePatterns: string[];
}

export const DEFAULT_PROBE: ProbeConfig = {
	idleWriteMs: 6 * 60 * 1000,
	abortGraceMs: 2 * 60 * 1000,
	repeatBash: 3,
	successIdleMs: 5 * 60 * 1000,
	successPatterns: ["fail=0", "0 failed", "0 failing", "all tests passed"],
	forbidWritePatterns: [],
};

export interface ProbeEvent {
	/** 命中判据时给模型看的文案。 */
	reason: string;
	/** warn 之外还要做的事：停掉本轮。 */
	stop: boolean;
}

export interface ProbeHooks {
	/** 停机：由调用方桥接到 ctx.actions.abort()。 */
	abort: () => void;
	warn: (text: string) => void;
}

export interface ProbeHost {
	setTimeout: (fn: () => void, ms: number) => unknown;
	clearTimeout: (handle: unknown) => void;
	now: () => number;
}

/**
 * 一条判据的时窗状态：armed 时，下一个 tool 边界把 warn 抛给模型；到 abortAt 仍没
 * 恢复就停。
 */
interface Window {
	/** 还没在边界上抛给模型。 */
	armed: boolean;
	/** 已经抛过，等宽限到期。 */
	warned: boolean;
	message: string;
	abortAt: number;
}

function nonNegativeInt(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function patternList(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return fallback;
	return (value as unknown[])
		.filter((v): v is string => typeof v === "string" && v.trim() !== "")
		.map((v) => v.trim());
}

/**
 * 解析 bindings 的 probe 字段。
 *
 * 打转与撞权限是纯错误信号，默认开启；时间基判据（只读空转、早可收工）会误伤
 * 慢任务，必须由父代理显式配置。没有 probe 字段时，时间判据的阈值取 0 = 关闭。
 */
export function parseProbeConfig(raw: unknown): ProbeConfig | undefined {
	if (raw === false) return undefined;
	if (raw === undefined) return { ...DEFAULT_PROBE, idleWriteMs: 0, abortGraceMs: 0, successIdleMs: 0 };
	if (raw === true) return DEFAULT_PROBE;
	if (typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_PROBE;
	const cfg = raw as Record<string, unknown>;
	// `{}` = 全部默认值；只写部分字段时，没写的那些保持关闭（0）。
	const blank = Object.keys(cfg).length === 0;
	const pick = (value: unknown, fallback: number) => {
		if (blank) return fallback;
		if (value === undefined) return 0;
		return nonNegativeInt(value, fallback);
	};
	return {
		idleWriteMs: pick(cfg.idleWriteMs, DEFAULT_PROBE.idleWriteMs),
		abortGraceMs: pick(cfg.abortGraceMs, DEFAULT_PROBE.abortGraceMs),
		repeatBash: Math.max(2, nonNegativeInt(cfg.repeatBash, DEFAULT_PROBE.repeatBash)),
		successIdleMs: pick(cfg.successIdleMs, DEFAULT_PROBE.successIdleMs),
		successPatterns: patternList(cfg.successPatterns, DEFAULT_PROBE.successPatterns),
		forbidWritePatterns: patternList(cfg.forbidWritePatterns, []),
	};
}

function compilePatterns(patterns: string[]): { source: string; re: RegExp }[] {
	const out: { source: string; re: RegExp }[] = [];
	for (const p of patterns) {
		try {
			out.push({ source: p, re: new RegExp(p) });
		} catch {
			// 写坏的模式跳过（不因此误伤所有写入）。
		}
	}
	return out;
}

function matchesAny(patterns: string[], text: string): string | undefined {
	for (const p of patterns) {
		try {
			if (new RegExp(p).test(text)) return p;
		} catch {
			// 忽略坏模式
		}
	}
	return undefined;
}

export interface ProbeDeps {
	config: ProbeConfig;
	/** bash 读写归类；没有 bash 规则时传 undefined。 */
	bashRule?: BashRule;
	/** 只读任务（pi-allow-reads 的 readOnly）：跳过判据 1 与 3。 */
	readOnly: boolean;
	hooks: ProbeHooks;
	host?: ProbeHost;
	/** 写入活动间隔超过这个值就 warn/abort（缺省 clamp 到一个合理下限，便于测试缩短）。 */
}

const MIN_IDLE_MS = 1000;
const BASH_TEXT_LIMIT = 24_000;

/**
 * 探针实例。调用方在 tool_call / tool_result / session_shutdown 上转发事件。
 */
export class Probe {
	#cfg: ProbeConfig;
	#bashRule?: BashRule;
	#readOnly: boolean;
	#hooks: ProbeHooks;
	#host: ProbeHost;
	#timers = new Set<unknown>();
	#idleTimer?: unknown;
	#successTimer?: unknown;
	#idle: Window = { armed: false, warned: false, message: "", abortAt: 0 };
	#repeat: Window = { armed: false, warned: false, message: "", abortAt: 0 };
	#bashCounts = new Map<string, number>();
	#forbidPatterns: { source: string; re: RegExp }[];
	#stopped = false;
	#successArmed = false;

	constructor(deps: ProbeDeps) {
		this.#cfg = deps.config;
		this.#bashRule = deps.bashRule;
		this.#readOnly = deps.readOnly;
		this.#hooks = deps.hooks;
		this.#host = deps.host ?? defaultHost();
		this.#forbidPatterns = compilePatterns(deps.config.forbidWritePatterns);
		this.#startIdleTimer();
	}

	get config(): ProbeConfig {
		return this.#cfg;
	}

	/** 有写入活动：重置空转计时器，清掉已武装的 warn。 */
	noteWriteActivity(): void {
		if (this.#stopped) return;
		this.#idle = { armed: false, warned: false, message: "", abortAt: 0 };
		this.#disarmSuccess();
		this.#startIdleTimer();
	}

	/** bash 命令进入：判据 2 计数；命中 write 列时也记为写入活动。 */
	noteBashStart(command: string, access: "read" | "write" | undefined): ProbeEvent | undefined {
		if (this.#stopped) return undefined;
		if (access === "write") this.noteWriteActivity();
		const key = command.trim();
		if (!key) return undefined;
		const count = (this.#bashCounts.get(key) ?? 0) + 1;
		this.#bashCounts.set(key, count);
		if (count === this.#cfg.repeatBash) {
			const message =
				`同一条 bash 命令已经重复 ${count} 次（判据：原地打转）：${key.slice(0, 160)}。` +
				`再重复一次就停止本轮——换一种做法，或者直接把当前结论汇报给父代理。`;
			this.#repeat = {
				armed: true,
				warned: true,
				message,
				abortAt: this.#host.now() + this.#cfg.abortGraceMs,
			};
			// 第 N 次直接拦下这次调用并给 warn：放行到下一次就没机会说了。
			this.#hooks.warn(message);
			return { reason: message, stop: false };
		}
		if (count > this.#cfg.repeatBash) {
			return {
				reason:
					`同一条 bash 命令已重复 ${count} 次（判据：原地打转）：${key.slice(0, 160)}。停止本轮，` +
					"把「反复尝试了什么、卡在哪、需要父代理提供什么」写清楚作为最终汇报。",
				stop: true,
			};
		}
		return undefined;
	}

	/** bash 输出：判据 3 的成功标记。 */
	noteBashResult(output: string): void {
		if (this.#stopped || this.#readOnly) return;
		const text = output.length > BASH_TEXT_LIMIT ? output.slice(-BASH_TEXT_LIMIT) : output;
		const hit = matchesAny(this.#cfg.successPatterns, text);
		if (!hit) return;
		this.#startSuccessTimer(hit);
	}

	/** write/edit 目标路径：判据 4。命中返回拒绝事件。 */
	checkWriteTarget(path: string): ProbeEvent | undefined {
		if (this.#stopped) return undefined;
		for (const p of this.#forbidPatterns) {
			if (p.re.test(path)) {
				return {
					reason:
						`pi-allow-reads: 不允许把 "${path}" 写进仓库（判据：造杂物，命中 forbidWritePatterns "` +
						`${p.source}"）。这是调试/临时产物，不要留在工作区；需要临时文件就写到 /tmp。`,
					stop: false,
				};
			}
		}
		return undefined;
	}

	/** tool 边界：把已武装的 warn 抛给模型；宽限走完就停。 */
	atToolBoundary(): ProbeEvent | undefined {
		if (this.#stopped) return undefined;
		const now = this.#host.now();
		const expired = [this.#idle, this.#repeat].find((w) => w.warned && now >= w.abortAt);
		if (expired) {
			this.#stopped = true;
			this.#clearTimers();
			return {
				reason: `${expired.message}（宽限已到期，停止本轮：把已完成的改动、当前状态、卡住的点写清楚作为最终汇报）`,
				stop: true,
			};
		}
		const armed = [this.#repeat, this.#idle].find((w) => w.armed);
		if (armed) {
			armed.armed = false;
			armed.warned = true;
			this.#hooks.warn(armed.message);
			return { reason: armed.message, stop: false };
		}
		return undefined;
	}

	/** 定时器到点：空转的 warn 与 abort 都不依赖 tool 边界。 */
	#fireIdle(): void {
		if (this.#stopped) return;
		if (!this.#idle.armed) {
			this.#idle = {
				armed: true,
				warned: false,
				message:
					`已经有 ${ms(this.#cfg.idleWriteMs)} 没有写入任何文件，也没有跑过可写的 bash 命令（判据：只读空转）。` +
					"读到的东西够了就直接动手改；确实需要更多上下文就先写给父代理说明卡点。",
				abortAt: this.#host.now() + this.#cfg.abortGraceMs,
			};
			this.#idleTimer = this.#schedule(() => this.#fireIdleAbort(), this.#cfg.abortGraceMs);
			return;
		}
		this.#fireIdleAbort();
	}

	#fireIdleAbort(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#clearTimers();
		this.#hooks.warn(
			`pi-allow-reads: 只读空转超过 ${ms(this.#cfg.idleWriteMs + this.#cfg.abortGraceMs)} 没有写入，已停止本轮。` +
				"请把「已确认的事实、下一步打算改动什么、为什么一直没动手」写清楚作为最终汇报。",
		);
	}

	#startIdleTimer(): void {
		if (this.#readOnly || this.#cfg.idleWriteMs < MIN_IDLE_MS) return;
		this.#clearIdleTimer();
		this.#idleTimer = this.#schedule(() => this.#fireIdle(), this.#cfg.idleWriteMs);
	}

	#startSuccessTimer(marker: string): void {
		if (this.#cfg.successIdleMs < MIN_IDLE_MS) return;
		this.#disarmSuccess();
		this.#successArmed = true;
		this.#successTimer = this.#schedule(() => {
			if (this.#stopped) return;
			this.#stopped = true;
			this.#clearTimers();
			this.#hooks.warn(
				`pi-allow-reads: 验证已经通过（命中的成功标记："${marker}"），之后 ${ms(this.#cfg.successIdleMs)} 没有任何新改动` +
					"（判据：早可收工），已停止本轮。直接汇报结果收工。",
			);
		}, this.#cfg.successIdleMs);
	}

	#disarmSuccess(): void {
		if (this.#successTimer !== undefined) {
			this.#host.clearTimeout(this.#successTimer);
			this.#successTimer = undefined;
		}
		this.#successArmed = false;
	}

	#schedule(fn: () => void, ms: number): unknown {
		const handle = this.#host.setTimeout(() => {
			this.#timers.delete(handle);
			fn();
		}, ms);
		this.#timers.add(handle);
		return handle;
	}

	#clearIdleTimer(): void {
		if (this.#idleTimer !== undefined) {
			this.#host.clearTimeout(this.#idleTimer);
			this.#timers.delete(this.#idleTimer);
			this.#idleTimer = undefined;
		}
	}

	#clearTimers(): void {
		for (const handle of this.#timers) this.#host.clearTimeout(handle);
		this.#timers.clear();
		this.#idleTimer = undefined;
		this.#successTimer = undefined;
	}

	/** 会话结束：清定时器，避免残留。 */
	dispose(): void {
		this.#stopped = true;
		this.#clearTimers();
	}

	/** 诊断用：当前状态。 */
	status(): string[] {
		const lines = [
			`只读空转: ${this.#readOnly ? "不适用（只读任务）" : this.#cfg.idleWriteMs > 0 ? `${ms(this.#cfg.idleWriteMs)} + 宽限 ${ms(this.#cfg.abortGraceMs)}` : "关闭"}`, 
			`原地打转: 同一命令第 ${this.#cfg.repeatBash} 次警告、第 ${this.#cfg.repeatBash + 1} 次停止（已记录 ${this.#bashCounts.size} 条命令）`,
			`早可收工: ${this.#readOnly ? "不适用（只读任务）" : `${ms(this.#cfg.successIdleMs)} 无新改动即停止`}`,
			`造杂物: ${this.#forbidPatterns.length} 条禁用路径模式`,
			`状态: ${this.#stopped ? "已停止" : "运行中"}${this.#successArmed ? "（成功标记已命中）" : ""}`,
		];
		return lines;
	}
}

function ms(value: number): string {
	if (value >= 60_000) {
		const m = value / 60_000;
		return `${Number.isInteger(m) ? m : m.toFixed(1)} 分钟`;
	}
	return `${Math.round(value / 1000)} 秒`;
}

function defaultHost(): ProbeHost {
	return {
		setTimeout: (fn, delay) => {
			const h = setTimeout(fn, delay);
			// 定时器不该把进程留住。
			if (typeof (h as { unref?: () => void }).unref === "function") (h as { unref: () => void }).unref();
			return h;
		},
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		now: () => Date.now(),
	};
}
