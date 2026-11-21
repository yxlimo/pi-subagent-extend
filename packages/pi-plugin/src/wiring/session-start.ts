import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { DenyCounter } from "../budgets.ts";
import { PROFILE_FILE, reportUnreachableEntries, reportedUntrackedWorktreeProfiles, warnCompatLayer, warnLegacyBashColumns, warnedLegacyBashColumns } from "../notices.ts";
import { asObject, denyAll, mergeConfig, parsePolicyObject, type Policy } from "../policy.ts";
import { bindingKey } from "../role-config.ts";
import { bashBlocker, detectPnpmStore, helperPath, reportedHiddenGrants } from "../sandbox.ts";
import type { ActivateOptions, Wiring } from "./context.ts";

/**
 * session_start 的正文（逐字搬自 index.ts 的处理器）：接上本会话的 UI 提示通道、清空
 * 「只说一次」的告警护栏，按会话 cwd 解析 profile 并重算策略与预算，最后向父代理汇报
 * 生效范围。readProfile / ResolvedProfile / profilePolicy 随正文一并搬来——它们只服务
 * 这条调用链；readProfile 仍导出，因为 index.ts 的 worktreePolicyFor（派单默认值）
 * 也按角色读同一份 profile。
 */

/**
 * 读 agent 角色的默认 bindings："default" 是**所有角色的地板**，角色名那一层在它之上追加。
 * 同一次 `mergeConfig`，所以 `reset: true` 在这里同样生效：角色想比 default 更窄就写它。
 * 早先这里的注释写着「用角色名那一层覆盖」，而实现是并集 —— 文档与行为各说一套。
 * 声明了 profile 却拿不到默认值（文件缺失、JSON 坏、两个键都没有）时返回 error，
 * 由调用方转成全拒——沉默地退回不设限是最坏的降级。
 */
export function readProfile(
	cwd: string,
	name: string,
	file?: string,
): { config?: Record<string, unknown>; source: string; error?: string } {
	const path = resolve(cwd, file ?? PROFILE_FILE);
	const shown = path.startsWith(`${cwd}/`) ? relative(cwd, path) : path;
	const source = `profile ${name} (${shown})`;
	if (!existsSync(path)) return { source, error: `${source}: ${shown} not found` };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { source, error: `${source}: ${shown} is not valid JSON (${detail})` };
	}
	const table = asObject(parsed);
	if (!table) return { source, error: `${source}: ${shown} is not a JSON object` };
	if (!("default" in table) && !(name in table)) {
		return { source, error: `${source}: ${shown} has neither "default" nor "${name}"` };
	}
	const config = mergeConfig(asObject(table.default), asObject(table[name]));
	if (!config) return { source, error: `${source}: ${shown}: neither "${name}" nor "default" is an object` };
	if (Object.hasOwn(config, "permissions")) {
		return {
			source,
			error: `${source}: ${shown} is a flat per-role profile, but carries a "permissions" wrapper — that shape belongs to a dispatch payload; use the flat form instead, e.g. {"default":{"scope":["src/**"]}}; everything is refused`,
		};
	}
	return { config, source };
}

/**
 * profile 定下的策略：默认值打底，本次调用的 bindings 按字段合上去（见 `mergeConfig`）。
 * 本次 bindings 整体写坏时返回 undefined，由调用方保持全拒——不让 profile 把错误掩盖成
 * 「可用」。里面某一段（比如 `bash`）写坏时方向相同：`mergeConfig` 让那一段变成「关闭」，
 * 而不是让 profile 那一层的同名段补成「可用」。
 */
interface ResolvedProfile {
	policy: Policy;
	config?: Record<string, unknown>;
	source: string;
	broken?: boolean;
}

function profilePolicy(
	w: Wiring,
	cwd: string,
	options: ActivateOptions,
	call: Record<string, unknown> | undefined,
	callBroken: boolean,
): ResolvedProfile | undefined {
	if (!options.profileName || callBroken) return undefined;
	const resolved = readProfile(cwd, options.profileName, options.profileFile);
	if (resolved.error) return { policy: denyAll(resolved.error), source: resolved.source, broken: true };
	// 合成后的 config 会被 reset / 显式空列清掉底层的 legacy 列，只看它会漏报项目 profile 的旧拼法；
	// 每层按自己的来源告警，护栏按来源去重（同一来源一次会话只说一次）。
	warnLegacyBashColumns(resolved.config, resolved.source, w.uiWarning);
	const merged = mergeConfig(resolved.config, call) ?? {};
	// 来源要说实话：生效的规则是 profile 与本次派单**合成**的，只写 profile 会让父代理
	// 改错文件（那条授权不在 profile 里）。拒绝文案里的 `source:` 是父代理判断
	// 「该改哪个文件」的唯一线索，所以合成时必须把两层都写出来。
	const source = call ? `${resolved.source} + extensionBindings` : resolved.source;
	return { policy: parsePolicyObject(merged, source, { requireScope: false }), config: merged, source };
}

/**
 * session_start 的正文（逐字搬自 index.ts 的处理器）：profile 只在声明了它的入口里生效，
 * 所以策略重算与预算重置都走这里；options 由 activate() 传入，event 用不到但保持
 * 处理器的调用形状。
 */
export async function wireSessionStart(w: Wiring, options: ActivateOptions, _event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
	w.currentCtx = ctx;
	// 提示状态按会话重置：一个进程可能服务多个会话，模块级的 set 留到下一个会话就会把
	// 本该发出的告警吞掉（那是「lost, not duplicated」的一种，且完全没有痕迹）。
	reportedHiddenGrants.clear();
	reportedUntrackedWorktreeProfiles.clear();
	warnedLegacyBashColumns.clear();
	// UI 提示通道在这里接上会话的 ctx：`judgeToolCall` 只在工具调用时绑定，session_start
	// 里的告警要发得出去，就不能等第一次工具调用。
	w.uiWarning = (message) => {
		const ui = ctx.ui as { notify?: (m: string, t?: string) => void } | undefined;
		ui?.notify?.(message, "warning");
	};
	const cwd = ctx.cwd ?? process.cwd();
	warnCompatLayer(cwd, w.uiWarning);
	// profile 只在声明了它的入口里生效：agent 的 subagentOnlyExtensions 会加载
	// 那份两行 loader，主会话不会加载，所以主会话不会被项目默认值误锁。
	const resolved = profilePolicy(w, cwd, options, w.call.config, Boolean(w.call.error));
	if (resolved) {
		w.probe?.dispose();
		w.policy = resolved.policy;
		w.baseConfig = resolved.config;
		w.baseSource = resolved.source;
		w.baseRequireScope = false;
		w.baseBroken = resolved.broken === true;
		w.denyCounter = new DenyCounter(w.policy.maxDenies);
		w.writeDenyCounter = new DenyCounter(w.policy.maxWriteDenies, "write");
		w.allowedReads = 0;
		w.armProbe();
		w.applyRoleBaseline();
	}
	warnLegacyBashColumns(w.call.config, `extensionBindings ${bindingKey()}`, w.uiWarning);
	if (!w.policy.active) return;
	const budget = w.policy.maxReads > 0 ? `, read budget ${w.policy.maxReads}` : "";
	const bash = w.policy.bash
		? `, bash ${w.policy.bash.read.length} read / ${w.policy.bash.write.length} write`
		: ", bash off";
	const probeLine = w.probe ? ", probe on" : "";
	const storeLine = w.policy.bash ? `, pnpm store ${detectPnpmStore(cwd).path ?? "detection failed"}` : "";
	const writeGrants = [...w.policy.writeGlobs, ...w.policy.absoluteWrite];
	let mode = "read-write";
	if (w.policy.readOnly) mode = writeGrants.length > 0 ? "read-only, except the granted writes" : "read-only";
	const sameWrite = w.policy.writeGlobs.join("\n") === w.policy.globs.join("\n");
	const writeNote = sameWrite ? "" : `, write scope ${w.policy.writeGlobs.length} entries`;
	const msg = w.policy.globs.length
		? `scope active (${w.policy.source}, ${w.policy.globs.length} entries${writeNote}, ${mode}${budget}${bash}${probeLine}${storeLine})`
		: `scope is empty: every file access is refused${budget}${bash}${probeLine}${storeLine}`;
	ctx.ui.notify(`pi-subagents-extend: ${msg}`, "info");
	// 只在该会话真的会跑 bash 时才喊：父会话没 bindings 时 bash 不受管，不必打扰。
	if (w.policy.bash) {
		const blocker = bashBlocker(helperPath());
		if (blocker) ctx.ui.notify(`pi-subagents-extend: ${blocker}`, "warning");
		// 授权写了却永远命中不了：告诉父代理一次（走 UI，不进模型上下文）。
		reportUnreachableEntries(w.policy.bash, cwd, w.uiWarning);
	}
}
