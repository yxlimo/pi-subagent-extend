// 用 mock LLM 驱动**真 pi 会话**，验证扩展在真运行时的边界行为。
//
// 与 extension.test.mjs 的分界：那边用假 pi，只测本扩展自己的判定；
// 这边走真 pi 的 tool_call → 拦截 → 批次结算 → 是否结束本轮，只是「模型说什么」由
// test/mock-llm.mjs 的脚本决定。判据因此是确定的：脚本队列里下一步有没有被消费。
//
// 与 test/e2e.test.mjs（真实 LLM）的分界：这里不需要任何模型与网络，可进 CI。
//
//   pnpm run test:mock        单独跑
//   PI_MOCK_KEEP=1 ...        保留临时工程，便于翻会话记录

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockLlm } from "./mock-llm.mjs";

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const EXT = join(PKG_DIR, "src", "index.ts");
const FAKE_TOOLS = join(PKG_DIR, "test", "fixtures", "fake-tools.ts");
const SDK_DIR = realpathSync(join(PKG_DIR, "node_modules", "@earendil-works", "pi-coding-agent"));
const { RpcClient } = await import(new URL(`file://${join(SDK_DIR, "dist", "index.js")}`).href);
const PI_CLI = join(SDK_DIR, "dist", "cli.js");
const KEEP = process.env.PI_MOCK_KEEP === "1";
const TIMEOUT_MS = Number(process.env.PI_MOCK_TIMEOUT_MS ?? 60_000);
const MARKER = "DONE";

/**
 * 临时根。放在 ~/tmp 下而不是 os.tmpdir()，是为了和手动实验分开；
 * 但那个目录可能不存在（被清过、或干净机器上），所以先建再 mkdtemp。
 */
function tempRoot(prefix) {
	const base = join(homedir(), "tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, prefix));
}

/** 一个最小工程：src/a.ts 在范围内，outside.md 在范围外。 */
function makeProject() {
	const root = tempRoot("pi-mock-");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "a.ts"), "export const ok = 1;\n");
	writeFileSync(join(root, "outside.md"), "outside the task scope\n");
	return root;
}

/** 隔离的 agent 目录：models.json 把 provider `mock` 指到 mock 服务，不碰用户配置。 */
function makeAgentDir(mockUrl) {
	const dir = tempRoot("pi-mock-agent-");
	writeFileSync(
		join(dir, "models.json"),
		JSON.stringify(
			{
				providers: {
					mock: {
						baseUrl: mockUrl,
						api: "openai-completions",
						apiKey: "mock-key",
						models: [{ id: "mock-1", contextWindow: 128_000, maxTokens: 8192 }],
					},
				},
			},
			null,
			2,
		),
	);
	return dir;
}

/** 跑一个用例：mock 脚本 + 范围绑定 → 真 pi 会话 → 事件与 mock 请求。 */
async function run({ steps, bindings, prompt = "Go.", extraEnv = {} }) {
	const mock = await startMockLlm({ steps });
	const project = makeProject();
	const agentDir = makeAgentDir(mock.url);
	const markerPath = join(agentDir, "tool-marker.txt");
	const client = new RpcClient({
		cwd: project,
		cliPath: PI_CLI,
		provider: "mock",
		model: "mock-1",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify(bindings),
			PI_MOCK_TOOL_MARKER: markerPath,
			...extraEnv,
		},
		args: ["-e", EXT, "-e", FAKE_TOOLS],
	});

	try {
		await client.start();
		const events = await client.promptAndWait(prompt, undefined, TIMEOUT_MS);
		const results = toolResults(events);
		return {
			events,
			results,
			requests: mock.requests,
			consumed: mock.consumed,
			assistantText: assistantText(events),
			marker: existsSync(markerPath) ? readFileSync(markerPath, "utf8").trim().split("\n") : [],
			stderr: client.getStderr(),
			project,
		};
	} finally {
		await client.stop();
		await mock.stop();
		if (!KEEP) {
			rmSync(project, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	}
}

/** 工具结果以 message_end + role=toolResult 到达。 */
function toolResults(events) {
	const out = [];
	for (const event of events ?? []) {
		if (event?.type !== "message_end") continue;
		const message = event.message;
		if (message?.role !== "toolResult") continue;
		const text = (Array.isArray(message.content) ? message.content : [])
			.map((part) => (typeof part?.text === "string" ? part.text : ""))
			.join("\n");
		out.push({ tool: message.toolName, text });
	}
	return out;
}

function assistantText(events) {
	const parts = [];
	for (const event of events ?? []) {
		if (event?.type !== "message_end" || event.message?.role !== "assistant") continue;
		for (const part of event.message.content ?? []) {
			if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
		}
	}
	return parts.join("\n");
}

const SCOPE = { "pi-subagent-extend/1": { scope: ["src/**"] } };

// 1. 两次越界读完 → 硬停：第二次拒绝带 denial budget，且脚本第三段（收尾文本）没有被消费。
{
	const run1 = await run({
		steps: [
			{ calls: [{ name: "read", args: { path: "outside.md" } }] },
			{ calls: [{ name: "read", args: { path: "outside.md" } }] },
			{ text: MARKER },
		],
		bindings: { "pi-subagent-extend/1": { scope: ["src/**"], maxDenies: 1 } },
	});
	const denials = run1.results.filter((r) => /outside this task's scope|denial budget/.test(r.text));
	assert.equal(denials.length, 2, `two refusals expected, saw ${denials.length}. stderr: ${run1.stderr.slice(-500)}`);
	assert.match(denials[0].text, /outside this task's scope/, "the first refusal names the scope boundary");
	assert.match(denials[0].text, /Do not retry/, "the first refusal is actionable");
	assert.match(denials[1].text, /denial budget/, "the second refusal names the stop criterion");
	assert.equal(run1.consumed, 2, "the run ended: the mock never served a third turn");
	assert.equal(run1.assistantText.includes(MARKER), false, "no closing assistant turn after the hard stop");
	console.log("  ok   两次越界 → 硬停（mock 只被请求 2 次，没有收尾回合）");
}

// 2. 求援通道：同一批里 contact_supervisor + 越界读 → 求援被执行，越界被拒，本轮继续。
//    这正是真实模型很难稳定制造的场景，也是 SAFE_TOOLS 必须排在最前的原因。
{
	const run2 = await run({
		steps: [
			{
				calls: [
					{ name: "contact_supervisor", args: { message: "blocked" } },
					{ name: "read", args: { path: "outside.md" } },
				],
			},
			{ text: MARKER },
		],
		bindings: SCOPE,
	});
	assert.deepEqual(run2.marker, ["contact_supervisor"], "the rescue tool really executed");
	assert.equal(
		run2.results.some((r) => /outside this task's scope/.test(r.text)),
		true,
		"the out-of-scope read was still refused",
	);
	assert.equal(run2.consumed, 2, "the batch was not all-terminating, so the run continued");
	assert.match(run2.assistantText, new RegExp(MARKER), "and the model got its next turn");
	console.log("  ok   同批求援 + 越界 → 求援放行，本轮继续");
}

// 3. 对照组：范围内的读放行，证明上面的拒绝来自范围判定，不是一切都拒。
{
	const run3 = await run({
		steps: [{ calls: [{ name: "read", args: { path: "src/a.ts" } }] }, { text: MARKER }],
		bindings: SCOPE,
	});
	assert.equal(run3.results.length, 1, "exactly one tool result");
	assert.equal(
		/outside this task's scope|denial budget/.test(run3.results[0].text),
		false,
		`in-scope read must pass, got: ${run3.results[0].text.slice(0, 200)}`,
	);
	assert.equal(run3.consumed, 2, "the run continued to the closing turn");
	console.log("  ok   范围内读放行（对照组）");
}

// 4. A1 的原始场景：停机理由不能被当成对当前调用的判定。
//    batch1: 越界读（第 1 次 = warn）+ 求援 → 本轮继续；
//    batch2: 越界读（第 2 次 = 停机）+ 求援 → 求援放行，整批不全 terminating，本轮仍继续；
//    batch3: 读一个**范围内**的文件 → 应拿到停机理由（历史路径 outside.md），而不是对 src/a.ts 的判定。
{
	const run4 = await run({
		steps: [
			{
				calls: [
					{ name: "read", args: { path: "outside.md" } },
					{ name: "contact_supervisor", args: { message: "first" } },
				],
			},
			{
				calls: [
					{ name: "read", args: { path: "outside.md" } },
					{ name: "contact_supervisor", args: { message: "second" } },
				],
			},
			{ calls: [{ name: "read", args: { path: "src/a.ts" } }] },
			{ text: MARKER },
		],
		bindings: { "pi-subagent-extend/1": { scope: ["src/**"], maxDenies: 1 } },
	});
	const denials = run4.results.filter((r) => /outside this task's scope|denial budget/.test(r.text));
	assert.equal(denials.length, 3, `expected warn, stop, then the latched stop; saw ${denials.length}`);
	assert.match(denials[1].text, /denial budget/, "the second denial is the stop");
	const latched = denials[2].text;
	assert.match(latched, /denial budget/, "the post-stop call reports the stop reason");
	assert.equal(latched.includes("src/a.ts"), false, "it does not blame the current (in-scope) call");
	assert.match(latched, /outside\.md/, "it carries the historical cause instead");
	assert.equal(run4.consumed, 3, "the run ended at the latched stop, no closing turn");
	console.log("  ok   停机后对范围内文件的调用拿到的是停机理由（A1 回归）");
}

// 5. 交接单提示（前台）：worktree 单返回 handoff 路径时，提示必须真的进模型上下文，
//    而不只是落在事件流里。
{
	const handoffPath = "/tmp/pi-subagents/async-subagent-runs/run-mock/handoff.json";
	const run5 = await run({
		steps: [{ calls: [{ name: "subagent", args: {} }] }, { text: MARKER }],
		bindings: { "pi-subagent-extend/1": { scope: ["src/**"], allowTools: ["subagent"] } },
		extraEnv: { PI_MOCK_HANDOFF_PATH: handoffPath },
	});
	const result = run5.results.find((r) => r.tool === "subagent");
	assert.ok(result, `the fake subagent ran. stderr: ${run5.stderr.slice(-400)}`);
	assert.match(result.text, /\[worktree handoff\]/, "the hint is appended to the real tool result");
	assert.match(result.text, /children\[\]\.patch/, "the hint names the key to read");
	assert.ok(result.text.includes(handoffPath), "the hint carries the manifest path");
	const context = JSON.stringify(run5.requests.at(-1) ?? {});
	assert.match(context, /\[worktree handoff\]/, "the hint reached the model context, not just the event");
	console.log("  ok   交接单提示（前台）进了模型上下文");
}

// 6. 交接单提示（后台）：async 通知由 sendMessage 注入会话，走 context 在请求前补上。
{
	const handoffPath = "/tmp/pi-subagents/async-subagent-runs/run-mock-2/handoff.json";
	const run6 = await run({
		steps: [{ text: MARKER }],
		bindings: SCOPE,
		extraEnv: { PI_MOCK_EMIT_HANDOFF: "1", PI_MOCK_HANDOFF_PATH: handoffPath },
	});
	const context = JSON.stringify(run6.requests);
	assert.match(context, /\[worktree handoff\]/, "the injected notification reached the model with the hint");
	assert.ok(context.includes(handoffPath), "and with the manifest path");
	console.log("  ok   交接单提示（后台）经 context 进了模型上下文");
}

console.log("pi-subagent-extend mock 会话测试通过（6 项）");
