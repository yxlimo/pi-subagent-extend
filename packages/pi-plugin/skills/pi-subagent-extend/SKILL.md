---
name: pi-subagent-extend
description: 委派 pi-subagents 子代理时，用 extensionBindings 把它的文件读写和可跑命令限定在本任务范围内：范围外的 tool_call 一律被拒绝，bash 白名单里的命令在 Landlock 沙箱里执行（默认断网、写目录受限）。适用场景：不让子代理扫整个仓库、给子代理放行 typecheck/test、在 worktree 里装依赖或跑验证、按角色配默认范围（profile）。判据与停机见 pi-subagent-extend-probes；裁掉 AGENTS.md 里的主代理专属段落见 pi-subagent-extend-context。
---

# pi-subagent-extend：给子代理限定任务范围

委派子代理时通过 `extensionBindings` 传入本次任务的范围。子代理会话里，范围之外的所有 tool_call 一律被拒绝（fail closed）：防止子代理漫无目的地扫仓库。

## 用在什么场景

| 场景 | 用哪个字段 | 看哪一节 |
| --- | --- | --- |
| 子代理只该读/写本任务的那几个文件 | `scope`，只读任务加 `readOnly` | [scope 字段](#scope-字段) |
| 子代理要自己跑 typecheck、测试、构建 | `bash.read` / `bash.write`，产物落盘加 `writable` | [bash 字段](#bash-字段) |
| 子代理在 `worktree: true` 里跑，需要装依赖 | 项目提交 `.pi/worktree-setup.sh`，配合 `writablePaths` / `network` | [worktree 里的 bash](#worktree-里的-bash) |
| 不想每次派单都手写范围（忙起来会忘） | agent profile | 下文「profile（角色默认值）」 |
| 子代理开始空转或原地打转 | 本包的另一半：探针 | skill `pi-subagent-extend-probes` |
| AGENTS.md 里混着只该主代理看的规则 | 本包的另一半：上下文隔离 | skill `pi-subagent-extend-context` |

判据与停机（只读空转、原地打转、早可收工、造杂物、撞权限）见另一个 skill `pi-subagent-extend-probes`。

上下文隔离（`AGENTS.md` 里 `<!-- main-agent-only:start -->` 圈出的段落、`.pi/main-only.md`）是同一个包的另一半，见 skill `pi-subagent-extend-context`。它由 agent 定义里声明的入口决定，跟 bindings 无关——委派时不需要为它传任何字段。

委派规则本身（brief 怎么写、等待方式、一个 cwd 一个写者）以 **pi-subagents 自带的 skill** 为准，本 skill 只补「怎么把范围和命令授权绑到一次委派上」这一层。

## 前置条件

被委派的 agent 必须能加载本扩展，二选一：

- agent 定义 frontmatter 里声明 `subagentOnlyExtensions: /path/to/pi-subagent-extend/packages/pi-plugin/src/index.ts`（前台、后台子代理都生效，推荐）；
- 扩展已全局安装（`~/.pi/agent/extensions/pi-subagent-extend`）且本次委派 `async: true`（后台子代理才走 ambient discovery）。

扩展没加载时 bindings 传了也没用，拦截不会发生。

项目若用 `<!-- main-agent-only:start -->` 标记，同一行还要加 `, …/src/child-context.ts`，否则子代理会读到主代理专属段落（见 skill `pi-subagent-extend-context`）。

`bash.read` / `bash.write` 里的命令靠沙箱 helper（`packages/helper` 的 Rust 二进制）跑：文件范围由 Landlock 强制，默认断网（TCP/UDP/DNS 全断），进程与 capability 也一并隔离（看不到宿主进程、命令无任何 capability）。宿主需要 Landlock ABI 7（Linux 6.15+）；helper 缺失或内核不够时 bash 保持关闭（其余功能不受影响）。

## 调用模板

只读/读写文件、不需要跑命令：

```text
subagent(
  agent: "<agent-name>",
  task: "<任务描述>",
  extensionBindings: { "pi-subagent-extend/1": { "scope": ["<文件/目录 glob>", "..."] } }
)
```

需要子代理自己跑测试或 typecheck：

```text
subagent(
  agent: "<agent-name>",
  task: "<任务描述>，完成后跑 typecheck 并报告结果",
  extensionBindings: {
    "pi-subagent-extend/1": {
      "scope": ["<文件/目录 glob>"],
      "bash": { "read": ["pnpm run typecheck"], "write": ["pnpm test"] }
    }
  }
)
```

namespace 固定为 `pi-subagent-extend/1`。每次委派都要传，scope 按本任务实际涉及的文件/目录收窄，不要默认给整个仓库。

子代理在 worktree 里跑（`worktree: true`）且需要装依赖或跑验证时：

```text
subagent(
  agent: "<agent-name>",
  task: "<任务描述>",
  options: { worktree: true },
  extensionBindings: {
    "pi-subagent-extend/1": {
      "scope": ["src/auth/**"],
      "bash": {
        "read": ["pnpm run typecheck"],
        "write": ["pnpm test"],
        "writable": true,
        "writablePaths": ["~/.local/share/pnpm/store"]
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
| `bash.writable` | `boolean` | 默认 `false`，沙箱根只读；`true` 时 scope 命中的目录、cwd、worktree 根与 `node_modules` 在沙箱内可写（测试产物、快照）。cwd 是 linked worktree 时，主仓的 common git 目录也一并可写——worktree 的索引与 ref 在那里，不给的话 `git add`/`commit`/`stash`/`switch -c` 会失败在 `index.lock` |
| `bash.writablePaths` | `string[]` | 额外放开写权限的路径（绝对路径、`~` 开头或相对 cwd）。工具链要写的全局目录放这里，如 pnpm store |
| `bash.env` | `object` | 注入沙箱的环境变量（写进 spec 的 `env`）。默认已注入 `XDG_RUNTIME_DIR`（沙箱私有 /tmp，pnpm 的锁目录靠它）与 worktree 场景的 `MISE_STATE_DIR` |
| `bash.gitExcludes` | `boolean` | 默认 `true`。给沙箱里的 git 注入全局排除规则（`node_modules/`、`.pnpm-store/`），防止 `git add -A` 把依赖目录吸进索引 |
| `bash.deny` | `string[]` | 黑名单：命中的命令**一律拒绝，调用方的白名单无法放宽**。通常写在 agent profile 里做项目骨架（`git stash`、`git reset`） |

白名单外的 bash 命令，拒绝文案里会带上探测到的 pnpm store 路径——模型看得见，能把它和「父代理要写什么」一起汇报上来。扩展只探测不自动放行。

条目两种写法：

- 字面量：按空白切词逐 token 前缀匹配。`"pnpm test"` 放行 `pnpm test -t foo`，不放行 `pnpm publish`。
- `re:` 前缀：正则，整串锚定。`"re: ^pnpm -r (test|build)$"`。不自动猜正则——命令参数常含 `*`、`.`，猜错方向是误授权。

## profile（角色默认值，不用每次传）

`extensionBindings` 只能每次派单时手写，agent 定义里没有声明默认值的位置；忘了传就等于**完全不设限**。profile 让默认值跟 agent 定义走：

```ts
// .pi/agent-profiles/writer.ts（两行）
// 路径必须写绝对路径：Node 不展开 import 里的 `~`
import { profile } from "/path/to/pi-subagent-extend/packages/pi-plugin/src/profile.ts";
export default profile("writer");
```

```markdown
---
name: be-core
subagentOnlyExtensions: /path/to/pi-subagent-extend/packages/pi-plugin/src/index.ts, <项目根>/.pi/agent-profiles/writer.ts
---
```

```json
// .pi/subagent-bindings.json（项目根）
{
  "default": { "maxDenies": 5 },
  "writer": { "bash": { "read": ["mise run typecheck"], "write": ["mise run test"], "writable": true } },
  "review": { "readOnly": true, "bash": { "read": ["git diff", "rg"], "deny": ["git stash"] } }
}
```

规则：

- 本次调用的 bindings 按 key 覆盖 profile；`bash` 整个对象覆盖（不合并数组）。
- `bash.deny` 取并集且**不可被调用方放宽**——「结构性禁掉」靠它，不靠默认值。
- profile 可以不写 `scope`：此时文件全拒、命令白名单照常生效（漏传 bindings 是响的失败）。
- profile 读不到时全拒，不退回不设限。
- 主会话不加载这些 loader，所以不会误锁主代理。

## worktree 里的 bash

子代理跑在 pi-subagents 的 managed worktree 时（`worktree: true`），两件事要额外安排：

- **装依赖不归扩展管**：worktree 的 `node_modules` 是指向主仓的符号链接，`pnpm install` 会顺着链接装进主仓、链接本身不被替换，层级因此是错的。这件事交给 pi-subagents 的 `worktreeSetupHook`（本仓 `packages/worktree-setup`）在子代理启动前处理，见下一节。扩展只管沙箱内的写权限。
- **pnpm 与 mise 都要写沙箱外的地方**：pnpm 的锁目录在 `XDG_RUNTIME_DIR`（`/run/user/<uid>`），mise 要把 worktree 的 `mise.toml` 登记进 `~/.local/state/mise/trusted-configs`。扩展默认把这两处指到沙箱私有 /tmp，所以这两个失败已经不用管；pnpm store 这类真正需要持久可写的地方，用 `bash.writablePaths` 显式给出。
- **沙箱里 pnpm 用哪个 store 取决于写权限**：全局 store（`~/.local/share/pnpm/store`）在只读根下不可写时，pnpm 探测到就退回 `<项目>/node_modules/.pnpm-store`；把 store 目录写进 `bash.writablePaths`，`pnpm store path` 就仍指向全局 store（实测）。两种都能跑测试——项目内 store 落在本来就可写的 `node_modules/` 下。扩展用 git 全局排除规则保证它进不了索引，但项目自己的 `.gitignore` 也应忽略 `node_modules/`。
- **沙箱里装依赖需要开网络**（`"network": true`）：无论用哪个 store，装新包都得访问 registry。默认断网时 `pnpm install` 必然失败。

## worktree 依赖安装（worktree hook）

pi-subagents 每个 worktree 创建后、子代理启动前会跑一次 `worktreeSetupHook`，cwd 就是新工作树根。本仓提供的 hook 是 `packages/worktree-setup/worktree-setup.sh`，全局只装一个软链：

```text
~/.pi/agent/extensions/subagent/worktree-setup.sh -> <本仓>/packages/worktree-setup/worktree-setup.sh
```

项目侧只要提交一个 shell 脚本 `<repo>/.pi/worktree-setup.sh`，没这个文件就什么都不做（所以同一个全局 hook 服务所有项目）：

```sh
#!/bin/sh
set -eu
cd packages/pi-plugin      # manifest 不在根目录时自己 cd
pnpm install --prefer-offline
```

- **退出码就是契约**：hook 不二次判断「装好没」，项目在自己的脚本里决定。pnpm 12 装完还会因 `ERR_PNPM_IGNORED_BUILDS` 退 1，那就自己写 `|| true` 或加一条自检。
- **符号链接由 hook 先删**（`node_modules` 指向主仓时先 unlink 再装），项目脚本不用管。
- 输出记在 `~/.cache/pi-worktree-setup/<worktree 目录名>.log`；失败时 hook 把最后 20 行和日志路径打到 stderr，输出含 `not trusted` 时额外提示 mise 的 `trusted_config_paths`。
- **hook 不经过沙箱**：它在子代理之前跑，用的是宿主权限。子代理自己再跑 `pnpm install` 仍然要沙箱内的写权限与 `network`。
- hook 是 POSIX sh，需要内核认 shebang；Windows 得上原生可执行文件（上游用 `spawn(hookPath, [], { shell: false })`，Node 不会代跑 `.cmd`）。

## 生效后的规则

- 范围内：`read`/`edit`/`write`/`grep`/`find`/`ls` 放行（`readOnly` 时 `edit`/`write` 拒绝）。
- 一律拒绝：`powershell`/`codemode`；`scope`/`allowTools` 之外的未知工具。
- `contact_supervisor` / `intercom` / `structured_output` 始终放行，**停机之后也放行**：子代理中途向监督者转告是正当通道，不能被范畴或探针关掉。
- 停机是硬停（`terminate`）：整批结果都 terminating 时本轮直接结束，不再有收尾回合。所以求援要在停机前用，不要指望被停之后还能报。
- `bash`：没配白名单时一律拒绝；配了则只有命中 `read`/`write` 两列的命令执行，并且自动改写为
  helper 沙箱里运行——文件范围由 Landlock 强制、默认断网、可写目录为 scope 命中目录、cwd 与 `node_modules`（`writable` 时）再加上 `writablePaths`。命令里出现
  `; & | < > \` $` 等 shell 元字符直接拒绝，所以「先 `pnpm test` 再 `cat 别的文件`」这种拼法走不通。
- 越界拒绝的文案是英文，会说清「哪个路径不在范围、不要重试、需要就上报」，并列出当前 scope。缺 path 的拒绝不算权限问题：`grep`/`find` 不带 path 会按 cwd 处理（文案写 `no path was given`），`write`/`edit` 必须给 path（文案写 `needs a path`）。这类拒绝不计入撞权限计数。
- 范围内会话可用 `/permission` 查看当前范围、bash 两列、沙箱可写路径、pnpm store、read 计数、撞权限计数与探针状态（键名为英文：`Source`、`Mode`、`bash read`、`bash write`、`bash deny`、`Sandbox`、`Sandbox writable paths`、`Reads`、`Denials`）。

## 作为父代理的注意事项

- 子代理报 `no path was given` 或 `needs a path` 时：那是工具参数缺失，不是它走错了目录。给子代理的 task 里写清文件路径。
- 子代理报 `is outside this task's scope` 时，判断该路径是否真的属于本任务：属于就扩大 `scope` 重派；不属于说明任务描述有歧义，先修任务描述。先核对 scope 写法本身（目录要写成 `dir` / `dir/` / `dir/**`），再怀疑子代理走错目录。
- 同一批里有放行结果时（整批不全是 terminating），本轮会继续，之后的调用一律拿到「停机理由」那段文字（里面是历史路径）。判断时只认最后一行的 criterion，不要把里面的路径当成本轮任务的路径。
- 不要为绕开拒绝而反复重试范围外的路径。
- 需要子代理自己跑测试/typecheck 时，把只读命令写进 `bash.read`、会写文件的写进 `bash.write`（查得细就用 `re:` 正则，别写 `re: .*`）。测试产物要落盘就加 `"writable": true`；沙箱默认断网，安装依赖之类会被拒。
- 沙箱挡越界写与联网，不挡读：跑测试要读整棵树，所以白名单命令在沙箱里仍可 `cat` 范围外文件。不要把 bash 白名单当成「连读也锁住」的手段。
- 子代理报 `command not in the allowlist` 时，先判断这条命令是否本任务必需：必需就把它加进对应列重派；不必要就改任务描述，别让它反复试。拒绝文案里会带 pnpm store 的路径和 `bash.writablePaths` 的提示——子代理要装依赖时把它抄进去即可，不要让它自己去装。
- 嵌套子代理不继承 bindings：给可能嵌套委派的代理上锁时，不要同时开 `allowNestedSubagents`。
- bindings 总量上限 16 KiB，scope 用简洁 glob 即可；本扩展所有字段共用 namespace `pi-subagent-extend/1`，上限按整个 bindings 计。
