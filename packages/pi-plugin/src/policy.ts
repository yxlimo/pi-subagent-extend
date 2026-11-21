/**
 * POLICY / PARSE 层：把 extensionBindings 与 profile 的 permissions 配置解析成
 * `Policy`。模块拆分：实现按主题住在 `policy/` 下的三个模块里，本文件只做桶装
 * 再导出，调用方的 `from "./policy.ts"` 全部原样可用，行为不变。
 * - `policy/payload.ts`：读派单载荷 / profile 交给我们的配置对象（键白名单、fail closed）。
 * - `policy/merge.ts`：两层配置的合并（layering 规则）。
 * - `policy/glob.ts`：glob 编译与范围比对原语，以及共享类型 `Policy` / `ToolDeclaration`。
 */

export {
	BINDINGS_ENV,
	PAYLOAD_IGNORED_KEYS,
	NAMESPACE_BLOCK_KEYS,
	NAMESPACE_KEYS,
	POLICY_CONFIG_KEYS,
	asObject,
	denyAll,
	extractCallConfig,
	parsePolicyObject,
	parseToolDeclarations,
	parseWriteScope,
	positiveInt,
	unknownNamespaceKeysError,
	unknownPayloadKeysError,
} from "./policy/payload.ts";

export { mergeConfig } from "./policy/merge.ts";

export {
	compile,
	globToRegExp,
	matches,
	normalizeGlob,
	underAny,
} from "./policy/glob.ts";

export type { Policy, ToolDeclaration } from "./policy/glob.ts";
