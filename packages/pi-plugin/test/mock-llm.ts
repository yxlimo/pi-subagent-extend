// 一个只依赖 node 标准库的 OpenAI 兼容 mock 服务，用来在测试里替代真实 LLM。
//
// 为什么需要它：扩展的行为（越界拒绝、停机、求援通道）只有在**真 pi 会话**里才完整
// 走一遍 tool_call → 拦截 → 批次结算 → 是否结束本轮。真实模型既不能确定性地触发
// 指定边界，又会把测试变成网络依赖。mock 服务把「模型说什么」变成一段脚本，于是
// 「本轮有没有继续」有了确定判据：脚本队列里下一步有没有被消费。
//
// 用法：
//   const mock = await startMockLlm({ steps: [{ calls: [{ name: "read", args: { path: "x" } }] }] });
//   // ... 指向 mock.url 跑 pi ...
//   mock.requests   // 每次 /chat/completions 的请求体，用来断言 pi 真的没有再问下一轮
//   await mock.stop();

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

/** 一次工具调用：名字 + 参数，序列化成 arguments 字段。 */
export interface ScriptedCall {
	name: string;
	args?: Record<string, unknown>;
}

export type ScriptedStep = { text: string; calls?: undefined } | { calls: ScriptedCall[]; text?: undefined };

export interface MockLlmOptions {
	steps: ScriptedStep[];
	model?: string;
}

export interface MockLlm {
	url: string;
	port: number;
	/** 每次 /chat/completions 的请求体。 */
	requests: Record<string, unknown>[];
	readonly consumed: number;
	readonly remaining: number;
	stop(): Promise<void>;
}

type FinishReason = "stop" | "tool_calls" | null;

/**
 * 一步脚本：
 *   { text: "..." }                          助手回一段文本（finish_reason: stop）
 *   { calls: [{ name, args }] }              助手发起工具调用（finish_reason: tool_calls）
 * 队列耗尽后服务返回 500，让「pi 多问了一轮」变成显式失败而不是静默通过。
 */
export async function startMockLlm({ steps, model = "mock-1" }: MockLlmOptions): Promise<MockLlm> {
	const requests: Record<string, unknown>[] = [];
	let cursor = 0;

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method === "GET" && url.pathname.endsWith("/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model", owned_by: "mock" }] }));
			return;
		}
		if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${url.pathname}` } }));
			return;
		}

		const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
		requests.push(body);
		const step = steps[cursor];
		cursor += 1;
		if (!step) {
			// 脚本用完还来要：说明本轮的结束与否和预期不符，直接暴露。
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `mock script exhausted after ${steps.length} steps` } }));
			return;
		}

		if (body.stream === false) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(nonStreaming(step, model)));
			return;
		}
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		writeStream(res, step, model);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("the mock server did not bind a TCP port");
	const { port } = address;
	return {
		url: `http://127.0.0.1:${port}/v1`,
		port,
		requests,
		get consumed() {
			return cursor;
		},
		get remaining() {
			return Math.max(0, steps.length - cursor);
		},
		stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function chunk(delta: Record<string, unknown>, finishReason: FinishReason = null, model = "mock-1"): Record<string, unknown> {
	return {
		id: "chatcmpl-mock",
		object: "chat.completion.chunk",
		created: 1_700_000_000,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

function writeStream(res: ServerResponse, step: ScriptedStep, model: string): void {
	const send = (payload: Record<string, unknown>): boolean => res.write(`data: ${JSON.stringify(payload)}\n\n`);

	if (step.text !== undefined) {
		send(chunk({ role: "assistant", content: step.text }, null, model));
		send(chunk({}, "stop", model));
	} else {
		const toolCalls = (step.calls ?? []).map((call: ScriptedCall, index: number) => ({
			index,
			id: `call_mock_${index}`,
			type: "function",
			function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
		}));
		send(chunk({ role: "assistant", tool_calls: toolCalls }, null, model));
		send(chunk({}, "tool_calls", model));
	}
	res.write("data: [DONE]\n\n");
	res.end();
}

function nonStreaming(step: ScriptedStep, model: string): Record<string, unknown> {
	const base = { id: "chatcmpl-mock", object: "chat.completion", created: 1_700_000_000, model };
	if (step.text !== undefined) {
		return {
			...base,
			choices: [{ index: 0, message: { role: "assistant", content: step.text }, finish_reason: "stop" }],
		};
	}
	return {
		...base,
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: null,
					tool_calls: (step.calls ?? []).map((call: ScriptedCall, index: number) => ({
						id: `call_mock_${index}`,
						type: "function",
						function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
					})),
				},
				finish_reason: "tool_calls",
			},
		],
	};
}
