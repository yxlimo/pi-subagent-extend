---
name: pi-allow-reads
description: 委派 pi-subagents 子代理并限定其任务范围时使用。写明如何通过 extensionBindings（namespace pi-allow-reads/1）把子代理可读可写的文件限制在指定范围内，范围外的所有 tool_call 一律被拒绝；需要子代理自己跑测试/typecheck 时用 bash.read / bash.write 点名命令（支持 re: 正则），在 bwrap 沙箱里执行；另有探针判据（只读空转、原地打转、早可收工、造杂物）与撞权限计数，命中后停止本轮并要求子代理写汇报。
---

# pi-allow-reads：给子代理限定任务范围

委派子代理时通过 `extensionBindings` 传入本次任务的范围。子代理会话里，范围之外的所有 tool_call 一律被拒绝（fail closed）：防止子代理漫无目的地扫仓库。

## 前置条件

被委派的 agent 必须能加载本扩展，二选一：

- agent 定义 frontmatter 里声明 `subagentOnlyExtensions: /home/shay/extensions/pi-allow-reads/packages/pi-plugin/src/index.ts`（前台、后台子代理都生效，推荐）；
- 扩展已全局安装（`~/.pi/agent/extensions/pi-allow-reads`）且本次委派 `async: true`（后台子代理才走 ambient discovery）。

扩展没加载时 bindings 传了也没用，拦截不会发生。

`bash.read` / `bash.write` 里的命令靠 bwrap 跑；机器上没有 bwrap 时 bash 保持关闭（其余功能不受影响）。

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
      "bash": { "read": ["pnpm run typecheck"], "write": ["pnpm test"] },
      "maxDenies": 3,
      "probe": {}
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
| `bash.read` | `string[]` | 只读命令（typecheck、grep 等）。字面量按空白切词前缀匹配；`re:` 开头按正则整串匹配 |
| `bash.write` | `string[]` | 会写文件的命令（测试、构建等）。匹配规则同上；计入探针的「写入活动」 |
| `maxDenies` | `number` | 默认 3，写 0 关闭。连续被范围规则拒绝这么多次先 warn「多半是授权写错」，再撞一次就停 |
| `probe` | `object` \| `false` | 四条探针判据的阈值。不写时只有「原地打转」「撞权限」生效；`{}` 打开全部默认值；写了字段则只打开写到的；`false` 全关 |
| `bash.network` | `boolean` | 默认 `false`，沙箱断网；确实要联网的命令才开 |
| `bash.writable` | `boolean` | 默认 `false`，沙箱根只读；`true` 时 scope 命中的目录在沙箱内可写（测试产物、快照） |
| `probe.idleWriteMs` / `probe.abortGraceMs` | `number` | 需显式配置才生效（默认 6 / 2 分钟）。这段时间内没有写入活动 → warn，再过宽限 → 停止 |
| `probe.repeatBash` | `number` | 默认 3（不配也生效）。同一条 bash 命令第 N 次 warn，第 N+1 次停止 |
| `probe.successIdleMs` / `probe.successPatterns` | `number` / `string[]` | 需显式配置（默认 5 分钟 / `["fail=0", "0 failed", ...]`）。测试出成功标记后这么久无新改动 → 停止 |
| `probe.forbidWritePatterns` | `string[]` | 需显式配置。正则列表，`write`/`edit` 目标命中即拒绝 |

glob 规则：`**` 匹配任意层（含零层），`*` 只匹配单层内的字符，`?` 匹配单字符。

写目录时 `dir`、`dir/`、`dir/**` 三种写法等价，都覆盖该目录本身及其下任意深度的内容；`dir/*` 只覆盖直接子项。所以范围按目录写，不要逐文件列——列文件既容易漏，目录里新增的文件也会被拒。

## 生效后的规则

- 范围内：`read`/`edit`/`write`/`grep`/`find`/`ls` 放行（`readOnly` 时 `edit`/`write` 拒绝）。
- 一律拒绝：`powershell`/`codemode`；`scope`/`allowTools` 之外的未知工具。
- `bash`：没配白名单时一律拒绝；配了则只有命中 `read`/`write` 两列的命令执行，并且自动改写为
  bwrap 沙箱里运行——根只读、默认断网、可写目录只有 scope（`writable` 时）。命令里出现
  `; & | < > \` $` 等 shell 元字符直接拒绝，所以「先 `pnpm test` 再 `cat 别的文件`」这种拼法走不通。
- `contact_supervisor` / `intercom` / `structured_output` 始终放行：子代理中途向监督者转告是正当通道，探针停机也要靠它上报。
- 范围内会话可用 `/allowed-reads` 查看当前范围、bash 两列、read 计数、撞权限计数与探针状态。

## 探针与停机语义

四条判据命中后的处理分两级：**warn** 拦下一次 tool_call 并把理由给它；**stop** 之后每个 tool 边界都拒绝，子代理失去工具后把结论写成汇报，父代理收到的就是这份汇报。

不是硬杀：停机不用 `ctx.abort()`，也不用 `terminate`——两者都会把子代理正在写的汇报一起掐掉（实测带 abort 时最终输出只剩一行）。所以被停的子代理**总能给出汇报**，父代理应当读它，而不是当成失败重试。

## 作为父代理的注意事项

- 子代理报「某路径不在任务范围内」时，判断该路径是否真的属于本任务：属于就扩大 `scope` 重派；不属于说明任务描述有歧义，先修任务描述。先核对 scope 写法本身（目录要写成 `dir` / `dir/` / `dir/**`），再怀疑子代理走错目录。
- 不要为绕开拒绝而反复重试范围外的路径。
- 需要子代理自己跑测试/typecheck 时，把只读命令写进 `bash.read`、会写文件的写进 `bash.write`（查得细就用 `re:` 正则，别写 `re: .*`）。测试产物要落盘就加 `"writable": true`；沙箱默认断网，安装依赖之类会被拒。
- 沙箱挡越界写与联网，不挡读：跑测试要读整棵树，所以白名单命令在沙箱里仍可 `cat` 范围外文件。不要把 bash 白名单当成「连读也锁住」的手段。
- 子代理报「bash 命令不在白名单内」时，先判断这条命令是否本任务必需：必需就把它加进对应列重派；不必要就改任务描述，别让它反复试。
- 子代理被「只读空转 / 原地打转 / 早可收工」停下时，它的汇报是诊断而非结果：按汇报里说的补足授权或信息再重派，不要原样重试。
- 「早可收工」要小心：成功标记（如 `tsc --noEmit`）命中后就算验证通过，之后仍要它继续做事就会被停。任务的验证命令应当放在最后一步。
- 时间判据只在 `probe` 里显式配置才生效；不写 `probe` 时只有「原地打转」和「撞权限」在工作，这两条是纯错误信号，误伤小。
- 想限制它乱写临时文件，就用 `probe.forbidWritePatterns` 点名模式（如 `_tscProbe`、`TestHooks`）。
- 嵌套子代理不继承 bindings：给可能嵌套委派的代理上锁时，不要同时开 `allowNestedSubagents`。
- bindings 总量上限 16 KiB，scope 用简洁 glob 即可。
