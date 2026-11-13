/**
 * 上下文隔离：把「只给主代理看」的内容挡在子代理之外。
 *
 * 两个方向，都由项目自己的文件驱动，不引入新配置项：
 *
 * - AGENTS.md 里用 `<!-- main-only -->` … `<!-- /main-only -->` 圈出的段落，在子代理
 *   的提示词里被删掉；主代理照常读整份文件。
 * - `.pi/main-only.md` 只注入主代理的提示词，不进子代理。
 *
 * 哪一半生效取决于扩展「怎么被加载」，而不是它「猜自己是谁」：前台子代理没有
 * PI_SUBAGENT_CHILD 环境变量，和主会话无法区分。所以两个入口各管一半——
 * `main-context.ts` 走环境加载（主会话 + 后台子代理），`child-context.ts` 由 agent
 * 的 subagentOnlyExtensions 声明（只会进子代理）。
 *
 * 判据是 pi 的 systemPromptOptions.contextFiles（每项 { path, content }），在
 * before_agent_start 里改完再渲染，所以改 content 会真正影响本轮提示词。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** pi 传给 before_agent_start 的一份上下文文件。 */
export type ContextFile = { path: string; content: string };

/** 只注入主代理的文件，相对项目根。 */
export const MAIN_ONLY_FILE = ".pi/main-only.md";

/** 注入用的 section 名，同时是包住这段文字的 XML 标签。 */
const SECTION_TAG = "main_only_instructions";

/** 成对的标记块；整段连同前后空行一起删。 */
const MARKED_BLOCK = /<!--\s*main-only\s*-->[\s\S]*?<!--\s*\/main-only\s*-->\s*/g;

/** 剥完之后还剩标记，说明有一侧没闭合。 */
const ANY_MARKER = /<!--\s*\/?\s*main-only\s*-->/i;

export type StripResult = {
	/** 真正被改动过的文件数。 */
	files: number;
	/** 删掉的字符数，用来在测试和日志里确认删了东西。 */
	removedChars: number;
	/** 标记不闭合、因而没有被剥离的文件。 */
	unbalanced: string[];
};

/**
 * 就地把标记段落从上下文文件里删掉。
 *
 * 标记不闭合时整段保留：宁可让子代理多看见一段，也不要因为它猜错边界而删掉
 * 半个文件。
 */
export function stripMarkedSections(files: ContextFile[] | undefined): StripResult {
	const result: StripResult = { files: 0, removedChars: 0, unbalanced: [] };
	for (const file of files ?? []) {
		const before = file.content.length;
		file.content = file.content.replace(MARKED_BLOCK, "");
		const changed = file.content.length !== before;
		if (changed) {
			result.files += 1;
			result.removedChars += before - file.content.length;
		}
		if (ANY_MARKER.test(file.content)) result.unbalanced.push(file.path);
	}
	return result;
}

/**
 * 把项目的主代理专属文件注入提示词，返回注入的字符数（0 表示没有这个文件）。
 *
 * 用 sections 而不是整段替换 systemPrompt：pi 会按 section 做差量，改动只补一条
 * 系统消息，前面的提示词缓存仍然命中。
 */
export function injectMainOnly(options: { sections?: Record<string, string> }, cwd: string | undefined): number {
	const path = join(cwd ?? process.cwd(), MAIN_ONLY_FILE);
	let text: string;
	try {
		text = readFileSync(path, "utf8").trim();
	} catch {
		return 0;
	}
	if (!text) return 0;
	options.sections = { ...(options.sections ?? {}), [SECTION_TAG]: text };
	return text.length;
}

/**
 * 标记不闭合时给调用方一句人话（子代理和主代理的可见通道不同，由入口决定怎么报）。
 * 返回 undefined 表示不该报。
 */
export function unbalancedWarning(result: StripResult): string | undefined {
	if (!result.unbalanced.length) return undefined;
	return `${result.unbalanced.join(", ")} 里的 <!-- main-only --> 没有闭合，该段未剥离`;
}
