/**
 * 子代理侧入口：只由 agent 定义的 `subagentOnlyExtensions` 声明，所以它一旦运行就
 * 说明当前会话是子代理——不需要判断环境变量，前台子代理（同进程、没有
 * PI_SUBAGENT_CHILD）也覆盖得到。
 *
 * 作用只有一件：把 AGENTS.md 里 `<!-- main-only -->` … `<!-- /main-only -->` 圈出的
 * 段落从本轮提示词里删掉。其余内容不动。
 *
 * agent 定义里和权限入口一起声明：
 *
 *   subagentOnlyExtensions: ~/extensions/pi-subagent-extend/packages/pi-plugin/src/index.ts, ~/extensions/pi-subagent-extend/packages/pi-plugin/src/child-context.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripMarkedSections, unbalancedWarning } from "./context-scope.ts";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const options = event.systemPromptOptions;
		if (!options) return;
		const warning = unbalancedWarning(stripMarkedSections(options.contextFiles));
		if (warning) ctx.ui?.notify?.(`pi-subagent-extend: ${warning}`, "warning");
	});
}
