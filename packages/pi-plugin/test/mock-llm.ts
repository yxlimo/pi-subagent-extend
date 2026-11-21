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
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** 一次工具调用：名字 + 参数，序列化成 arguments 字段。 */
export interface ScriptedCall {
	name: string;
	args?: Record<string, unknown>;
}

export type ScriptedStep = { text: string; calls?: undefined } | { calls: ScriptedCall[]; text?: undefined };

/**
 * 一步脚本也可以是「看着上下文才决定」的函数。
 *
 * 为什么需要：锚点编辑工具的参数里带的是锚点，而锚点只有读过那个文件才知道。写死的脚本
 * 表达不了「先读、再把读到的锚点填进下一个调用」，于是这类工具在真会话里根本走不到
 * 第二次调用。函数式步骤拿到的是本次请求的 messages，可以从上一轮的工具结果里把锚点取出来。
 */
export type ScriptedStepFn = (messages: unknown[]) => ScriptedStep;

export type Scripted = ScriptedStep | ScriptedStepFn;

/** Fixture 版的一步回复：正文或工具调用二选一。 */
export interface FixtureReply {
	text?: string;
	calls?: { name: string; args?: Record<string, unknown> }[];
}

export interface FixtureTurn {
	reply: FixtureReply;
}

/** 会话匹配条件；两个条件都写时都要满足。 */
export interface When {
	systemPromptContains?: string;
	messagesContain?: string;
}

export interface FixtureSession {
	name: string;
	when: When;
	turns: FixtureTurn[];
}

export interface MockFixture {
	name?: string;
	model?: string;
	sessions: FixtureSession[];
}
export interface MockLlmOptions {
	steps: Scripted[];
	model?: string;
}

export interface MockLlm {
	url: string;
	port: number;
	/** 每次 /chat/completions 的请求体。 */
	requests: Record<string, unknown>[];
	/** 诊断用：每个会话键（首个 system 消息内容的哈希）消耗的轮次数。 */
	sessions: Record<string, { turnsConsumed: number }>;
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
	let cursor = 0;
	return startMockServer({
		model,
		sessions: {},
		consumed: () => cursor,
		remaining: () => Math.max(0, steps.length - cursor),
		resolve: (_body, messages) => {
			const scripted = steps[cursor];
			cursor += 1;
			// 脚本用完还来要：说明本轮的结束与否和预期不符，直接暴露。
			if (!scripted) return { error: `mock script exhausted after ${steps.length} steps` };
			const step = typeof scripted === "function" ? scripted(messages) : scripted;
			return { step };
		},
	});
}

/**
 * 按会话分流的脚本服务：会话键是首个 system 消息内容的稳定哈希，同一会话的请求
 * 只消费自己的 turns，两个会话交错到达也不会互相挪动游标。
 */
export async function startMockLlmFromFixture(fixture: MockFixture, options: { model?: string } = {}): Promise<MockLlm> {
	const validated = validateMockFixture(fixture, fixture?.name ?? "fixture");
	const label = validated.name ?? "fixture";
	const model = options.model ?? validated.model ?? "mock-1";
	const sessions: Record<string, { turnsConsumed: number }> = {};
	const assigned = new Map<string, { session: FixtureSession; cursor: number }>();
	const totalTurns = validated.sessions.reduce((sum, session) => sum + session.turns.length, 0);
	let consumed = 0;

	return startMockServer({
		model,
		sessions,
		consumed: () => consumed,
		remaining: () => Math.max(0, totalTurns - consumed),
		resolve: (body, messages) => {
			const key = conversationKey(messages);
			sessions[key] = { turnsConsumed: 0 };
			let assignment = assigned.get(key);
			if (assignment === undefined) {
				const system = systemPrompt(messages);
				const serialized = JSON.stringify(body);
				const index = validated.sessions.findIndex((session) => whenHolds(session.when, system, serialized));
				if (index < 0) return { error: unmatchedMessage(label, key, validated.sessions) };
				assignment = { session: validated.sessions[index], cursor: 0 };
				assigned.set(key, assignment);
			}
			const turn = assignment.session.turns[assignment.cursor];
			if (turn === undefined) {
				return {
					error: `mock fixture "${label}": session "${assignment.session.name}" configured ${assignment.session.turns.length} turns, but a further request arrived for conversation ${key}`,
				};
			}
			assignment.cursor += 1;
			consumed += 1;
			sessions[key].turnsConsumed = assignment.cursor;
			return { step: fixtureStep(turn.reply, messages) };
		},
	});
}

type StepResult = { step: ScriptedStep } | { error: string };

interface MockServerOptions {
	model: string;
	sessions: Record<string, { turnsConsumed: number }>;
	consumed: () => number;
	remaining: () => number;
	resolve: (body: Record<string, unknown>, messages: unknown[]) => StepResult;
}

// 两种模式共用 HTTP/流式拼装，只有「下一步回复什么」由 resolve 决定。
async function startMockServer({ model, sessions, consumed, remaining, resolve }: MockServerOptions): Promise<MockLlm> {
	const requests: Record<string, unknown>[] = [];
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
		const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
		const result = resolve(body, messages);
		if ("error" in result) {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: result.error } }));
			return;
		}
		const step = result.step;
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

	await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("the mock server did not bind a TCP port");
	const { port } = address;
	return {
		url: `http://127.0.0.1:${port}/v1`,
		port,
		requests,
		sessions,
		get consumed() {
			return consumed();
		},
		get remaining() {
			return remaining();
		},
		stop: () => new Promise<void>((done) => server.close(() => done())),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (content === undefined || content === null) return "";
	return JSON.stringify(content);
}

function conversationKey(messages: unknown[]): string {
	const first = messages.find((message) => isRecord(message) && message.role === "system");
	const content = isRecord(first) ? first.content : undefined;
	return createHash("sha256").update(contentText(content)).digest("hex").slice(0, 16);
}

function systemPrompt(messages: unknown[]): string {
	return messages
		.filter((message) => isRecord(message) && message.role === "system")
		.map((message) => contentText(isRecord(message) ? message.content : undefined))
		.join("\n");
}

function whenHolds(when: When, system: string, serialized: string): boolean {
	if (when.systemPromptContains !== undefined && !system.includes(when.systemPromptContains)) return false;
	if (when.messagesContain !== undefined && !serialized.includes(when.messagesContain)) return false;
	return true;
}

// 占位符语法（fixture 的 reply.text 里可用，详见下方 interpolate）：
//   {{lastToolResult}}  最近一次工具结果的文本；请求里没有工具结果时为空串。
//   {{toolResults}}     本次请求里所有工具结果的文本，按顺序换行拼接；没有时为空串。
// 只替换认识的占位符：写错的 {{...}} 原样留在输出里，才看得见拼写错误。
function interpolate(text: string, messages: unknown[]): string {
	let lastTool: unknown;
	const toolTexts: string[] = [];
	for (const message of messages) {
		if (!isRecord(message) || message.role !== "tool") continue;
		lastTool = message;
		toolTexts.push(contentText(message.content));
	}
	const last = lastTool === undefined ? "" : contentText(isRecord(lastTool) ? lastTool.content : lastTool);
	return text.replaceAll("{{lastToolResult}}", () => last).replaceAll("{{toolResults}}", () => toolTexts.join("\n"));
}

function fixtureStep(reply: FixtureReply, messages: unknown[]): ScriptedStep {
	if (reply.text !== undefined) return { text: interpolate(reply.text, messages) };
	return { calls: (reply.calls ?? []).map((call) => ({ name: call.name, args: call.args })) };
}

function unmatchedMessage(label: string, key: string, configured: FixtureSession[]): string {
	const list = configured
		.map((session, index) => `[${index}] "${session.name}" when=${JSON.stringify(session.when)}`)
		.join(", ");
	return `mock fixture "${label}": no session matched conversation ${key}; configured sessions: ${list || "(none)"}`;
}

function fail(source: string, path: string, message: string): never {
	throw new Error(`${source}: ${path}: ${message}`);
}

/** 校验 fixture 形状；source 出现在报错里，文件加载时传文件路径。 */
export function validateMockFixture(value: unknown, source = "fixture"): MockFixture {
	if (!isRecord(value)) fail(source, "fixture", "expected an object");
	if (value.name !== undefined && typeof value.name !== "string") fail(source, "name", "expected a string");
	if (value.model !== undefined && typeof value.model !== "string") fail(source, "model", "expected a string");
	if (!Array.isArray(value.sessions)) fail(source, "sessions", "expected an array");

	value.sessions.forEach((raw: unknown, index: number) => {
		const sessionPath = `sessions[${index}]`;
		if (!isRecord(raw)) fail(source, sessionPath, "expected an object");
		if (typeof raw.name !== "string" || raw.name.length === 0) fail(source, `${sessionPath}.name`, "expected a non-empty string");
		if (!isRecord(raw.when)) fail(source, `${sessionPath}.when`, "expected an object");
		for (const key of ["systemPromptContains", "messagesContain"] as const) {
			const predicate = raw.when[key];
			if (predicate !== undefined && typeof predicate !== "string") fail(source, `${sessionPath}.when.${key}`, "expected a string");
		}
		if (!Array.isArray(raw.turns)) fail(source, `${sessionPath}.turns`, "expected an array");

		raw.turns.forEach((turn: unknown, turnIndex: number) => {
			const turnPath = `${sessionPath}.turns[${turnIndex}]`;
			if (!isRecord(turn)) fail(source, turnPath, "expected an object");
			if (!isRecord(turn.reply)) fail(source, `${turnPath}.reply`, "expected an object");
			const reply = turn.reply;
			const hasText = reply.text !== undefined;
			const hasCalls = reply.calls !== undefined;
			if (hasText === hasCalls) {
				throw new Error(
					`${source}: ${turnPath}.reply (session "${raw.name}", turn ${turnIndex}): reply must set exactly one of "text" or "calls"`,
				);
			}
			if (hasText && typeof reply.text !== "string") fail(source, `${turnPath}.reply.text`, "expected a string");
			if (!hasCalls) return;
			if (!Array.isArray(reply.calls)) fail(source, `${turnPath}.reply.calls`, "expected an array");
			reply.calls.forEach((call: unknown, callIndex: number) => {
				const callPath = `${turnPath}.reply.calls[${callIndex}]`;
				if (!isRecord(call)) fail(source, callPath, "expected an object");
				if (typeof call.name !== "string" || call.name.length === 0) fail(source, `${callPath}.name`, "expected a non-empty string");
				if (call.args !== undefined && !isRecord(call.args)) fail(source, `${callPath}.args`, "expected an object");
			});
		});
	});
	return value as unknown as MockFixture;
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
