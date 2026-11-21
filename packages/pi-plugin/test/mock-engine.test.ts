// Offline tests for the fixture-driven mock LLM: plain HTTP, no pi, no model.
//
//   node test/mock-engine.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMockFixture } from "./mock-fixture.ts";
import { startMockLlm, startMockLlmFromFixture } from "./mock-llm.ts";
import type { MockFixture, MockLlm } from "./mock-llm.ts";

const here = dirname(fileURLToPath(import.meta.url));

async function test(name: string, body: () => Promise<void> | void): Promise<void> {
	await body();
	console.log(`  ok   ${name}`);
}

interface RawResponse {
	status: number;
	text: string;
}

async function post(mock: MockLlm, body: Record<string, unknown>): Promise<RawResponse> {
	const response = await fetch(`${mock.url}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ stream: false, ...body }),
	});
	const text = await response.text();
	return { status: response.status, text };
}

function withSystem(prompt: string, extra: unknown[] = []): Record<string, unknown> {
	return { messages: [{ role: "system", content: prompt }, ...extra] };
}

function replyText(raw: RawResponse): string {
	assert.equal(raw.status, 200, raw.text);
	const parsed = JSON.parse(raw.text) as { choices: { message: { content: string | null } }[] };
	const content = parsed.choices[0].message.content;
	if (content === null) throw new Error(`expected a text reply, got tool calls: ${raw.text}`);
	return content;
}

function badFixture(reply: unknown, name: string): MockFixture {
	return { sessions: [{ name, when: {}, turns: [{ reply: reply as MockFixture["sessions"][number]["turns"][number]["reply"] }] }] };
}

await test("two conversations route to their own sessions regardless of request order", async () => {
	const mock = await startMockLlmFromFixture({
		name: "interleave",
		sessions: [
			{
				name: "alpha",
				when: { systemPromptContains: "ALPHA" },
				turns: [{ reply: { text: "a1" } }, { reply: { text: "a2" } }],
			},
			{
				name: "beta",
				when: { messagesContain: "BETA" },
				turns: [{ reply: { text: "b1" } }, { reply: { text: "b2" } }],
			},
		],
	});
	try {
		// A global cursor would answer a1,a2,b1,b2 instead of a1,b1,b2,a2.
		assert.equal(replyText(await post(mock, withSystem("ALPHA prompt"))), "a1");
		assert.equal(replyText(await post(mock, withSystem("BETA prompt"))), "b1");
		assert.equal(replyText(await post(mock, withSystem("BETA prompt"))), "b2");
		assert.equal(replyText(await post(mock, withSystem("ALPHA prompt"))), "a2");
		assert.equal(mock.consumed, 4);
		assert.equal(mock.remaining, 0);
		const counts = Object.values(mock.sessions).map((entry) => entry.turnsConsumed).sort((a, b) => a - b);
		assert.deepEqual(counts, [2, 2]);
	} finally {
		await mock.stop();
	}
});

await test("turns are consumed per session and exhaustion returns 500", async () => {
	const mock = await startMockLlmFromFixture({
		name: "exhaust",
		sessions: [
			{
				name: "solo",
				when: { systemPromptContains: "SOLO" },
				turns: [
					{ reply: { text: "first" } },
					{ reply: { calls: [{ name: "bash", args: { command: "ls" } }] } },
				],
			},
		],
	});
	try {
		assert.equal(replyText(await post(mock, withSystem("SOLO prompt"))), "first");
		const second = await post(mock, withSystem("SOLO prompt"));
		assert.equal(second.status, 200);
		const parsed = JSON.parse(second.text) as { choices: { message: { tool_calls: { function: { name: string } }[] } }[] };
		assert.equal(parsed.choices[0].message.tool_calls[0].function.name, "bash");

		const extra = await post(mock, withSystem("SOLO prompt"));
		assert.equal(extra.status, 500);
		assert.match(extra.text, /solo/);
		assert.match(extra.text, /2 turns/);
		assert.match(extra.text, /further request/);
	} finally {
		await mock.stop();
	}
});

await test("unmatched conversation returns 500 listing configured sessions", async () => {
	const mock = await startMockLlmFromFixture({
		name: "router",
		sessions: [
			{ name: "reviewer", when: { systemPromptContains: "REVIEW" }, turns: [{ reply: { text: "r" } }] },
			{ name: "planner", when: { messagesContain: "PLAN" }, turns: [{ reply: { text: "p" } }] },
		],
	});
	try {
		const raw = await post(mock, withSystem("UNRELATED"));
		assert.equal(raw.status, 500);
		assert.match(raw.text, /router/);
		assert.match(raw.text, /no session matched/);
		assert.match(raw.text, /reviewer/);
		assert.match(raw.text, /REVIEW/);
		assert.match(raw.text, /planner/);
		assert.match(raw.text, /PLAN/);
		assert.equal(Object.keys(mock.sessions).length, 1);
	} finally {
		await mock.stop();
	}
});

await test("last tool result placeholder is interpolated and unknown placeholders stay literal", async () => {
	const mock = await startMockLlmFromFixture({
		sessions: [
			{
				name: "tool",
				when: { systemPromptContains: "TOOL" },
				turns: [
					{ reply: { text: "seen={{lastToolResult}}/{{typo}}" } },
					{ reply: { text: "empty={{lastToolResult}}" } },
				],
			},
		],
	});
	try {
		const withTools = withSystem("TOOL", [
			{ role: "tool", content: "older" },
			{ role: "tool", content: "newer" },
		]);
		assert.equal(replyText(await post(mock, withTools)), "seen=newer/{{typo}}");
		assert.equal(replyText(await post(mock, withSystem("TOOL"))), "empty=");
	} finally {
		await mock.stop();
	}
});


await test("toolResults placeholder joins every tool result text in order", async () => {
	const mock = await startMockLlmFromFixture({
		sessions: [
			{
				name: "all-tools",
				when: { systemPromptContains: "ALLTOOLS" },
				turns: [{ reply: { text: "[{{toolResults}}]" } }, { reply: { text: "[{{toolResults}}]" } }],
			},
		],
	});
	try {
		// 两条 tool 消息之间夹一条 assistant 消息，钉住「按顺序、只取 tool 消息」。
		const withTools = withSystem("ALLTOOLS", [
			{ role: "tool", content: "first-result" },
			{ role: "assistant", content: "not a tool message" },
			{ role: "tool", content: "second-result" },
		]);
		assert.equal(replyText(await post(mock, withTools)), "[first-result\nsecond-result]");
		assert.equal(replyText(await post(mock, withSystem("ALLTOOLS"))), "[]");
	} finally {
		await mock.stop();
	}
});

await test("reply shape is validated at load time", async () => {
	assert.throws(() => loadMockFixture(badFixture({}, "empty-reply")), /empty-reply.*turn 0/);
	assert.throws(() => loadMockFixture(badFixture({ text: "x", calls: [] }, "both")), /both.*turn 0/);
	await assert.rejects(startMockLlmFromFixture(badFixture({}, "engine-empty")), /engine-empty.*turn 0/);
	await assert.rejects(startMockLlmFromFixture(badFixture({ text: "x", calls: [] }, "engine-both")), /engine-both.*turn 0/);
});

await test("YAML fixture loading reports the file and offending path", async () => {
	const dir = mkdtempSync(join(here, ".mock-fixture-"));
	try {
		const good = join(dir, "good.yaml");
		writeFileSync(
			good,
			"name: ok\nsessions:\n  - name: s\n    when:\n      systemPromptContains: X\n    turns:\n      - reply:\n          text: hello\n",
		);
		const loaded = loadMockFixture(good);
		assert.equal(loaded.name, "ok");
		assert.equal(loaded.sessions[0].turns[0].reply.text, "hello");

		const bad = join(dir, "bad.yaml");
		writeFileSync(
			bad,
			"name: yaml-case\nsessions:\n  - name: first\n    when: {}\n    turns:\n      - reply:\n          text: ok\n  - name: second\n    when: {}\n    turns:\n      - reply: {}\n",
		);
		assert.throws(
			() => loadMockFixture(bad),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				return message.includes(bad) && message.includes("sessions[1].turns[0].reply") && message.includes("second");
			},
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

await test("existing queue mode still consumes steps in order and fails loudly on exhaustion", async () => {
	const mock = await startMockLlm({
		steps: [{ text: "first" }, (messages) => ({ text: `saw ${messages.length}` })],
	});
	try {
		assert.equal(replyText(await post(mock, withSystem("Q"))), "first");
		assert.equal(replyText(await post(mock, withSystem("Q"))), "saw 1");
		assert.equal(mock.consumed, 2);
		assert.equal(mock.remaining, 0);
		assert.deepEqual(Object.keys(mock.sessions), []);
		const extra = await post(mock, withSystem("Q"));
		assert.equal(extra.status, 500);
		assert.match(extra.text, /mock script exhausted after 2 steps/);
		assert.equal(mock.requests.length, 3);
	} finally {
		await mock.stop();
	}
});

console.log("mock engine tests passed");
