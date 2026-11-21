/**
 * BUDGETS 层：拒绝预算 —— 连续拒绝对计数器与它的缺省值。计数器自己合成两类拒绝的出路
 * 文案（授权不够去求援，写范围不够改回报告）；index.ts 只做接线。
 * 模块拆分第五步：DenyCounter 从 deny-count.ts 原样搬入，缺省预算从 policy.ts 原样搬入，
 * 行为不变；policy.ts 反过来从本模块导入缺省值，依赖方向无环。
 */

/**
 * 撞权限判据：连续被范围规则拒绝 maxDenies 次，多半是父代理的授权写错了，不是子代理
 * 走错了目录。计满后第一次给 warn 级拒绝（要求向父代理报告缺什么），再撞一次就停。
 */

export interface DenyCountResult {
	/** 是否要交给调用方拒绝这次调用。 */
	yes: boolean;
	/** 拒绝文案；undefined 表示这次拒绝不用附加探针提示。 */
	note?: string;
	/** 停止本轮。 */
	stop: boolean;
}

export class DenyCounter {
	#limit: number;
	#count = 0;
	#warned = false;
	/**
	 * 两类拒绝的出路不同：授权不够要去求援，写范围不够要改成回报告。文案必须分开，
	 * 否则子代理会把「这里写不了」当成「授权配错了」，继续换个路径试。
	 */
	#kind: "grant" | "write";

	constructor(limit: number, kind: "grant" | "write" = "grant") {
		this.#limit = limit;
		this.#kind = kind;
	}

	get count(): number {
		return this.#count;
	}

	/**
	 * 一次放行的调用：连续计数归零（warned 一起归零，否则清零后第一次警告会被吃掉）。
	 *
	 * 文档、skill 和拒绝文案承诺的都是「连续 N 次」；不在这里清零，早期一次误判会一直带到最后，
	 * 硬停一次就丢掉整轮任务 —— 正是这条判据本来要避免的事。
	 */
	reset(): void {
		this.#count = 0;
		this.#warned = false;
	}

	/** 一次被范围规则拒绝。 */
	record(): DenyCountResult {
		if (this.#limit <= 0) return { yes: false, stop: false };
		this.#count += 1;
		if (this.#count < this.#limit) return { yes: false, stop: false };
		if (!this.#warned) {
			this.#warned = true;
			return {
				yes: true,
				stop: false,
				note: this.#kind === "write"
					? `Write refusal ${this.#count} in a row — the write scope does not cover this path, ` +
						"and it will not change. Deliver the finding as a report; one more refusal ends the run."
					: `Refusal ${this.#count} in a row — usually the grant does not fit the task. ` +
						"Use contact_supervisor to say what you need; one more ends the run.",
			};
		}
		return {
			yes: true,
			stop: true,
			// 硬停之后模型没有下一轮，这段文字的实际读者是父代理：写成诊断，而不是叮嘱。
			note: this.#kind === "write"
				? `Write refusal ${this.#count} (criterion: write budget): the run is over. For the parent session — ` +
					"the subagent kept writing outside writeScope; a report is the intended deliverable, " +
					"or re-dispatch with a wider writeScope."
				: `Refusal ${this.#count} (criterion: denial budget): the run is over. For the parent session — ` +
					"the subagent can no longer act; re-dispatch with a wider grant if the need was not escalated.",
		};
	}

	status(): string {
		return this.#limit > 0 ? `${this.#count}/${this.#limit}` : "off";
	}
}

/** 撞权限的缺省预算；两处都要用，所以提出来。 */
export const DEFAULT_MAX_DENIES = 5;
export const DEFAULT_MAX_WRITE_DENIES = 2;
