/**
 * 角色 md 的配置源：从 agent 定义文件的 YAML frontmatter 里读出 extend 段，
 * 转换成扩展已有的策略字段。这里只做解析与转换，不参与工具判定。
 *
 * 本阶段只接 permissions 下的 scope / write / readOnly / allowTools / budgets；
 * bash、worktree、setup、output 一律报出来而不是静默丢掉 —— 配置看起来生效其实没接线，
 * 比明确的告警难查得多。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

export const BINDING_NAMESPACE = "pi-subagents-extend";
export const BINDING_VERSION = 1;

export const bindingKey = (): string => `${BINDING_NAMESPACE}/${BINDING_VERSION}`;

/** md 基线能提供的字段，名字与现有 bindings 的策略字段对齐。 */
export interface RolePolicy {
	scope?: string[];
	writeScope?: string[];
	readOnly?: boolean;
	allowTools?: string[];
	maxDenies?: number;
	maxWriteDenies?: number;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const XML_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

/**
/**
 * 子代理提示里的 `<active_agent name="…"/>` 跟在重写后的提示后面，不一定在第一行。
 * 逐行找第一条「整行只有这个标签」的行：上下文里引用到的同类标签不能当成当前角色。
 * 属性值做过 XML 转义，找到以后再解码。
 */
export function parseRoleName(systemPrompt: string): string | null {
	for (const line of systemPrompt.split(/\r?\n/)) {
		const match = /^\s*<active_agent\s+name="([^"]*)"\s*\/>\s*$/.exec(line);
		if (!match || !match[1]) continue;
		const name = match[1].replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, code: string) => {
			if (code.startsWith("#")) {
				const hex = code[1] === "x";
				const value = Number.parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10);
				return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
			}
			return XML_ENTITIES[code] ?? whole;
		});
		return name.trim() ? name : null;
	}
	return null;
}

const MAX_MD_PARENT_LEVELS = 8;

/**
 * md 的查找目录：从会话 cwd 起逐级向上，每级先看 .pi/agents 再看 .agents，
 * 最后才是用户目录的两级。向上封顶 8 层，异常深的路径也不至于无限扫。
 */
export function agentMdDirs(cwd: string, home: string): string[] {
	const dirs: string[] = [];
	let current = resolve(cwd);
	for (let level = 0; level < MAX_MD_PARENT_LEVELS; level += 1) {
		dirs.push(join(current, ".pi", "agents"), join(current, ".agents"));
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	dirs.push(join(home, ".pi", "agent", "agents"), join(home, ".agents"));
	return dirs;
}

/** agent md 的解析顺序：项目两级在用户两级之前，逐级向上，命中即停。 */
export function resolveAgentFile(role: string, cwd: string, home: string): string | null {
	if (!role) return null;
	for (const dir of agentMdDirs(cwd, home)) {
		const file = join(dir, `${role}.md`);
		if (existsSync(file)) return file;
	}
	return null;
}

/** 读 frontmatter 里的 extend 对象；没有 frontmatter 或没有 extend 都不算问题。 */
export function readExtendBlock(file: string): { block?: Record<string, unknown>; problems: string[] } {
	const problems: string[] = [];
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		problems.push(`unable to read ${file}: ${error instanceof Error ? error.message : String(error)}`);
		return { problems };
	}
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { problems };
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end < 0) return { problems };
	let parsed: unknown;
	try {
		parsed = parse(lines.slice(1, end).join("\n"));
	} catch (error) {
		problems.push(`invalid YAML in frontmatter: ${error instanceof Error ? error.message : String(error)}`);
		return { problems };
	}
	const extend = asRecord(parsed)?.extend;
	if (extend === undefined) return { problems };
	const block = asRecord(extend);
	if (!block) {
		problems.push("extend must be an object");
		return { problems };
	}
	return { block, problems };
}

const TOP_LEVEL_KEYS = new Set(["permissions", "worktree", "setup", "output"]);
const PERMISSION_KEYS = new Set(["scope", "write", "readOnly", "allowTools", "budgets", "bash"]);

/** permissions → 现有策略字段；写错的键报出来并省掉，不让坏值混进策略。 */
export function policyFromBlock(block: Record<string, unknown>): { policy?: RolePolicy; problems: string[] } {
	const problems: string[] = [];
	const policy: RolePolicy = {};

	for (const key of Object.keys(block)) {
		if (!TOP_LEVEL_KEYS.has(key)) problems.push(`${key}: unknown block`);
		else if (key !== "permissions") problems.push(`${key}: not wired in this phase`);
	}

	const permissions = asRecord(block.permissions);
	if (block.permissions !== undefined && !permissions) {
		problems.push("permissions must be an object");
		return { policy, problems };
	}
	if (!permissions) return { policy, problems };

	const stringList = (key: "scope" | "write" | "allowTools"): string[] | undefined => {
		const value = permissions[key];
		if (value === undefined) return undefined;
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
			problems.push(`permissions.${key} must be an array of strings`);
			return undefined;
		}
		return value as string[];
	};
	const scope = stringList("scope");
	if (scope) policy.scope = scope;
	const write = stringList("write");
	if (write) policy.writeScope = write;
	const allowTools = stringList("allowTools");
	if (allowTools) policy.allowTools = allowTools;

	if (permissions.readOnly !== undefined) {
		if (typeof permissions.readOnly === "boolean") policy.readOnly = permissions.readOnly;
		else problems.push("permissions.readOnly must be a boolean");
	}
	if (permissions.bash !== undefined) problems.push("permissions.bash: bash authorization is not wired in this phase");

	for (const key of Object.keys(permissions)) {
		if (!PERMISSION_KEYS.has(key)) problems.push(`permissions.${key}: unknown key`);
	}

	const budgets = asRecord(permissions.budgets);
	if (permissions.budgets !== undefined && !budgets) {
		problems.push("permissions.budgets must be an object");
	} else if (budgets) {
		const budgetNumber = (key: "deny" | "writeDeny"): number | undefined => {
			const value = budgets[key];
			if (value === undefined) return undefined;
			if (typeof value !== "number" || !Number.isFinite(value)) {
				problems.push(`permissions.budgets.${key} must be a number`);
				return undefined;
			}
			return value;
		};
		const deny = budgetNumber("deny");
		if (deny !== undefined) policy.maxDenies = deny;
		const writeDeny = budgetNumber("writeDeny");
		if (writeDeny !== undefined) policy.maxWriteDenies = writeDeny;
	}

	return { policy, problems };
}
