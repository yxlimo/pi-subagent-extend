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
					`这是第 ${this.#count} 次撞到任务范围的边界。连续被拒通常说明父代理给的授权与任务不匹配，` +
					"而不是你走错了地方：停止继续试探，把「我需要访问什么、为什么任务需要它」直接写进最终汇报交给父代理。",
			};
		}
		return {
			yes: true,
			stop: true,
			note:
				`第 ${this.#count} 次被拒（判据：撞权限）。本轮到此停止——把已完成的部分、缺的权限、下一步打算都写清楚，` +
				"作为最终汇报交给父代理，由它重新派单。",
		};
	}

	status(): string {
		return this.#limit > 0 ? `${this.#count}/${this.#limit}` : "关闭";
	}
}
