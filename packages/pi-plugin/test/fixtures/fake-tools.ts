// 测试用假 SAFE_TOOLS：pi 里 contact_supervisor / structured_output 来自别的扩展，
// 单独跑本扩展时它们不存在，mock 脚本就调不动。这里注册同名工具，执行时往
// PI_MOCK_TOOL_MARKER 指的文件里追加一行，测试据此判断「求援通道真的被执行了」。

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

const marker = () => process.env.PI_MOCK_TOOL_MARKER ?? "";

function record(name: string) {
	const path = marker();
	if (path) appendFileSync(path, `${name}\n`);
}

const plain = { type: "object", properties: {}, additionalProperties: true };

const contactSupervisor = defineTool({
	name: "contact_supervisor",
	label: "Contact Supervisor",
	description: "Report a blocker or ask the parent session for a decision.",
	parameters: plain,
	async execute() {
		record("contact_supervisor");
		return { content: [{ type: "text", text: "reported" }], details: undefined };
	},
});

const structuredOutput = defineTool({
	name: "structured_output",
	label: "Structured Output",
	description: "Emit a final structured answer.",
	parameters: plain,
	async execute() {
		record("structured_output");
		return { content: [{ type: "text", text: "saved" }], details: undefined, terminate: true };
	},
});

// 假 subagent 工具：真会话里它来自 pi-subagents，worktree 单的返回值里带一行
// `Worktree handoff: <handoff.json> (…, cleanup complete)`。这里原样重现那一行，
// 用来验证本扩展的 tool_result 补丁是否真的交到了模型上下文。
const handoffPath = () =>
	process.env.PI_MOCK_HANDOFF_PATH ?? "/tmp/pi-subagents/async-subagent-runs/run-mock/handoff.json";

const fakeSubagent = defineTool({
	name: "subagent",
	label: "Subagent (fake)",
	description: "Pretend to run a worktree subagent and return its handoff reference.",
	parameters: plain,
	async execute() {
		record("subagent");
		return {
			content: [
				{
					type: "text",
					text: `child finished.\n\nWorktree handoff: ${handoffPath()} (1 children, 1 changed patches, cleanup complete)`,
				},
			],
			details: { parallelHandoff: { path: handoffPath() } },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(contactSupervisor);
	pi.registerTool(structuredOutput);
	pi.registerTool(fakeSubagent);

	// 可选：模拟 pi-subagents 的 async 完成通知（sendMessage 注入 custom 消息），
	// 用来验证 message_end 那条渠道。
	if (process.env.PI_MOCK_EMIT_HANDOFF === "1") {
		pi.on("session_start", () => {
			pi.sendMessage(
				{
					role: "custom",
					customType: "subagent-notify",
					content: [{ type: "text", text: `run finished.\n\nParallel handoff: ${handoffPath()}` }],
					display: true,
				},
				{ triggerTurn: false },
			);
		});
	}
}
