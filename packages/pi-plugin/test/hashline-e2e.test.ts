// hashline 宿主的端到端测试：真 pi 会话 + **真的 pi-hashline-edit-pro** + 本扩展。
//
// 为什么不能只靠 extension.test.ts：那边用假 pi 和假 sidecar，测的是「按我理解的宿主行为」，
// 而这一层的两个前提都是第三方的 —— 工具的参数形状，以及锚点归属记录（会话 sidecar，含一个
// sqlite 哈希库）。宿主改一次，单元测试仍然全绿，子代理却在真机上拿不到编辑能力、或者反过来
// 越界写成功。所以这里跑真宿主，判据只有一条：文件到底有没有变。
//
// 模型仍是 mock（test/mock-llm.ts），所以不需要网络，可进 CI。锚点没法写死在脚本里 ——
// 它由宿主按文件内容算出来 —— 所以第二个脚本步骤是函数式步骤，从上一轮的 read 结果里取。
//
//   pnpm run test:hashline     单独跑
//   PI_MOCK_KEEP=1 ...          保留临时工程

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockLlm } from "./mock-llm.ts";
import type { Scripted } from "./mock-llm.ts";

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const EXT = join(PKG_DIR, "src", "index.ts");
const SDK_DIR = realpathSync(join(PKG_DIR, "node_modules", "@earendil-works", "pi-coding-agent"));
const { RpcClient } = await import(new URL(`file://${join(SDK_DIR, "dist", "index.js")}`).href);
const PI_CLI = join(SDK_DIR, "dist", "cli.js");
const KEEP = process.env.PI_MOCK_KEEP === "1";
const TIMEOUT_MS = Number(process.env.PI_MOCK_TIMEOUT_MS ?? 90_000);

/**
 * 宿主扩展的入口。钉成 devDependency（package.json 里写死版本），所以 CI 一定有；
 * 缺了就直接失败 —— 这类测试一旦「装不到就跳过」，等于永远不跑，而它正是唯一能发现
 * 宿主改动的测试。
 */
function hostExtension(): string {
	const packageJson = join(PKG_DIR, "node_modules", "pi-hashline-edit-pro", "package.json");
	if (!existsSync(packageJson)) {
		throw new Error(
			"pi-hashline-edit-pro is not installed. It is a pinned devDependency of this test on purpose: " +
				"the end-to-end cases drive the real host extension. Run `pnpm install`.",
		);
	}
	const dir = realpathSync(join(PKG_DIR, "node_modules", "pi-hashline-edit-pro"));
	return join(dir, "index.ts");
}

const HOST = hostExtension();

function tempRoot(prefix: string): string {
	const base = join(homedir(), "tmp");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, prefix));
}

interface Files {
	/** 相对路径 → 内容。父目录自动创建。 */
	[name: string]: string;
}

function makeProject(files: Files): string {
	const root = tempRoot("pi-hashline-");
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

function makeAgentDir(mockUrl: string): string {
	const dir = tempRoot("pi-hashline-agent-");
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

type PiPart = { type?: string; text?: string };
type PiEvent = { type?: string; message?: { role?: string; toolName?: string; content?: PiPart[] | string } };

function textOf(message: { content?: PiPart[] | string }): string {
	if (typeof message.content === "string") return message.content;
	return (Array.isArray(message.content) ? message.content : [])
		.map((part) => (typeof part?.text === "string" ? part.text : ""))
		.join("\n");
}

function toolResults(events: PiEvent[] | undefined): { tool?: string; text: string }[] {
	const out: { tool?: string; text: string }[] = [];
	for (const event of events ?? []) {
		if (event?.type !== "message_end" || event.message?.role !== "toolResult") continue;
		out.push({ tool: event.message.toolName, text: textOf(event.message) });
	}
	return out;
}

interface RunOptions {
	steps: Scripted[];
	bindings: Record<string, unknown>;
	files: Files;
	/** 宿主的配置目录（锚点 sidecar 与哈希库都落在这里），默认临时目录。 */
	hashlineDir?: string;
}

async function run({ steps, bindings, files, hashlineDir }: RunOptions) {
	const mock = await startMockLlm({ steps });
	const project = makeProject(files);
	const agentDir = makeAgentDir(mock.url);
	const hostDir = hashlineDir ?? tempRoot("pi-hashline-cfg-");
	const client = new RpcClient({
		cwd: project,
		cliPath: PI_CLI,
		provider: "mock",
		model: "mock-1",
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify(bindings),
			// 宿主自己也认这个变量（要求绝对路径），所以它读写的 sidecar 与我们的解析落在同一处，
			// 用户真实配置一点不碰。
			PI_HASHLINE_DIR: hostDir,
		},
		args: ["-e", EXT, "-e", HOST],
	});

	try {
		await client.start();
		const events = (await client.promptAndWait("Go.", undefined, TIMEOUT_MS)) as PiEvent[];
		// 清理在 finally 里做，所以文件内容必须在这里就快照下来 —— 否则断言读到的是已删除的目录。
		const snapshot: Record<string, string> = {};
		for (const path of Object.keys(files)) snapshot[path] = readFileSync(join(project, path), "utf8");
		return {
			results: toolResults(events),
			consumed: mock.consumed,
			stderr: client.getStderr(),
			project,
			read: (path: string) => {
				const content = snapshot[path];
				if (content === undefined) throw new Error(`no such file in the project snapshot: ${path}`);
				return content;
			},
		};
	} finally {
		await client.stop();
		await mock.stop();
		if (!KEEP) {
			rmSync(project, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(hostDir, { recursive: true, force: true });
		}
	}
}

const ANCHOR_LINE = (line: string): RegExp =>
	new RegExp(`([A-Za-z0-9]{4,8})│${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

/**
 * 从动态步骤拿到的 **chat messages** 里取出某一行的锚点。
 *
 * 注意这里不是 pi 事件：函数式脚本步骤收到的是本次 /chat/completions 的 messages，
 * 也就是模型看到的东西。把它整段序列化再匹配最省事 —— 锚点由宿主按文件内容算，
 * 没法在写脚本时就填好。
 */
function anchorFromMessages(messages: unknown[], line: string): string {
	const dump = messages.map((message) => JSON.stringify(message)).join("\n");
	const match = ANCHOR_LINE(line).exec(dump);
	if (!match) {
		throw new Error(`no anchor found for ${JSON.stringify(line)} in: ${dump.slice(-800)}`);
	}
	return match[1];
}

/** 拒绝文案只可能出现在工具结果里 —— 也正是模型看到的那份。 */
function refusal(events: { results: { text: string }[] }, pattern: RegExp): string | undefined {
	return events.results.map((result) => result.text).find((text) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// 1. 范围内、只给锚点不给 path：宿主按文件内容算锚点，我们把锚点解析回文件再判。
//    这条同时钉住两件事：锚点归属真的能从宿主的 sidecar 里读出来，且判定之后编辑真的落盘。
// ---------------------------------------------------------------------------
{
	const run1 = await run({
		files: { "src/a.txt": "alpha\nbeta\ngamma\n" },
		bindings: { "pi-subagents-extend/1": { scope: ["src/**"], writeScope: ["src/**"], bash: false } },
		steps: [
			{ calls: [{ name: "read", args: { path: "src/a.txt" } }] },
			(parts: unknown[]) => {
				const anchor = anchorFromMessages(parts, "alpha");
				return { calls: [{ name: "replace", args: { remove_from: anchor, remove_to: anchor, text: "ALPHA" } }] };
			},
			{ text: "done" },
		],
	});
	assert.equal(run1.read("src/a.txt"), "ALPHA\nbeta\ngamma\n", `the anchored edit reached the disk (stderr: ${run1.stderr.slice(-400)})`);
	assert.equal(run1.consumed, 3, "the run went read → edit → closing turn");
	console.log("  ok   真宿主 + 只给锚点：目标解析出来、编辑真的落盘");
}

// ---------------------------------------------------------------------------
// 2. 锚点属于写范围之外的文件：拒绝，而且那个文件一个字节都不能变。
// ---------------------------------------------------------------------------
{
	const run2 = await run({
		files: { "src/a.txt": "alpha\n", "outside/b.txt": "secret\n" },
		bindings: {
			"pi-subagents-extend/1": { scope: ["src/**", "outside/**"], writeScope: ["src/**"], bash: false },
		},
		steps: [
			{ calls: [{ name: "read", args: { path: "outside/b.txt" } }] },
			(parts: unknown[]) => {
				const anchor = anchorFromMessages(parts, "secret");
				return { calls: [{ name: "replace", args: { remove_from: anchor, remove_to: anchor, text: "LEAKED" } }] };
			},
			{ text: "done" },
		],
	});
	assert.equal(run2.read("outside/b.txt"), "secret\n", "a write whose anchor belongs outside the write scope does not land");
	const refused = refusal(run2, /not writable|outside the scope/);
	assert.ok(refused, `the refusal reached the model; results: ${JSON.stringify(run2.results.map((r) => r.text.slice(0, 160)))}`);
	console.log("  ok   锚点属于写范围外的文件：拒绝，文件未变");
}

// ---------------------------------------------------------------------------
// 3. copy 跨文件、目标在写范围之外：拒绝，目标文件未变。
//    修复前这里会被放行 —— 两组锚点合成一组去查，返回的是源（在写范围内），目标根本没判。
// ---------------------------------------------------------------------------
{
	const run3 = await run({
		files: { "src/a.txt": "alpha\n", "outside/b.txt": "target\n" },
		bindings: {
			"pi-subagents-extend/1": { scope: ["src/**", "outside/**"], writeScope: ["src/**"], bash: false },
		},
		steps: [
			{ calls: [{ name: "read", args: { path: "src/a.txt" } }] },
			{ calls: [{ name: "read", args: { path: "outside/b.txt" } }] },
			(parts: unknown[]) => {
				const sourceAnchor = anchorFromMessages(parts, "alpha");
				const destAnchor = anchorFromMessages(parts, "target");
				return {
					calls: [
						{
							name: "copy",
							args: { source_from: sourceAnchor, source_to: sourceAnchor, anchor: destAnchor, direction: "after" },
						},
					],
				};
			},
			{ text: "done" },
		],
	});
	assert.equal(run3.read("outside/b.txt"), "target\n", "a cross-file copy does not write outside the write scope");
	const refused = refusal(run3, /not writable|outside the write scope|outside the scope/);
	assert.ok(refused, `the refusal reached the model; results: ${JSON.stringify(run3.results.map((r) => r.text.slice(0, 160)))}`);
	console.log("  ok   copy 的目标在写范围外：拒绝，目标文件未变");
}

// ---------------------------------------------------------------------------
// 4. 反向控制：copy 的源在写范围外（但可读）、目标在写范围内 → 放行，内容真的过去。
//    没有这条，上面三条都可以靠「一律拒绝」骗过去。
// ---------------------------------------------------------------------------
{
	const run4 = await run({
		files: { "src/dest.txt": "dest\n", "outside/src.txt": "payload\n" },
		bindings: {
			"pi-subagents-extend/1": { scope: ["src/**", "outside/**"], writeScope: ["src/**"], bash: false },
		},
		steps: [
			{ calls: [{ name: "read", args: { path: "outside/src.txt" } }] },
			{ calls: [{ name: "read", args: { path: "src/dest.txt" } }] },
			(parts: unknown[]) => {
				const sourceAnchor = anchorFromMessages(parts, "payload");
				const destAnchor = anchorFromMessages(parts, "dest");
				return {
					calls: [
						{
							name: "copy",
							args: { source_from: sourceAnchor, source_to: sourceAnchor, anchor: destAnchor, direction: "after" },
						},
					],
				};
			},
			{ text: "done" },
		],
	});
	assert.match(run4.read("src/dest.txt"), /payload/, `copy 只读源，源只读时仍应放行并落盘 (stderr: ${run4.stderr.slice(-400)})`);
	console.log("  ok   copy 的源只读、目标可写：放行且真的落盘");
}

// ---------------------------------------------------------------------------
// 5. copy 带**相对** path：宿主按 resolve(cwd, path) 与锚点归属比对，所以它接受这种写法。
//    本层早先拿原始字符串直比，把这种调用一律拒掉 —— 而相对写法正是模型最常给的形式。
//    这条只有真宿主能证明：单元测试里的假 API 无法验「宿主到底接不接受相对 path」。
// ---------------------------------------------------------------------------
{
	// 默认配置（requirePath 关闭）就能复现：实测 `path` 一样会到达本层 —— 把比对改回原始字符串，
	// 这条立刻转红并打印 "matches neither file"。所以不必开 requirePath，模型最常遇到的形态就是
	// 默认配置下带相对 path 的 copy。
	const run5 = await run({
		files: { "src/a.txt": "alpha\n", "src/dest.txt": "dest\n" },
		bindings: { "pi-subagents-extend/1": { scope: ["src/**"], writeScope: ["src/**"], bash: false } },
		steps: [
			{ calls: [{ name: "read", args: { path: "src/a.txt" } }] },
			{ calls: [{ name: "read", args: { path: "src/dest.txt" } }] },
			(parts: unknown[]) => {
				const sourceAnchor = anchorFromMessages(parts, "alpha");
				const destAnchor = anchorFromMessages(parts, "dest");
				return {
					calls: [
						{
							name: "copy",
							args: {
								source_from: sourceAnchor,
								source_to: sourceAnchor,
								anchor: destAnchor,
								direction: "after",
								path: "src/dest.txt",
							},
						},
					],
				};
			},
			{ text: "done" },
		],
	});
	assert.match(
		run5.read("src/dest.txt"),
		/alpha/,
		`a relative path that names the destination is accepted and the copy lands (stderr: ${run5.stderr.slice(-400)}); results: ${JSON.stringify(run5.results.map((r) => r.text.slice(0, 160)))}`,
	);
	console.log("  ok   copy 带相对 path：放行且真的落盘");
}

console.log("\npi-subagents-extend hashline e2e 测试通过（5 项）");
