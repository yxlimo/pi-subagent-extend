---
name: pi-allow-reads
description: 委派 pi-subagents 子代理并限定其任务范围时使用。写明如何通过 extensionBindings（namespace pi-allow-reads/1）把子代理可读可写的文件限制在指定范围内，范围外的所有 tool_call 一律被拒绝；需要子代理自己跑测试/typecheck 时用 bash.allow 点名命令，在 bwrap 沙箱里执行。
---

# pi-allow-reads：给子代理限定任务范围

委派子代理时通过 `extensionBindings` 传入本次任务的范围。子代理会话里，范围之外的所有 tool_call 一律被拒绝（fail closed）：防止子代理漫无目的地扫仓库。

## 前置条件

被委派的 agent 必须能加载本扩展，二选一：

- agent 定义 frontmatter 里声明 `subagentOnlyExtensions: /home/shay/extensions/pi-allow-reads/packages/pi-plugin/src/index.ts`（前台、后台子代理都生效，推荐）；
- 扩展已全局安装（`~/.pi/agent/extensions/pi-allow-reads`）且本次委派 `async: true`（后台子代理才走 ambient discovery）。

扩展没加载时 bindings 传了也没用，拦截不会发生。

`bash.allow` 里的命令靠 bwrap 跑；机器上没有 bwrap 时 bash 保持关闭（其余功能不受影响）。

## 调用模板

只读/读写文件、不需要跑命令：

```
subagent(
  agent: "<agent-name>",
  task: "<任务描述>",
  extensionBindings: { "pi-allow-reads/1": { "scope": ["<文件/目录 glob>", "..."] } }
)
```

需要子代理自己跑测试或 typecheck：

```
subagent(
  agent: "<agent-name>",
  task: "<任务描述>，完成后跑 typecheck 并报告结果",
  extensionBindings: {
    "pi-allow-reads/1": {
      "scope": ["<文件/目录 glob>"],
      "bash": { "allow": ["pnpm run typecheck", "pnpm test"] }
    }
  }
)
```

namespace 固定为 `pi-allow-reads/1`。每次委派都要传，scope 按本任务实际涉及的文件/目录收窄，不要默认给整个仓库。

## bindings 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `scope` | `string[]` | 必填。任务范围的 glob 列表；空数组 = 拒绝一切文件访问 |
| `readOnly` | `boolean` | 默认 `false`；`true` 时范围内也禁止 `edit`/`write`，适合只读的调研、评审代理 |
| `maxReads` | `number` | 可选。成功 `read` 次数上限，超限后所有 read 被拒绝 |
| `allowTools` | `string[]` | 可选。额外放行的工具名；`bash` 等执行器类不能用它放行 |
| `bash` | `object` | 可选。不给就完全禁止 bash；给了才按下面的规则放行 |
| `bash.allow` | `string[]` | 必填（`bash` 在场时）。允许执行的命令前缀，如 `["pnpm run typecheck", "pnpm test"]`；按空白切词逐 token 匹配 |
| `bash.network` | `boolean` | 默认 `false`，沙箱断网；确实要联网的命令才开 |
| `bash.writable` | `boolean` | 默认 `false`，沙箱根只读；`true` 时 scope 命中的目录在沙箱内可写（测试产物、快照） |

glob：`**` 任意层目录、`*` 单层内任意字符、`?` 单字符。范围写 `src` 或 `src/**` 都覆盖该目录本身及其下所有内容。

## 生效后的规则

- 范围内：`read`/`edit`/`write`/`grep`/`find`/`ls` 放行（`readOnly` 时 `edit`/`write` 拒绝）。
- 一律拒绝：`powershell`/`codemode`；`scope`/`allowTools` 之外的未知工具。
- `bash`：没配 `bash.allow` 时一律拒绝；配了则只有命中白名单的命令执行，并且自动改写为
  bwrap 沙箱里运行——根只读、默认断网、可写目录只有 scope（`writable` 时）。命令里出现
  `; & | < > \` $` 等 shell 元字符直接拒绝，所以「先 `pnpm test` 再 `cat 别的文件`」这种拼法走不通。
- 范围内会话可用 `/allowed-reads` 查看当前范围、bash 白名单与 read 计数。

## 作为父代理的注意事项

- 子代理报「某路径不在任务范围内」时，判断该路径是否真的属于本任务：属于就扩大 `scope` 重派；不属于说明任务描述有歧义，先修任务描述。
- 不要为绕开拒绝而反复重试范围外的路径。
- 需要子代理自己跑测试/typecheck 时，把命令写进 `bash.allow`（逐条前缀，别写 `*`）。测试产物要落盘就加 `"writable": true`；沙箱默认断网，安装依赖之类会被拒。
- 沙箱挡越界写与联网，不挡读：跑测试要读整棵树，所以白名单命令在沙箱里仍可 `cat` 范围外文件。不要把 `bash.allow` 当成「连读也锁住」的手段。
- 子代理报「bash 命令不在白名单内」时，先判断这条命令是否本任务必需：必需就把它加进 `bash.allow` 重派；不必要就改任务描述，别让它反复试。
- 嵌套子代理不继承 bindings：给可能嵌套委派的代理上锁时，不要同时开 `allowNestedSubagents`。
- bindings 总量上限 16 KiB，scope 用简洁 glob 即可。
