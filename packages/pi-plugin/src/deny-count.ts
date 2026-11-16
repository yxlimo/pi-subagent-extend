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

	constructor(limit: number) {
		this.#limit = limit;
	}

	get count(): number {
		return this.#count;
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
				note:
					`Refusal ${this.#count} in a row — usually the grant does not fit the task. ` +
					"Use contact_supervisor to say what you need; one more ends the run.",
			};
		}
		return {
			yes: true,
			stop: true,
			// 硬停之后模型没有下一轮，这段文字的实际读者是父代理：写成诊断，而不是叮嘱。
			note:
				`Refusal ${this.#count} (criterion: denial budget): the run is over. For the parent session — ` +
				"the subagent can no longer act; re-dispatch with a wider grant if the need was not escalated.",
		};
	}

	status(): string {
		return this.#limit > 0 ? `${this.#count}/${this.#limit}` : "off";
	}
}
