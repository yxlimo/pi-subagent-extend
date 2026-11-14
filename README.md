# pi-subagent-extend

> 曾用名 `pi-allow-reads` → `pi-subagent-permission`。现名把范围扩到「子代理相关的一次收齐」（权限 + 上下文隔离），绑定命名空间、环境变量、helper 二进制与 skill 目录都跟着改过，旧名不再接受。

pi 扩展：把一个会话（主要是子代理）能碰的文件限制在任务范围内。父代理委派时指定本次任务的文件/目录，子代理会话里范围之外的 tool_call 一律拒绝，防止子代理漫无目的地扫仓库。

同一个包还管第二件事：**上下文隔离**。`AGENTS.md` 里用 `<!-- main-agent-only:start -->` 圈出的段落不进子代理提示词，整段只给主代理的内容放 `.pi/main-only.md` 只注入主会话。两件事互不依赖，可以只用一个（见「上下文隔离」）。

| npm package | directory | host | what it does |
| --- | --- | --- | --- |
| `pi-subagent-extend` | `packages/pi-plugin` | pi extension | 会话激活时读取任务范围，`tool_call` 阶段拦截范围外的一切调用 |

## 布局

```text
packages/pi-plugin       pi 扩展   (src/, test/{extension,context}.test.mjs, install.sh, skills/pi-subagent-extend{,-probes,-context}/SKILL.md)
packages/helper          沙箱 helper (Rust：Landlock + 网络/挂载命名空间，构建产物落到 packages/pi-plugin/bin/)
scripts/worktree-setup.mjs  pi-subagents 的 worktreeSetupHook（与扩展无关，见「worktree 建好先装依赖」）
```

`src/` 下三个入口：`index.ts`（范围与 bash）、`main-context.ts`（主代理侧上下文，随环境加载）、`child-context.ts`（子代理侧剥标记，由 agent 定义声明）。

## worktree 建好先装依赖（worktreeSetupHook）

`subagent({ worktree: true })` 建出的工作树里没有 `node_modules`（被 gitignore），而工作树里那份**指向主仓的符号链接**会让 pnpm 顺着链接装进主仓，链接本身不被替换，层级依旧是错的——`tsc` 因此找不到包。这个故障在子代理启动后才发现，等于白跑一轮。

pi-subagents 官方提供了 `worktreeSetupHook`：每个 worktree 创建后、子代理启动前跑一次。`scripts/worktree-setup.mjs` 就是给它的脚本，配在 `~/.pi/agent/extensions/subagent/config.json`：

```json
{
  "worktreeSetupHook": "~/extensions/pi-subagent-extend/scripts/worktree-setup.mjs",
  "worktreeSetupHookTimeoutMs": 300000
}
```

行为（**先探测再装**，健康的树不会被每次 launch 重装）：

| 探测结果 | 动作 |
| --- | --- |
| `node_modules` 是真实目录、且（有 tsconfig 时）`tsc --noEmit` 通过 | 跳过 |
| `node_modules` 缺失 / 是符号链接 / 为空 / `tsc` 不过 | 先 unlink 掉符号链接，再装 |

安装根：根有 `package.json` 或 `pnpm-workspace.yaml` 就装根；否则有界向下（≤2 层）找独立包，跳过 `node_modules` 与点目录——本仓没有根 manifest，包在 `packages/pi-plugin`。锁文件决定包管理器（`pnpm-lock.yaml` → pnpm，`package-lock.json` → npm）。

两个判据上的取舍，都是实测出来的：

- **探针是判据，安装器的退出码只进日志。** pnpm 12 把「有依赖的 build script 没被批准」当作非零退出（`ERR_PNPM_IGNORED_BUILDS`），而依赖其实已装好、`tsc` 也通过；按退出码判失败会误拒每一次 launch。
- **符号链接必须先 unlink。** 不删链接直接 install，pnpm 会顺着链接写进目标目录，链接本身保留，问题原样存在。

setup 失败时脚本以非零退出并打印路径，启动被拒——宁可不出这一单，也不让子代理在依赖解析不了的树里跑。每次运行的日志在 `~/.cache/pi-worktree-setup/<runId>.log`。

这个脚本服务的是 pi-subagents 的启动流程，跟本扩展的权限/上下文无关，只是恰好维护在同一仓库里。

## 行为

fail closed：范围生效时，下表之外的任何工具也一律拒绝。

| 工具 | 行为 |
|------|------|
| `read` | 解析 path（缺省视为 cwd），命中范围放行，否则拒绝；受 `maxReads` 预算约束 |
| `edit` / `write` | 同上；`readOnly` 时即使范围内也拒绝 |
| `grep` / `find` / `ls` | 同上（path 缺省为 cwd） |
| `bash` | 没配白名单时一律拒绝；配了则只放行 `bash.read` / `bash.write` 命中的命令，并改写为交给沙箱 helper 执行（文件范围由 Landlock 强制、默认断网、scope 可写需 `writable`）；命令含 shell 元字符直接拒绝 |
| `bash.writablePaths` | 额外给可写权限的路径（pnpm store、mise state 等全局可写区） |
| `bash.env` | 注入沙箱的环境变量 |
| `powershell` / `codemode` | 一律拒绝（没有路径可判，能绕过范围） |
| `structured_output` | 放行（会话级运行时工具，不碰文件系统） |
| 其余未知工具 | 拒绝；`allowTools` 里点名的工具放行（执行器类仍拒绝） |

范围生效时会话开始有提示；`/permission` 查看当前范围、模式、bash 白名单、read 计数、撞权限计数与探针状态。

### 探针（四条判据）

打转与撞权限默认开启（纯错误信号，误伤小）；两条时间判据会误伤慢任务，必须在 `probe` 里显式配置才生效：`"probe": {}` 一次打开全部默认值，写部分字段则只打开写到的那些，`"probe": false` 关闭全部。

| 判据 | 缺省 | 行为 |
| --- | --- | --- |
| 只读空转 | 需显式配置：`idleWriteMs: 360000`，`abortGraceMs: 120000` | `idleWriteMs` 内没有任何写入活动 → 下一个 tool 边界 warn；再过 `abortGraceMs` → 停止本轮 |
| 原地打转 | 默认开启，`repeatBash: 3` | 同一条 bash 命令原文第 3 次 warn，第 4 次停止 |
| 早可收工 | 需显式配置：`successIdleMs: 300000`，`successPatterns` | bash 输出命中成功标记后，`successIdleMs` 内无新改动 → 停止 |
| 造杂物 | 需显式配置：`forbidWritePatterns: []` | `write`/`edit` 目标路径命中正则 → 直接拒绝该次写入 |

「写入活动」只算 `edit`/`write` 调用与命中 `bash.write` 的命令；`bash.read` 与 `read`/`grep`/`ls` 都不算——否则拿 bash 只读打转就绕过了这条判据。`readOnly: true` 的任务跳过前两条（本来就该只读）。

`maxDenies`（缺省 3，写 `0` 关闭）：连续被范围规则拒绝这么多次，先 warn「多半是父代理授权写错，向父代理报告缺什么」，再撞一次就停。

停机方式：不调 `ctx.abort()`。硬 abort 会把模型正在写的收尾汇报一起掐掉，父代理只拿到一句工具错误。改为「粘住停止状态 + 之后每次调用都拒绝」，模型失去工具后自然把结论写完，父代理收到的是一份完整汇报。实测对比过：带 `terminate` 时汇报被截断成一行，去掉后完整。

### bash 白名单与沙箱

子代理要跑测试/typecheck 时，父代理在 bindings 里点名命令：

```json
{ "pi-subagent-extend/1": { "scope": ["lib/router/**"], "bash": { "read": ["pnpm run typecheck"], "write": ["pnpm test"] } } }
```

放行的命令会改写成：

```text
<helper> --spec ~/.cache/pi-subagent-extend/spec-<pid>.json -- bash -lc '<命令>'
```

helper 是 `packages/helper` 里的 Rust 二进制（`pnpm run build:helper` 构建）。它在 `exec` 之前先把**自己**关进沙箱，所以白名单命令拿到的就是一个已经限定好范围、断好网的进程：

- **文件**：Landlock 规则集。`/` 可读可执行，只有 spec 里列出的目录可写（scope、cwd、`node_modules`、`bash.writablePaths`），写到范围外直接 `EPERM`。
- **网络**：私有网络命名空间，TCP、UDP、DNS 全断（网卡只剩 `lo`）。同时用私有 mount 命名空间把 `nscd` / `systemd-resolved` 的 unix socket 目录盖成空 tmpfs——unix socket 不受网络命名空间约束，不盖的话域名照样能解析。
- **进程**：私有 PID 命名空间并重挂 `/proc`，沙箱里只有自己的进程——看不到宿主进程，读不到别的进程的 `/proc/<pid>/environ`，也发不出跨进程信号。PID 1 是一个转发信号的监督者，命令跑在它下面，所以 `kill` 能正常结束命令而不是被 PID 1 忽略。
- **capability**：命令启动前清空 bounding set 与 effective 集合（对齐 bwrap 默认），`CapEff`/`CapBnd` 都是 0。
- **`/tmp`**：私有 tmpfs，不跟宿主的临时文件混在一起（cwd 本身在 `/tmp` 下时跳过，否则会把工作目录挡掉）。
- **设备**：`/dev/null`、`/dev/zero`、`/dev/tty` 等基线设备默认可写，否则 `2>/dev/null` 这种写法会直接失败。

内核要求 **Landlock ABI 7（Linux 6.15+）**，这是能拦住 `open(O_TRUNC)` 绕过的最低下限；ABI 不够时插件干脆不支持，而不是给一个更弱的沙箱。helper 缺失、ABI 不足或宿主不允许 user namespace 时，bash 保持关闭（fail closed），拒绝文案会说明缺什么。`PI_SUBAGENT_EXTEND_HELPER` 可指定二进制路径。

- 条目两种写法：字面量按空白切词逐 token 前缀匹配（`pnpm test` 匹配 `pnpm test -t foo`，不匹配 `pnpm publish`）；`re:` 前缀按正则整串匹配（`"re: ^pnpm -r (test|build)"`）。不自动猜正则——命令参数常含 `*`、`.`，猜错方向是误授权。
- `read` 列放行只读命令（typecheck、grep），`write` 列放行会写文件的命令（测试、构建）。两列都是授权；分类只影响探针的「写入活动」判定。两边都命中时按 write 算。
- 命令里出现 `; & | < > \` $ \` 等元字符直接拒绝，白名单前缀拼不进别的命令。
- 默认断网、范围外只读：写仓库外被拒、联网被拒。`"writable": true` 把 scope 命中的目录给写权限（测试产物落地）；`"network": true` 放开网络。
- `bash.writablePaths`：额外给写权限的路径（绝对路径、`~` 开头或相对 cwd），用于 pnpm store 这类全局可写区。
- `bash.env`：注入沙箱的环境变量（写进 spec 的 `env`）。默认已经注入 `XDG_RUNTIME_DIR`（指向沙箱私有 /tmp）与 worktree 场景下的 `MISE_STATE_DIR`。
- 白名单外的 bash 命令，其拒绝文案会带上探测到的 pnpm store 路径——模型看得见这段文案，能把它连同「父代理需要写什么」一起汇报上来。扩展只探测不自动放行：放行与否是父代理的显式决定。
- `bash.writable` 为真时，额外给写权限：**当前工作目录**（不写的话 git 连索引都写不了）、**`<cwd>/node_modules`**（解析符号链接后的真实路径，pnpm install 要写 `.bin` 里的 shim）、**worktree 根本身**（scope 通常只写到 worktree 里的相对路径，根级的 package.json、node_modules 之类在范围之外）。
- `bash.gitExcludes`（默认 `true`）：给沙箱里的 git 注入全局排除规则（`node_modules/`、`.pnpm-store/`）。沙箱里 pnpm 一定会用项目内的 `.pnpm-store`（见下），否则子代理一句 `git add -A` 就能把几万个依赖文件吸进索引，patch 直接生成失败。
- 找不到 helper 时 fail closed：白名单命令也不执行，拒绝理由说明原因（并给出构建命令）。`PI_SUBAGENT_EXTEND_HELPER` 可指定二进制路径。
- 上限明确：沙箱防的是**越界写和联网**，不是读。跑测试本身就要读整棵树（`node_modules`、配置），所以 `cat` 仓库里范围外的文件在沙箱内仍可读——读的约束仍由 `read`/`grep` 等工具层负责。

## worktree 与 pnpm 的已知边界

pi-subagents 的 managed worktree 会把主仓的 `node_modules` **符号链接**进 worktree（`src/runs/shared/worktree.js: linkNodeModulesIfPresent`）。由此：

- `pnpm install` 在 worktree 里必然失败：pnpm 需要真实的 hoist 目录（`workspace hoist directory is not a real directory`）。这与沙箱无关，是 worktree 布局本身。
- 依赖已就位的验证命令可以用：让 `pnpm run` 不做前置安装即可（项目侧 `pnpm-workspace.yaml` 写 `verifyDepsBeforeRun: false`，pnpm 12 的设置只认这个文件）。
- pnpm 12 把锁目录放在 `XDG_RUNTIME_DIR`（`/run/user/<uid>`）而不是 store 下，所以只读根下连 `pnpm run` 都起不来。扩展默认把 `XDG_RUNTIME_DIR` 指向沙箱私有 /tmp 解决这一条。
- mise 在 worktree 里要把新 worktree 的 `mise.toml` 登记进 `~/.local/state/mise/trusted-configs`，只读根下会在解析配置阶段就失败。扩展在 worktree 场景把 `MISE_STATE_DIR` 指向沙箱私有 /tmp，免掉这次登记。
- **沙箱里 pnpm 默认用项目内 store**：全局 store（`~/.local/share/pnpm/store`）在只读根下不可写，pnpm 探测到之后退回 `<项目>/node_modules/.pnpm-store`。把 store 目录写进 `bash.writablePaths`，`pnpm store path` 就仍然指向全局 store（实测：放行后返回 `~/.local/share/pnpm/store/v11`）。两种都能跑测试——项目内 store 落在 `node_modules/`，那里本来就可写。
- 副作用是项目里可能多出一个几十 MB 的 `.pnpm-store`——扩展用 `core.excludesFile` 保证它进不了 git 索引，但项目自己的 `.gitignore` 仍应忽略 `node_modules/`。
- **装依赖需要联网**：沙箱内 pnpm 用的是项目内的空 store，只能从 registry 下载。`bash.network` 默认关闭，所以 `pnpm install` 在沙箱里必然失败，除非显式开网络。

## 上下文隔离

`AGENTS.md` 是整份进的，子代理会连「怎么委派、怎么等结果、汇报口径」这些只对主代理有意义的段落一起读进去，白占上下文。这个包同时处理它，两种做法按「这段内容属于谁」选：

| 内容 | 放哪 | 子代理看得见吗 |
| --- | --- | --- |
| 子代理也该遵守的（术语、验收命令、代码风格） | `AGENTS.md` 普通段落 | 看得见 |
| 和仓库规则写在一起更顺、但只给主代理 | `AGENTS.md` 里用 `<!-- main-agent-only:start -->` 圈起来 | 看不见 |
| 整段都只给主代理 | `.pi/main-only.md` | 看不见 |

```markdown
## 术语

**Upstream**：指上游的 API。

<!-- main-agent-only:start -->
## 委派

用 `subagent` 工具委派，等结果再决定下一步。汇报口径：改了哪些文件、跑了什么、结果如何。
<!-- main-agent-only:end -->
```

成对标记之间的整段（含两个注释和尾随空行）在子代理的提示词里被删除，主代理照常读。标记不闭合时**整段保留不剥**，并在会话里记一条 warning：宁可让子代理多看见一段，也不要因为猜错边界删掉半个文件。

`.pi/main-only.md`（相对项目根，路径写死）只注入主会话，用 pi 的 `sections` 而不是重写整段提示词——pi 按 section 做差量，只补一条系统消息，前面的提示词缓存仍然命中。

三个入口按**怎么被加载**分受众，不靠运行时猜：

| 入口 | 谁加载 | 行为 |
| --- | --- | --- |
| `src/index.ts` | agent 的 `subagentOnlyExtensions` + 环境加载 | 范围与 bash（本文前半） |
| `src/main-context.ts` | 只走环境加载（`.pi/extensions/` 软链或全局安装） | 主会话注入 `.pi/main-only.md`；后台子代理里改为剥标记 |
| `src/child-context.ts` | 只由 agent 的 `subagentOnlyExtensions` 声明 | 剥标记，永不注入 |

拆两个入口是因为前台子代理和主会话**无法从进程内区分**：前台子代理同进程、没有 `PI_SUBAGENT_CHILD`，环境和主会话一模一样；后台子代理是独立进程、有该变量。所以「只给主代理」的逻辑只能靠加载方式定受众。`main-context.ts` 里那句 `PI_SUBAGENT_CHILD === "1"` 就是用来挡后台子代理的——它同时被环境加载，不挡就漏。

和 pi-subagents 自带的 `inheritProjectContext: false` 不冲突：那个是全有全无（连文件都不读），适合仓库规则对子代理完全无意义的情况；标记法保留单文件、单份维护，适合仓库规则里还有子代理该遵守的部分。

`context: "fork"` 的子代理拿的是父代理整份提示词，project context 一并带过去——要隔离就别用 fork context。

## 配置来源

两条：pi-subagents 的 `extensionBindings`（每次派单时传），以及 agent profile（角色默认值，随 agent 定义声明一次）。都没有时扩展不生效，父会话与未绑定范围的子代理不受影响。已上锁的会话也不再注册下面的用法 skill。

通配符：`**` 任意层目录、`*` 单层内任意字符、`?` 单字符。纯路径 glob 额外匹配该目录自身与其下所有内容：范围写 `src` 或 `src/**` 都覆盖 `src` 全目录。

## Agent profile（角色默认值）

`extensionBindings` 有一个实际的缺口：它只能**每次派单时**由父代理手写，agent 定义里没有声明默认值的地方（pi-subagents 的 frontmatter 字段表里没有 bindings，设置文件里也没有）。忘了传不是「少了三条命令的禁令」，而是 `tool_call` 开头就 `return`——**全部限制消失**。

profile 把默认值挂在「agent 声明了哪个入口」上，因为受众只能靠加载方式区分（前台子代理和主会话在进程内无法区分，见上一节）。

**1. 在项目里写角色默认值** `.pi/subagent-bindings.json`（相对项目根）：

```json
{
  "default": { "maxDenies": 3 },
  "writer": {
    "bash": {
      "read": ["git status", "git diff", "git log", "mise run typecheck"],
      "write": ["mise run test", "mise run check:routing"],
      "writable": true,
      "deny": ["git stash", "git checkout", "git reset", "git clean"]
    }
  },
  "review": { "readOnly": true, "bash": { "read": ["git diff", "rg"], "deny": ["git stash"] } }
}
```

**2. 每个角色一个两行的 loader**，声明角色名：

```ts
// .pi/agent-profiles/writer.ts
import { profile } from "/home/shay/extensions/pi-subagent-extend/packages/pi-plugin/src/profile.ts";
export default profile("writer");
```

**3. agent 定义里把它和主入口一起声明**：

```markdown
subagentOnlyExtensions: …/src/index.ts, .pi/agent-profiles/writer.ts
```

合并规则：

- 本次调用的 `extensionBindings` 按 key 覆盖 profile 的默认值；`bash` **整个对象**覆盖（不合并数组，避免静默扩权）。
- `bash.deny` 取并集，**调用方无法放宽**：项目的骨架命令（`git stash`、`git reset` 之类）即便被写进 `bash.read`/`bash.write` 也进不来。这是「结构性禁掉」和普通白名单的区别。
- profile 不写 `scope` 是合法的（角色不知道本次任务的路径）：此时文件访问全拒、`bash` 白名单照常可用——漏传 bindings 是**响的**失败，子代理第一次读就被拦并汇报缺什么。
- 声明了 profile 却读不到（文件缺失、JSON 坏、既无 `default` 也无该角色名）时**全拒**，不会退回「什么限制都没」。

主会话永远不加载这些 loader，所以项目默认值不会误锁主代理。

## 与 pi-subagents 配合（推荐用法）

前置条件：给需要上锁的 agent 声明扩展。前台子代理不加载 ambient extensions，所以推荐在 agent 定义的 frontmatter 里显式声明（对前台与后台子代理都生效）：

```markdown
---
name: worker
description: 在指定范围内完成实现任务
subagentOnlyExtensions: /home/shay/extensions/pi-subagent-extend/packages/pi-plugin/src/index.ts
---
```

`subagentOnlyExtensions` 只在该 agent 的子代理会话里加载本扩展，父会话不加载。

父代理每次委派时通过 `extensionBindings` 传入本次任务的范围：

```text
subagent(
  agent: "worker",
  task: "修复 login.ts 里的空指针",
  extensionBindings: { "pi-subagent-extend/1": { "scope": ["src/auth/**"], "maxReads": 20 } }
)
```

bindings 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `scope` | `string[]` | 任务范围的 glob 列表；必填，空数组 = 拒绝一切文件访问 |
| `readOnly` | `boolean` | 默认 `false`；`true` 时范围内也禁止 `edit`/`write` |
| `maxReads` | `number` | 可选，成功 read 次数上限 |
| `allowTools` | `string[]` | 可选，额外放行的非执行器工具名 |

namespace 是 `pi-subagent-extend/1`。pi-subagents 把 bindings 编码进 `PI_SUBAGENT_EXTENSION_BINDINGS` 传给子代理，本扩展在激活时一次性读取（前台子代理的该环境变量只在会话启动前存在，之后恢复，不能懒读）。bindings 损坏或 `scope` 非法时 fail closed：会话保持运行但所有文件访问被拒绝，拒绝理由写明原因。

父代理模型需要知道的约定打包成三个 skill，随扩展发布：

| skill | 内容 |
| --- | --- |
| `skills/pi-subagent-extend` | 文件范围、bash 两列与 `re:` 正则、沙箱、调用模板 |
| `skills/pi-subagent-extend-probes` | 四条探针判据、撞权限计数、warn/stop 语义、被停后怎么读汇报 |
| `skills/pi-subagent-extend-context` | `<!-- main-agent-only:start -->` 标记、`.pi/main-only.md`、三个入口的分工 |

扩展用 `resources_discover` 把三个目录一起注册给会话：扩展被加载，skill 就进系统提示的可用列表，模型委派涉及范围限制的子代理时会读到对应那份。不需要往 `AGENTS.md` 或系统提示里写约定。`/skill:pi-subagent-extend`、`/skill:pi-subagent-extend-probes`、`/skill:pi-subagent-extend-context` 可手动加载。

前提：父会话也要加载本扩展，skill 才能到达父代理。`./install.sh` 全局软链即可——父会话没有 bindings，扩展是空操作，无副作用；子代理那一侧的加载用 `subagentOnlyExtensions`（前台生效）或全局自动发现（仅后台子代理）覆盖。

## 不经 pi-subagents 使用

配置通道只有 bindings 一个。没有父代理时，手工导出同一环境变量即可（内容是 bindings 的 JSON）：

```bash
PI_SUBAGENT_EXTENSION_BINDINGS='{"pi-subagent-extend/1":{"scope":["src/**"],"readOnly":true}}' \
pi -e ~/extensions/pi-subagent-extend/packages/pi-plugin/src/index.ts --tools read --no-session -p "<task>"
```

## 安装

```bash
cd packages/pi-plugin
./install.sh
```

软链 `~/.pi/agent/extensions/pi-subagent-extend`，pi 自动发现。范围生效与否完全由配置决定：没有 bindings、环境变量和范围文件时扩展是空操作，全局链接对父会话无害。卸载 `./install.sh --uninstall`。

不装全局链接、只在某个 agent 的子代理里加载时，用 frontmatter 的 `subagentOnlyExtensions`（路径指向本包的 `src/index.ts`；要同时剥上下文标记再加 `src/child-context.ts`），不需要安装步骤。项目级用法：把包目录软链进 `<项目>/.pi/extensions/`，那份加载的是 `index.ts` + `main-context.ts`（即 `package.json` 的 `pi.extensions`），主会话的上下文隔离靠它。

## 开发

```bash
cd packages/pi-plugin && pnpm install && pnpm run typecheck && pnpm test
```

`pnpm test` 是离线的（假 pi，不联网）：范围 27 例 + 上下文 10 例。端到端另有一个 script，跑真会话真模型：

```bash
pnpm run test:e2e                     # 默认模型 buddy/coder-a
PI_E2E_MODEL=buddy/coder-b pnpm run test:e2e
PI_E2E_KEEP=1 pnpm run test:e2e       # 保留临时工程，翻会话记录用
```

它建一个一次性工程（AGENTS.md 带标记、`.pi/main-only.md`、`.pi/extensions/` 软链、两个 agent 定义），然后跑四种会话：主会话、前台子代理（`async:false`）、后台子代理（`async:true`）、以及不装扩展的对照组。判定靠「code 只存在于被隔离的内容里」：主会话与对照组必须答得出，两个子代理必须答 `NONE`。

为什么不是 `pi -p`：`-p` 在父代理空闲时就退出，后台子代理还在跑时进程就没了。它用官方导出的 `RpcClient`（RPC 模式），会话是长寿子进程，父轮不会提前结束，取证由测试自己控制。后台子代理那条的答案由子代理自己写文件，不依赖父轮是否被唤醒。

离线测试不调模型，只验证范围判定与上下文隔离：`node test/extension.test.mjs`、`node test/context.test.mjs`（`pnpm test` 两个都跑）；`node test/e2e.test.mjs` 是真会话验证（见下）。

## 边界与注意

- 范围是文件级不是内容级：范围含 `docs/**` 即允许读全目录。
- `bash` 一律拒绝是设计而非缺陷：shell 命令里的路径无法可靠解析，且能带走环境变量。
- 扩展在 `tool_call` 阶段拦截，不替换沙箱：子代理继承父进程环境与凭据，防误用不防恶意；不可信输入需要容器级隔离。
- 未知工具 fail closed 意味着别的扩展注册的工具也会被拦；确需使用的工具写进 `allowTools`。
- 嵌套子代理不继承 bindings：范围外的子代理不带本扩展的绑定，扩展在其会话里不生效。需要约束嵌套就别给范围会话开 `allowNestedSubagents`，或给嵌套调用显式传 bindings。
