// 策略模块的细粒度单测：直接调用纯函数，不经过 handler、不建假 pi API、不读 bindings JSON。
//
// test/policy.test.ts 看起来在测这一层，但 93 个调用点都走 h.call，从不直接调用
// mergeConfig / parsePolicyObject / globToRegExp —— 模块故障与接线故障在那里分不开。
// src/policy/ 刚拆成 payload / merge / glob，这三个模块此前没有任何直接测试。
//
//   node test/unit/policy.unit.test.ts

import assert from "node:assert/strict";
import {
	extractCallConfig,
	globToRegExp,
	mergeConfig,
	parsePolicyObject,
} from "../../src/policy.ts";

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ok   ${label}`);
}

// bindingKey() = "pi-subagents-extend/1"（见 src/role-config.ts）。
const NS = "pi-subagents-extend/1";
/** namespace 层直接放 body（用来造「缺 permissions」的扁平载荷）。 */
const ns = (body: unknown): string => JSON.stringify({ [NS]: body });
/** namespace 层包一层 permissions（派单载荷的正确形状）。 */
const perms = (permissions: unknown): string => ns({ permissions });

// ---- mergeConfig（src/policy/merge.ts；白名单合并委托给 src/bash/rules.ts）----

// bash.allow 与 allowTools 都是并集：底层已放行的不会被这次派单删掉。
{
	const merged = mergeConfig(
		{ bash: { allow: ["a"] }, allowTools: ["x"] },
		{ bash: { allow: ["b"] }, allowTools: ["y"] },
	);
	assert.deepEqual(merged?.bash, { allow: ["a", "b"] });
	assert.deepEqual(merged?.allowTools, ["x", "y"]);
	ok("mergeConfig: bash.allow 与 allowTools 跨层并集");
}

// deny 是硬底线：两层并集，且两个方向都成立（底层独有 / 上层独有都保留）。
{
	const both = mergeConfig({ bash: { deny: ["d1"] } }, { bash: { deny: ["d2"] } });
	assert.deepEqual(both?.bash, { deny: ["d1", "d2"] });
	const baseOnly = mergeConfig({ bash: { deny: ["d1"] } }, {});
	assert.deepEqual(baseOnly?.bash, { deny: ["d1"] });
	const overOnly = mergeConfig({}, { bash: { deny: ["d2"] } });
	assert.deepEqual(overOnly?.bash, { deny: ["d2"] });
	ok("mergeConfig: deny 两层并集，两个方向都保留");
}

// scope / writeScope 是替换，不是并集：任务范围必须能比角色默认更窄。
{
	const merged = mergeConfig(
		{ scope: ["src/**"], writeScope: ["a/**"] },
		{ scope: ["docs/**"], writeScope: ["b/**"] },
	);
	assert.deepEqual(merged?.scope, ["docs/**"]);
	assert.deepEqual(merged?.writeScope, ["b/**"]);
	ok("mergeConfig: scope / writeScope 替换而非并集");
}

// 显式空列表清空该列，与「没写」不同：没写继承底层，写了空数组就是空。
{
	const absent = mergeConfig({ bash: { read: ["r"] } }, {});
	assert.deepEqual(absent?.bash, { read: ["r"] });
	const clearedRead = mergeConfig({ bash: { read: ["r"] } }, { bash: { read: [] } });
	assert.deepEqual(clearedRead?.bash, { read: [] });
	const clearedAllow = mergeConfig({ bash: { allow: ["a"] } }, { bash: { allow: [] } });
	assert.deepEqual(clearedAllow?.bash, { allow: [], write: [] });
	ok("mergeConfig: 显式空列表清空该列，缺省则继承");
}

// reset: true 让这一层「只给这些」：白名单与 allowTools 从这一层重来，deny 不清。
{
	const merged = mergeConfig(
		{ allowTools: ["x"], bash: { allow: ["a"], read: ["r"], deny: ["d1"] } },
		{ reset: true, allowTools: ["y"], bash: { allow: ["b"], deny: ["d2"] } },
	);
	assert.deepEqual(merged?.allowTools, ["y"]);
	assert.deepEqual(merged?.bash, { allow: ["b"], read: [], write: [], deny: ["d1", "d2"] });
	assert.equal(Object.prototype.hasOwnProperty.call(merged, "reset"), false);
	ok("mergeConfig: reset 清白名单与 allowTools，deny 仍并集");
}

// 标量调用方优先：这一层写了就以这一层为准。
{
	const merged = mergeConfig(
		{ readOnly: false, maxDenies: 3, maxReads: 5, probe: "base" },
		{ readOnly: true, maxDenies: 7, maxReads: 2, probe: "over" },
	);
	assert.equal(merged?.readOnly, true);
	assert.equal(merged?.maxDenies, 7);
	assert.equal(merged?.maxReads, 2);
	assert.equal(merged?.probe, "over");
	ok("mergeConfig: 标量以覆盖层为准");
}

// readOnly 且这一层没写 writeScope：写范围清空，底层那份不能抵消只读意图。
{
	const cleared = mergeConfig({ writeScope: ["a/**"] }, { readOnly: true });
	assert.deepEqual(cleared?.writeScope, []);
	const kept = mergeConfig({ writeScope: ["a/**"] }, { readOnly: true, writeScope: ["b/**"] });
	assert.deepEqual(kept?.writeScope, ["b/**"]);
	ok("mergeConfig: readOnly 清空 writeScope，同层显式写则保留");
}

// ---- extractCallConfig / parsePolicyObject（src/policy/payload.ts）----

// permissions 包装是必需的：扁平载荷整份拒绝，不落到任何策略字段。
{
	const res = extractCallConfig(ns({ scope: ["src/**"] }));
	assert.ok(res.error);
	assert.match(res.error, /missing "permissions" object/);
	assert.match(res.error, /everything is refused/);
	assert.equal(res.config, undefined);
	ok("extractCallConfig: 缺 permissions 包装的扁平载荷整份拒绝");
}

// 派单载荷里出现未知键整份拒绝，且文案点名正确拼法（write → writeScope）。
{
	const res = extractCallConfig(perms({ write: ["x"] }));
	assert.ok(res.error);
	assert.match(res.error, /"write" \(the dispatch spelling is "writeScope"\)/);
	assert.match(res.error, /everything is refused/);
	assert.equal(res.config, undefined);
	ok("extractCallConfig: 未知键整份拒绝并提示 write → writeScope");
}

// __proto__ 是普通键：既不污染原型链，也不进 config、不报错。
{
	// 手写 JSON：对象字面量里的 __proto__ 是 setter，不会成为自有键，必须绕开字面量。
	const payload =
		'{"pi-subagents-extend/1":{"permissions":{"__proto__":{"isPolluted":true},"scope":["src/**"]}}}';
	const res = extractCallConfig(payload);
	assert.equal(res.error, undefined);
	assert.equal((Object.prototype as { isPolluted?: unknown }).isPolluted, undefined);
	assert.equal(Object.prototype.hasOwnProperty.call(res.config, "__proto__"), false);
	assert.deepEqual(res.config?.scope, ["src/**"]);
	ok("extractCallConfig: __proto__ 惰性，不污染原型链");
}

// setup / output 是给别的扩展的：只报告，不进策略。
{
	const res = extractCallConfig(
		perms({ scope: ["src/**"], setup: { preExec: "x" }, output: { deliverable: "y" } }),
	);
	assert.equal(res.error, undefined);
	assert.deepEqual(res.ignored, ["setup", "output"]);
	assert.deepEqual(res.config?.scope, ["src/**"]);
	assert.equal(Object.prototype.hasOwnProperty.call(res.config, "setup"), false);
	assert.equal(Object.prototype.hasOwnProperty.call(res.config, "output"), false);
	ok("extractCallConfig: setup / output 只报告不应用");
}

// parsePolicyObject：requireScope 区分派单（必须有 scope）与 profile 默认值（可无 scope）。
{
	const required = parsePolicyObject({}, "src", { requireScope: true });
	assert.equal(required.active, true);
	assert.deepEqual(required.globs, []);
	assert.match(required.source, /scope is missing/);
	const optional = parsePolicyObject({}, "src", { requireScope: false });
	assert.deepEqual(optional.globs, []);
	assert.equal(optional.source, "src");
	ok("parsePolicyObject: requireScope 区分派单与 profile 默认值");
}


// ---- globToRegExp（src/policy/glob.ts）----

// `**` 跨目录：`**/` 吃掉零段或多段目录，裸 `**` 吃掉任意层。
{
	const nested = globToRegExp("**/foo.ts");
	assert.equal(nested.test("foo.ts"), true);
	assert.equal(nested.test("a/b/foo.ts"), true);
	const any = globToRegExp("**");
	assert.equal(any.test("a/b/c"), true);
	ok("globToRegExp: ** 跨目录");
}

// `*` 不跨目录：只匹配单段内的任意字符。
{
	const re = globToRegExp("src/*.ts");
	assert.equal(re.test("src/a.ts"), true);
	assert.equal(re.test("src/sub/a.ts"), false);
	ok("globToRegExp: * 不跨目录");
}

// `?` 恰好一个字符，且不匹配分隔符。
{
	const re = globToRegExp("a?c");
	assert.equal(re.test("abc"), true);
	assert.equal(re.test("a"), false);
	assert.equal(re.test("abcd"), false);
	assert.equal(re.test("a/c"), false);
	ok("globToRegExp: ? 匹配一个字符");
}

// 字面量 `.` 不匹配任意字符（只匹配点本身）。
{
	const re = globToRegExp("a.ts");
	assert.equal(re.test("a.ts"), true);
	assert.equal(re.test("axts"), false);
	ok("globToRegExp: 字面量 . 不匹配任意字符");
}

console.log(`\npi-subagents-extend policy unit tests passed (${passed} cases)`);
