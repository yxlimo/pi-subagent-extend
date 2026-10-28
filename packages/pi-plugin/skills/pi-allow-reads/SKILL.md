---
name: pi-allow-reads
description: 委派 pi-subagents 子代理并限定其任务范围时使用。写明如何通过 extensionBindings（namespace pi-allow-reads/1）把子代理可读可写的文件限制在指定范围内，范围外的所有 tool_call 一律被拒绝。
---

# pi-allow-reads：给子代理限定任务范围

委派子代理时通过 `extensionBindings` 传入本次任务的范围。子代理会话里，范围之外的所有 tool_call 一律被拒绝（fail closed）：防止子代理漫无目的地扫仓库。

## 前置条件

被委派的 agent 必须能加载本扩展，二选一：

- agent 定义 frontmatter 里声明 `subagentOnlyExtensions: /home/shay/extensions/pi-allow-reads/packages/pi-plugin/src/index.ts`（前台、后台子代理都生效，推荐）；
- 扩展已全局安装（`~/.pi/agent/extensions/pi-allow-reads`）且本次委派 `async: true`（后台子代理才走 ambient discovery）。

扩展没加载时 bindings 传了也没用，拦截不会发生。

## 调用模板

```
subagent(
  agent: "<agent-name>",
  task: "<任务描述>",
  extensionBindings: { "pi-allow-reads/1": { "scope": ["<文件/目录 glob>", "..."] } }
)
```

namespace 固定为 `pi-allow-reads/1`。每次委派都要传，scope 按本任务实际涉及的文件/目录收窄，不要默认给整个仓库。

## bindings 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `scope` | `string[]` | 必填。任务范围的 glob 列表；空数组 = 拒绝一切文件访问 |
| `readOnly` | `boolean` | 默认 `false`；`true` 时范围内也禁止 `edit`/`write`，适合只读的调研、评审代理 |
| `maxReads` | `number` | 可选。成功 `read` 次数上限，超限后所有 read 被拒绝 |
| `allowTools` | `string[]` | 可选。额外放行的工具名；`bash` 等执行器类无法放行 |

glob：`**` 任意层目录、`*` 单层内任意字符、`?` 单字符。范围写 `src` 或 `src/**` 都覆盖该目录本身及其下所有内容。

## 生效后的规则

- 范围内：`read`/`edit`/`write`/`grep`/`find`/`ls` 放行（`readOnly` 时 `edit`/`write` 拒绝）。
- 一律拒绝：`bash`/`powershell`/`codemode`（没有路径可判）；`scope`/`allowTools` 之外的未知工具。
- 范围内会话可用 `/allowed-reads` 查看当前范围与 read 计数。

## 作为父代理的注意事项

- 子代理报「某路径不在任务范围内」时，判断该路径是否真的属于本任务：属于就扩大 `scope` 重派；不属于说明任务描述有歧义，先修任务描述。
- 不要为绕开拒绝而反复重试范围外的路径。
- `bash` 在范围内也被拒绝，所以需要跑构建、测试的子代理不适合上锁，或者接受它改用其他工具。
- 嵌套子代理不继承 bindings：给可能嵌套委派的代理上锁时，不要同时开 `allowNestedSubagents`。
- bindings 总量上限 16 KiB，scope 用简洁 glob 即可。
