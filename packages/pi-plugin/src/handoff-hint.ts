/**
 * 交接单提示：父代理看到 worktree 交接单路径时，补一句「该看哪个键、什么已经失效」。
 *
 * 背景：pi-subagents 的 worktree 单正常收尾后，工作树与分支都会被删掉
 * （捕获补丁 → 写 handoff.json → 校验通过 → `worktree remove --force` + `branch -D`），
 * 成果只剩 patch 文件；而父代理收到的只有一行
 *   `Worktree handoff: <handoff.json> (1 children, 1 changed patches, cleanup complete)`
 * 既不说明去哪个键取货，也不说明子代理报告里的分支名/SHA 已经失效。
 *
 * 这里不重复上游的机制描述，只补这两件事。文本面向模型、英文、尽量短
 * （每次 worktree 派单都会进上下文）。
 */

/** 已经补过提示的标记，同时作为幂等判据：tool_result 与 message_end 两条路可能都命中。 */
const MARK = "[worktree handoff]"

/** `Worktree handoff: <path> (…)` / `Parallel handoff: <path>`；`… unavailable: …` 不匹配。 */
const HANDOFF_LINE = /(?:Worktree|Parallel) handoff: (\S+)/

/** 交接单写失败时上游打印的那句：此时工作树与分支都被保留，但没有任何交接单。 */
const UNAVAILABLE = /Worktree handoff unavailable/i

/** 追加的 part；字面量类型让调用方原有的 content 联合类型保持可用。 */
type TextPart = { type: "text"; text: string }

/** 从一段文本里取交接单路径；已补过提示时返回 undefined。 */
export function handoffPath(text: string): string | undefined {
	if (!text || text.includes(MARK)) return undefined
	return HANDOFF_LINE.exec(text)?.[1]
}

/** 要补的那段提示。`cleanup` 为 complete 与 partial 两种结局分别说清。 */
export function handoffHint(path: string): string {
	return [
		`${MARK} managed-worktree delivery — read ${path} before calling this delegation done.`,
		"groups[].children[].patch is the deliverable: diffStat / filesChanged / insertions are what was really produced.",
		'With cleanup "complete" the worktree and branch are already deleted, so a branch name or short SHA quoted by the child no longer resolves.',
		"Nothing was applied to this checkout; apply the patch yourself if you want the change.",
		'With cleanup "partial" the worktree was kept instead — tasks[].reason says why.',
	].join("\n")
}

/** 交接单没写成时补的提示：工作树没被删，但也没有任何记录。 */
export function unavailableHint(): string {
	return [
		`${MARK} the handoff manifest could not be written; the worktree and branch were left in place, not deleted.`,
		"Run `git worktree list` (under the configured worktree base dir) and inspect it — uncommitted work may still be there.",
	].join("\n")
}

/** 文本里出现交接单信息时给出提示文本（路径或不可用），否则 undefined。 */
export function handoffHintFor(text: string): string | undefined {
	const path = handoffPath(text)
	if (path) return handoffHint(path)
	// 已经补过提示的不再追加（路径与不可用共用同一个标记）。
	if (text.includes(MARK)) return undefined
	return UNAVAILABLE.test(text) ? unavailableHint() : undefined
}

/**
 * 把提示追加到内容里，并保持调用方的类型形状：字符串仍是字符串，
 * parts 数组变成「原元素 + 一个 text part」的元组，可以直接赋回 pi 的 content 字段。
 */
export function withHint(content: string, hint: string): string
export function withHint<T extends readonly unknown[]>(content: T, hint: string): [...T, TextPart]
export function withHint(content: string | readonly unknown[], hint: string): string | readonly unknown[] {
	if (typeof content === "string") return `${content}\n\n${hint}`
	return [...content, { type: "text", text: hint } satisfies TextPart]
}
