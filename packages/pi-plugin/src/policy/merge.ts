/**
 * POLICY / MERGE：两层配置（profile 层是 `default` → 角色，派单层是合成结果 → 本次 bindings）
 * 的合并规则。语义按字段区分，细节见 `mergeConfig` 的注释；
 * policy.ts 只做桶装再导出。
 */
import { mergeBashConfig, stringList } from "../bash-match.ts";
import { asObject } from "./payload.ts";

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
