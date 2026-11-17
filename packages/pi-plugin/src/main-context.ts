/**
 * 主代理侧入口：装上就能用，`pi` 自动加载它（`package.json` 的 pi.extensions）。
 *
 * 两个方向各管一段路：
 *
 * - 主会话：把 `.pi/main-only.md` 作为 section 注入提示词。项目里没这个文件就什么
 *   都不做。
 * - 后台子代理：它们加载同一份环境扩展，所以这里必须把标记段剥回去，否则主代理
 *   专属内容会顺着环境扩展漏进子代理。
 *
 * 前台子代理不加载环境扩展，因此不会走到这里——它们靠 `child-context.ts`。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { injectMainOnly, stripMarkedSections, unbalancedWarning } from "./context-scope.ts";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		const options = event.systemPromptOptions;
		if (!options) return;

		if (process.env.PI_SUBAGENT_CHILD === "1") {
			const warning = unbalancedWarning(stripMarkedSections(options.contextFiles));
			if (warning) ctx.ui?.notify?.(`pi-subagents-extend: ${warning}`, "warning");
			return;
		}

		injectMainOnly(options, ctx.cwd);
	});
}
