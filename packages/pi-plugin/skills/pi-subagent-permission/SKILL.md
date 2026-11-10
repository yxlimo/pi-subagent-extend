---
name: pi-subagent-permission
description: 委派 pi-subagents 子代理并限定其任务范围时使用。写明如何通过 extensionBindings（namespace pi-subagent-permission/1）把子代理可读可写的文件限制在指定范围内，范围外的所有 tool_call 一律被拒绝；需要子代理自己跑测试/typecheck 时用 bash.read / bash.write 点名命令（支持 re: 正则），在沙箱 helper 里执行（Landlock 强制文件范围、默认断网）；worktree 隔离、pnpm/mise 的可写目录用 bash.writablePaths 与 bash.env 处理。
---

# pi-subagent-permission：给子代理限定任务范围

委派子代理时通过 `extensionBindings` 传入本次任务的范围。子代理会话里，范围之外的所有 tool_call 一律被拒绝（fail closed）：防止子代理漫无目的地扫仓库。

判据与停机（只读空转、原地打转、早可收工、造杂物、撞权限）见另一个 skill `pi-subagent-permission-probes`。

委派规则本身（brief 怎么写、等待方式、一个 cwd 一个写者）以 **pi-subagents 自带的 skill** 为准，本 skill 只补「怎么把范围和命令授权绑到一次委派上」这一层。

## 前置条件

被委派的 agent 必须能加载本扩展，二选一：

- agent 定义 frontmatter 里声明 `subagentOnlyExtensions: /home/shay/extensions/pi-subagent-permission/packages/pi-plugin/src/index.ts`（前台、后台子代理都生效，推荐）；
- 扩展已全局安装（`~/.pi/agent/extensions/pi-subagent-permission`）且本次委派 `async: true`（后台子代理才走 ambient discovery）。

扩展没加载时 bindings 传了也没用，拦截不会发生。

`bash.read` / `bash.write` 里的命令靠沙箱 helper（`packages/helper` 的 Rust 二进制）跑：文件范围由 Landlock 强制，默认断网（TCP/UDP/DNS 全断），进程与 capability 也一并隔离（看不到宿主进程、命令无任何 capability）。宿主需要 Landlock ABI 7（Linux 6.15+）；helper 缺失或内核不够时 bash 保持关闭（其余功能不受影响）。

## 调用模板

只读/读写文件、不需要跑命令：

```text
subagent(
  agent: "<agent-name>",
  task: "<任务描述>",
  extensionBindings: { "pi-subagent-permission/1": { "scope": ["<文件/目录 glob>", "..."] } }
)
```

需要子代理自己跑测试或 typecheck：

```text
subagent(
  agent: "<agent-name>",
  task: "<任务描述>，完成后跑 typecheck 并报告结果",
  extensionBindings: {
    "pi-subagent-permission/1": {
      "scope": ["<文件/目录 glob>"],
      "bash": { "read": ["pnpm run typecheck"], "write": ["pnpm test"] }
    }
  }
)
```

namespace 固定为 `pi-subagent-permission/1`。每次委派都要传，scope 按本任务实际涉及的文件/目录收窄，不要默认给整个仓库。

子代理在 worktree 里跑（`worktree: true`）且需要装依赖或跑验证时：

```text
subagent(
  agent: "<agent-name>",
  task: "<任务描述>",
  options: { worktree: true },
  extensionBindings: {
    "pi-subagent-permission/1": {
      "scope": ["web/src/features/balance/**"],
      "bash": {
        "read": ["pnpm run typecheck"],
        "write": ["pnpm test"],
        "writable": true,
        "writablePaths": ["/home/shay/.local/share/pnpm/store"]
      }
    }
  }
)
```

## scope 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `scope` | `string[]` | 必填。任务范围的 glob 列表；空数组 = 拒绝一切文件访问 |
| `readOnly` | `boolean` | 默认 `false`；`true` 时范围内也禁止 `edit`/`write`，适合只读的调研、评审代理 |
| `maxReads` | `number` | 可选。成功 `read` 次数上限，超限后所有 read 被拒绝 |
| `allowTools` | `string[]` | 可选。额外放行的工具名；`bash` 等执行器类不能用它放行 |

glob 规则：`**` 匹配任意层（含零层），`*` 只匹配单层内的字符，`?` 匹配单字符。

写目录时 `dir`、`dir/`、`dir/**` 三种写法等价，都覆盖该目录本身及其下任意深度的内容；`dir/*` 只覆盖直接子项。所以范围按目录写，不要逐文件列——列文件既容易漏，目录里新增的文件也会被拒。

## bash 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bash` | `object` | 可选。不给就完全禁止 bash；两列都空也等于禁止 |
| `bash.read` | `string[]` | 只读命令（typecheck、grep 等）。字面量按空白切词前缀匹配；`re:` 开头按正则整串匹配 |
| `bash.write` | `string[]` | 会写文件的命令（测试、构建等）。匹配规则同上；算作「写入活动」 |
| `bash.network` | `boolean` | 默认 `false`，沙箱断网；确实要联网的命令才开 |
| `bash.writable` | `boolean` | 默认 `false`，沙箱根只读；`true` 时 scope 命中的目录在沙箱内可写（测试产物、快照）；worktree 场景下 worktree 根也会被绑成可写 |
| `bash.writablePaths` | `string[]` | 额外绑成可写的路径（绝对路径、`~` 开头或相对 cwd）。工具链要写的全局目录放这里，如 pnpm store |
| `bash.env` | `object` | 注入沙箱的环境变量（`--setenv`）。默认已注入 `XDG_RUNTIME_DIR`（沙箱私有 /tmp，pnpm 的锁目录靠它）与 worktree 场景的 `MISE_STATE_DIR` |
| `bash.gitExcludes` | `boolean` | 默认 `true`。给沙箱里的 git 注入全局排除规则（`node_modules/`、`.pnpm-store/`），防止 `git add -A` 把依赖目录吸进索引 |

白名单外的 bash 命令，拒绝文案里会带上探测到的 pnpm store 路径——模型看得见，能把它和「父代理要写什么」一起汇报上来。扩展只探测不自动放行。

条目两种写法：

- 字面量：按空白切词逐 token 前缀匹配。`"pnpm test"` 放行 `pnpm test -t foo`，不放行 `pnpm publish`。
- `re:` 前缀：正则，整串锚定。`"re: ^pnpm -r (test|build)$"`。不自动猜正则——命令参数常含 `*`、`.`，猜错方向是误授权。

## worktree 里的 bash

子代理跑在 pi-subagents 的 managed worktree 时（`worktree: true`），两件事要额外安排：

- **worktree 的 `node_modules` 是指向主仓的符号链接**，所以 `pnpm install` 在 worktree 里必然失败（pnpm 需要真实的 hoist 目录）。依赖已经就位时不要让子代理装依赖；让 `pnpm run` 不做前置安装（项目侧 `pnpm-workspace.yaml` 写 `verifyDepsBeforeRun: false`）就能正常跑验证。
- **pnpm 与 mise 都要写沙箱外的地方**：pnpm 的锁目录在 `XDG_RUNTIME_DIR`（`/run/user/<uid>`），mise 要把 worktree 的 `mise.toml` 登记进 `~/.local/state/mise/trusted-configs`。扩展默认把这两处指到沙箱私有 /tmp，所以这两个失败已经不用管；pnpm store 这类真正需要持久可写的地方，用 `bash.writablePaths` 显式给出。
- **沙箱里 pnpm 一定用项目内的 `.pnpm-store`**：项目目录被单独 bind 成挂载点，跨挂载不能建硬链接，pnpm 只能退回项目内 store。扩展已经用 git 全局排除规则保证它进不了索引，但项目自己的 `.gitignore` 也应忽略 `node_modules/`。
- **沙箱里装依赖需要开网络**（`"network": true`）：项目内的 store 是空的，只能从 registry 下载。默认断网时 `pnpm install` 必然失败。

## 生效后的规则

- 范围内：`read`/`edit`/`write`/`grep`/`find`/`ls` 放行（`readOnly` 时 `edit`/`write` 拒绝）。
- 一律拒绝：`powershell`/`codemode`；`scope`/`allowTools` 之外的未知工具。
- `contact_supervisor` / `intercom` / `structured_output` 始终放行：子代理中途向监督者转告是正当通道。
- `bash`：没配白名单时一律拒绝；配了则只有命中 `read`/`write` 两列的命令执行，并且自动改写为
  helper 沙箱里运行——文件范围由 Landlock 强制、默认断网、可写目录只有 scope（`writable` 时）。命令里出现
  `; & | < > \` $` 等 shell 元字符直接拒绝，所以「先 `pnpm test` 再 `cat 别的文件`」这种拼法走不通。
- 缺 path 的拒绝不算权限问题：`grep`/`find` 不带 path 会按 cwd 处理，`write`/`edit` 必须给 path。这类拒绝不计入撞权限计数，不会把子代理误判成「授权写错」。
- 范围内会话可用 `/permission` 查看当前范围、bash 两列、沙箱可写路径、pnpm store、read 计数、撞权限计数与探针状态。

## 作为父代理的注意事项

- 子代理报「没有给 path」或「必须给 path」时：那是工具参数缺失，不是它走错了目录。给子代理的 task 里写清文件路径。
- 子代理报「某路径不在任务范围内」时，判断该路径是否真的属于本任务：属于就扩大 `scope` 重派；不属于说明任务描述有歧义，先修任务描述。先核对 scope 写法本身（目录要写成 `dir` / `dir/` / `dir/**`），再怀疑子代理走错目录。
- 不要为绕开拒绝而反复重试范围外的路径。
- 需要子代理自己跑测试/typecheck 时，把只读命令写进 `bash.read`、会写文件的写进 `bash.write`（查得细就用 `re:` 正则，别写 `re: .*`）。测试产物要落盘就加 `"writable": true`；沙箱默认断网，安装依赖之类会被拒。
- 沙箱挡越界写与联网，不挡读：跑测试要读整棵树，所以白名单命令在沙箱里仍可 `cat` 范围外文件。不要把 bash 白名单当成「连读也锁住」的手段。
- 子代理报「bash 命令不在白名单内」时，先判断这条命令是否本任务必需：必需就把它加进对应列重派；不必要就改任务描述，别让它反复试。拒绝文案里会带 pnpm store 的路径——子代理要装依赖时把它抄进 `bash.writablePaths` 即可，不要让它自己去装。
- 嵌套子代理不继承 bindings：给可能嵌套委派的代理上锁时，不要同时开 `allowNestedSubagents`。
- bindings 总量上限 16 KiB，scope 用简洁 glob 即可；两个 skill 的字段共用同一个 namespace，总量一起算。
