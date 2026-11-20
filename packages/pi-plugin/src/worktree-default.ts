/**
 * 给派单调用补 worktree 默认值。
 *
 * 这不是授权层：策略说某个角色默认用工作树时，只在调用方没表态时填一个 true，
 * 不拦调用、不计数。显式 false 是调用方主动要求共享工作树，必须原样保留。
 */

/** pi-subagents 的两种派单工具：外层 subagent 与工作流里的嵌套 subagent_launch。 */
export const WORKTREE_TOOLS = new Set(["subagent", "subagent_launch"]);

/**
 * 该不该把 `input.worktree` 填成 true。
 *
 * 判据只有三条：策略确实是 true、工具是派单工具、调用方没给值。`??=` 把
 * `null` / `undefined` 都算「没给」，所以这里同样处理；其它值（尤其是显式
 * `false`）一律不动。策略解析不到时返回 false（fail open）。
 */
export function shouldDefaultWorktree(
	policy: { worktree?: unknown } | undefined,
	toolName: string,
	input: unknown,
): boolean {
	if (policy?.worktree !== true || !WORKTREE_TOOLS.has(toolName)) return false;
	if (!input || typeof input !== "object" || Array.isArray(input)) return false;
	const supplied = (input as { worktree?: unknown }).worktree;
	return supplied === undefined || supplied === null;
}
