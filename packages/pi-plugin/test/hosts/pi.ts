// Drives a scenario through a real pi session. The fake-tools fixture is
// deliberately absent here: the subagent call under test must reach the real
// pi-subagents tool, not a stub that shadows it.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostDriver, HostRun } from "./types.ts";

const PKG_DIR = fileURLToPath(new URL("../..", import.meta.url));
const EXT = join(PKG_DIR, "src", "index.ts");
const SUBAGENTS_BUNDLE = join(
	homedir(),
	".pi",
	"agent",
	"npm",
	"node_modules",
	"pi-subagents",
	"bundle",
	"index.js",
);
const SDK_ENTRY = import.meta.resolve("@earendil-works/pi-coding-agent");
const { RpcClient } = await import(SDK_ENTRY);
const PI_CLI = join(dirname(fileURLToPath(SDK_ENTRY)), "cli.js");

type PiPart = { type?: string; text?: string };
type PiEvent = {
	type?: string;
	message?: { role?: string; toolName?: string; content?: PiPart[] | string };
};

function toolResults(events: PiEvent[]): { tool?: string; text: string }[] {
	const out: { tool?: string; text: string }[] = [];
	for (const event of events) {
		if (event?.type !== "message_end" || event.message?.role !== "toolResult") continue;
		const content = event.message.content;
		const text = (Array.isArray(content) ? content : [])
			.map((part) => (typeof part?.text === "string" ? part.text : ""))
			.join("\n");
		out.push({ tool: event.message.toolName, text });
	}
	return out;
}

function assistantText(events: PiEvent[]): string {
	const parts: string[] = [];
	for (const event of events) {
		if (event?.type !== "message_end" || event.message?.role !== "assistant") continue;
		const content = event.message.content;
		for (const part of Array.isArray(content) ? content : []) {
			if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
		}
	}
	return parts.join("\n");
}

// A spawned session must not inherit the caller's pi identity: PI_SUBAGENT_CHILD
// alone makes pi-subagents skip registering its tools, and PI_SESSION_* would
// attach this "parent" to somebody else's session.
function hostEnv(agentDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("PI_") || key.startsWith("HERDR_")) {
			// RpcClient 用 {...process.env, ...options.env} 拼环境：这里「不带上」挡不住
			// 外层展开把键重新加回来，必须显式置 undefined 压掉——spawn 会丢弃值为
			// undefined 的键（已实测）。PI_CODING_AGENT_DIR 在循环后覆盖。
			env[key] = undefined;
			continue;
		}
		if (value !== undefined) env[key] = value;
	}
	env.PI_CODING_AGENT_DIR = agentDir;
	return env;
}

export const piDriver: HostDriver = {
	name: "pi",

	async run({ project, mockUrl, agentDir, prompt, timeoutMs }): Promise<HostRun> {
		// pi-subagents activates its tools lazily by default; a scripted parent
		// has no chance to call subagents_enable, so make them active up front.
		const configPath = join(agentDir, "extensions", "subagent", "config.json");
		mkdirSync(dirname(configPath), { recursive: true });
		if (!existsSync(configPath)) writeFileSync(configPath, JSON.stringify({ toolActivation: "eager" }));
		const client = new RpcClient({
			cwd: project,
			cliPath: PI_CLI,
			provider: "mock",
			model: "mock-1",
			env: hostEnv(agentDir),
			args: ["-e", EXT, "-e", SUBAGENTS_BUNDLE],
		});
		let stopped = false;
		const stop = async (): Promise<void> => {
			if (stopped) return;
			stopped = true;
			await client.stop();
		};

		try {
			await client.start();
			const events = (await client.promptAndWait(prompt, undefined, timeoutMs)) as PiEvent[];
			return {
				toolResults: toolResults(events),
				assistantText: assistantText(events),
				transcript: events as unknown[],
				stderr: client.getStderr(),
				stop,
			};
		} catch (error) {
			await stop();
			throw error;
		}
	},
};
