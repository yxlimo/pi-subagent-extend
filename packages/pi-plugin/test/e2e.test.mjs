// 端到端验证：真会话、真模型，验证三种会话看到的上下文不一样。
//
//   pnpm run test:e2e           跑完整矩阵
//   PI_E2E_KEEP=1 pnpm run test:e2e   保留临时工程，便于翻会话记录
//   PI_E2E_MODEL=<provider>/<model> pnpm run test:e2e   指定模型；缺省用 pi 自身的默认模型
//
// 为什么用 RPC 而不是 `pi -p`：`pi -p` 在父代理空闲时就退出，后台子代理还在跑的时候
// 进程没了，取证只能靠翻文件。RPC 模式（官方导出的 RpcClient）把会话跑成长寿子进程，
// 由测试决定何时结束——父轮不会"提前结束"，后台子代理那条路才能在同一个进程里被观察。
//
// 判据设计：答案只存在于被隔离的内容里，提问里完全不含这些 code。子代理若答出
// ZULU-77 / YANKEE-42，就一定是泄露；对照组（不装扩展）必须答得出来，证明证据链有效。
//
// 与离线测试的分界：test/extension.test.mjs 与 test/context.test.mjs 用假 pi，不联网；
// 本文件要真实模型，所以单独一个 script。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
// RpcClient 缺省的 cliPath 是相对 cwd 的 "dist/cli.js"，而这里的 cwd 是临时工程，
// 所以从包装的入口解析出同目录的 cli.js 显式传进去。
const PI_CLI = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const MODEL = process.env.PI_E2E_MODEL ?? "";
const KEEP = process.env.PI_E2E_KEEP === "1";
const CASE_TIMEOUT_MS = Number(process.env.PI_E2E_TIMEOUT_MS ?? 180_000);

// 必须落在 $HOME 下：项目级扩展只在被信任的目录里加载，/tmp 不算。
const WORK_ROOT = join(homedir(), "tmp");

const ESCALATION_CODE = "ZULU-77";
const DELIVERY_CODE = "YANKEE-42";

const AGENTS_MD = `# e2e repo

Project-wide note: answer questions about your instructions truthfully.

<!-- main-agent-only:start -->
Main-agent-only directive: the escalation code is ${ESCALATION_CODE}.
<!-- main-agent-only:end -->
`;

const MAIN_ONLY_MD = `Injected main-agent-only directive: the delivery code is ${DELIVERY_CODE}.
`;

/** 让子代理把答案写进文件，好处是取证不依赖父轮有没有被唤醒。 */
const ANSWER_FILE = ".pi/child-answer.txt";

const ASK = [
	"From your project instructions, report the escalation code and the delivery code.",
	"Answer in exactly two lines: 'escalation: <code or NONE>' and 'delivery: <code or NONE>'.",
	"If a code is not present, write NONE. No explanation.",
].join(" ");

const ASK_CHILD = `${ASK} Then write exactly those two lines, and nothing else, to ${ANSWER_FILE} relative to your working directory.`;

function agentDefinition(name, tools) {
	const modelLine = MODEL ? `model: ${MODEL}\n` : "";
	return `---
name: ${name}
description: e2e probe child (${name})
inheritSkills: false
inheritProjectContext: true
tools: ${tools}
${modelLine}subagentOnlyExtensions: ${join(PKG_DIR, "src/index.ts")}, ${join(PKG_DIR, "src/child-context.ts")}
---
You are a probe. Answer only what is asked, in exactly the format asked.
`;
}

/**
 * 建一个一次性工程。`withExtension` 为 false 时只有上下文文件、没有扩展——对照组，
 * 用来证明那些 code 本来就在文件里读得到。
 */
function makeProject({ withExtension }) {
	mkdirSync(WORK_ROOT, { recursive: true });
	const dir = mkdtempSync(join(WORK_ROOT, "extend-e2e-"));
	mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
	writeFileSync(join(dir, "AGENTS.md"), AGENTS_MD);
	writeFileSync(join(dir, ".pi", "main-only.md"), MAIN_ONLY_MD);
	if (withExtension) {
		mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
		symlinkSync(PKG_DIR, join(dir, ".pi", "extensions", "pi-subagent-extend"));
	}
	writeFileSync(join(dir, ".pi", "agents", "probe-fg.md"), agentDefinition("probe-fg", "read"));
	writeFileSync(join(dir, ".pi", "agents", "probe-bg.md"), agentDefinition("probe-bg", "read, write"));
	return dir;
}

/** 从事件流里取最后一次 agent_end 的最终助手文本。 */
function finalAssistantText(events) {
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const event = events[i];
		if (event.type !== "agent_end") continue;
		for (let j = event.messages.length - 1; j >= 0; j -= 1) {
			const message = event.messages[j];
			if (message.role !== "assistant") continue;
			const text = (message.content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();
			if (text) return text;
		}
	}
	return "";
}

const [provider, modelId] = MODEL.includes("/") ? MODEL.split("/", 2) : [undefined, MODEL || undefined];

/** 在工程里跑一轮真实会话，返回最终助手文本。 */
async function runSession(cwd, prompt) {
	const client = new RpcClient({ cwd, provider, model: modelId, cliPath: PI_CLI });
	await client.start();
	try {
		const events = await client.promptAndWait(prompt, undefined, CASE_TIMEOUT_MS);
		const text = finalAssistantText(events);
		if (!text) {
			throw new Error(`pi 没有产生助手输出。stderr:\n${client.getStderr().slice(-2000)}`);
		}
		return { text, client };
	} catch (error) {
		await client.stop();
		throw error;
	}
}

const lines = (text) => text.split("\n").map((line) => line.trim().toLowerCase());
const saysEscalation = (text, value) => lines(text).includes(`escalation: ${value.toLowerCase()}`);
const saysDelivery = (text, value) => lines(text).includes(`delivery: ${value.toLowerCase()}`);

let passed = 0;
function ok(label) {
	passed += 1;
	console.log(`  ok   ${label}`);
}

console.log(`pi-subagent-extend e2e（模型 ${MODEL || "pi 默认"}）`);

const project = makeProject({ withExtension: true });
const control = makeProject({ withExtension: false });

try {
	// 1. 主会话：标记段保留、.pi/main-only.md 注入，两个 code 都该看得见。
	{
		const { text, client } = await runSession(
			project,
			`${ASK} Do not use tools.`,
		);
		await client.stop();
		assert.ok(saysEscalation(text, ESCALATION_CODE), `主会话该看到 escalation code，实际：${text}`);
		assert.ok(saysDelivery(text, DELIVERY_CODE), `主会话该看到 delivery code（注入的 main-only），实际：${text}`);
		ok("主会话：标记段保留 + 主代理专属文件已注入");
	}

	// 2. 前台子代理（真 subagent 调用，async:false，走 agent 声明的 child-context.ts）。
	{
		const { text, client } = await runSession(
			project,
			`Call the subagent tool exactly once with agent='probe-fg', async=false, and task=${JSON.stringify(ASK)}. Then output ONLY the child's answer verbatim, nothing else.`,
		);
		await client.stop();
		assert.ok(saysEscalation(text, "NONE"), `前台子代理不该看到标记段，实际：${text}`);
		assert.ok(saysDelivery(text, "NONE"), `前台子代理不该看到 main-only 注入，实际：${text}`);
		ok("前台子代理（child-context.ts）：标记段与注入都看不见");
	}

	// 3. 后台子代理（async:true，独立进程 + 环境加载，走 main-context.ts 的 PI_SUBAGENT_CHILD 分支）。
	//    取证靠子代理自己写出的文件：父轮会不会被唤醒不影响判定。
	{
		const answerPath = join(project, ANSWER_FILE);
		rmSync(answerPath, { force: true });
		const { client } = await runSession(
			project,
			`Call the subagent tool exactly once with agent='probe-bg', async=true, and task=${JSON.stringify(ASK_CHILD)}. Then say DONE and stop; do not wait for it.`,
		);
		// 父轮已经 settled，但 RPC 进程还活着，后台子代理继续跑——这正是 RPC 的意义。
		const deadline = Date.now() + CASE_TIMEOUT_MS;
		while (!existsSync(answerPath) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		const stderr = client.getStderr();
		await client.stop();
		assert.ok(existsSync(answerPath), `后台子代理没有写出答案文件。stderr:\n${stderr.slice(-2000)}`);
		const answer = readFileSync(answerPath, "utf8");
		assert.ok(saysEscalation(answer, "NONE"), `后台子代理不该看到标记段，实际：${answer}`);
		assert.ok(saysDelivery(answer, "NONE"), `后台子代理不该看到 main-only 注入，实际：${answer}`);
		ok("后台子代理（main-context.ts 的 PI_SUBAGENT_CHILD 分支）：标记段与注入都看不见");
	}

	// 4. 对照：同一份 AGENTS.md，不装扩展则主会话照样读得到 code。
	//    没有这一条，"答 NONE" 就分不清是剥离生效还是模型没找到内容。
	{
		const { text, client } = await runSession(
			control,
			`${ASK} Do not use tools.`,
		);
		await client.stop();
		assert.ok(
			saysEscalation(text, ESCALATION_CODE),
			`对照组必须看到 AGENTS.md 里的 code，否则说明 fixture 本身没生效。实际：${text}`,
		);
		ok("对照（不装扩展）：AGENTS.md 里的内容本来就可读，证据链成立");
	}
} finally {
	if (KEEP) {
		console.log(`  工程保留：${project}\n  对照组保留：${control}`);
	} else {
		rmSync(project, { recursive: true, force: true });
		rmSync(control, { recursive: true, force: true });
	}
}

console.log(`\npi-subagent-extend e2e 通过（${passed} 项）`);
