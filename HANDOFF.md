# HANDOFF — pi-subagent-extend

交接文档。后续独立 agent 接手时读这一份 + `README.md` 即可，不必翻本机历史。

| | |
| --- | --- |
| 交付物 | 一个 pi 扩展，两件事：把子代理可碰的文件限制在父代理指定的任务范围内（范围外 tool_call 一律拒绝）；把主代理专属上下文挡在子代理提示词之外（`AGENTS.md` 标记 + `.pi/main-only.md`） |
| 位置 | `/home/shay/extensions/pi-subagent-extend/`（独立 git 仓库，本地提交，未推远程） |
| 前身 | 原单文件 `~/extensions/pi-allow-reads.ts`（只读白名单版），本仓库是重写 + 迁移，原文件已删除；包名与绑定命名空间改过两次：先 `pi-allow-reads` → `pi-subagent-permission`（2026-11 范围扩展到「子代理权限」），再 → `pi-subagent-extend`（同期收进上下文隔离）；旧名均不再接受 |
| 状态 | 已实现、离线测试通过（范围 27 例 + 上下文 10 例 + helper 14 例）、typecheck 通过；活体验证通过（前台子代理拦截 + 父会话 skill 可见） |

## 1. 仓库结构

```text
pi-subagent-extend/
├── packages/pi-plugin/
│   ├── src/index.ts            扩展本体（范围 + bash + skill 注册）
│   ├── src/main-context.ts     主代理侧上下文：注入 main-only、后台子代理里剥标记
│   ├── src/child-context.ts    子代理侧：剥标记（只由 agent 定义声明）
│   ├── src/context-scope.ts    前两个入口共用的剥离与注入逻辑
│   ├── test/extension.test.mjs 离线测试（范围与 bash，27 例）
│   ├── test/context.test.mjs   离线测试（上下文隔离，10 例）
│   ├── test/e2e.test.mjs       端到端（真会话真模型，4 例，需要模型）
│   ├── install.sh              装/卸（软链 ~/.pi/agent/extensions/pi-subagent-extend）
│   ├── package.json            pi 清单（"pi.extensions": ["src/index.ts", "src/main-context.ts"]）
│   ├── skills/pi-subagent-extend/SKILL.md          用法 skill，随扩展注册
│   ├── skills/pi-subagent-extend-probes/SKILL.md   探针判据
│   ├── skills/pi-subagent-extend-context/SKILL.md  上下文隔离
│   └── tsconfig.json
├── packages/helper/            沙箱 helper（Rust：Landlock + 命名空间）
├── README.md
└── HANDOFF.md                  本文件
```

只有 pi 一个宿主；`packages/` 那一层是为了跟 `~/extensions/` 下其他仓库布局一致。

## 2. 机制要点

- **配置通道**：pi-subagents 0.83 的 `subagent` 工具有 `extensionBindings` 参数
  （`src/extension/schemas.js`），父代理按次传 JSON，namespace 形如 `包名/版本`。
  pi-subagents 经 `src/runs/shared/child-launch.js` 把它编码进
  `PI_SUBAGENT_EXTENSION_BINDINGS` 环境变量传给子代理。本扩展的 namespace 是
  `pi-subagent-extend/1`，在 `src/index.ts` 的 `BINDING_NAMESPACE`。
- **读取时机**：bindings 在扩展激活（factory）时定格。文档
  （pi-subagents `docs/tool-reference.md` 的 extensionBindings 行）明确：前台子代理
  的该环境变量只在会话启动前存在，之后父进程环境恢复，tool_call 里读不到。
  配置通道只有这一个；早先的 `PI_ALLOWED_FILES` / `.pi/permission.txt` 兜底
  通道已删除。
- **前台子代理不加载 ambient extensions**：要让扩展在子代理里可用，agent 定义必须
  写 `subagentOnlyExtensions`（前台后台都生效）或 `extensions`，或只跑后台子代理
  靠全局自动发现。README 推荐前者。
- **文件来源已删除**：早先按会话 cwd 惰性解析 `.pi/permission.txt` 的路径
  随旧通道一起移除，策略在激活时一次定格。
- **用法 skill 随扩展加载**：`skills/pi-subagent-extend/SKILL.md`（调用模板、字段表、
  注意事项）经 `resources_discover` 事件的 `skillPaths` 注册给会话（pi 1.4 的
  `ResourcesDiscoverResult`；目录会被递归扫描找 `SKILL.md`）。扩展被加载到哪个
  会话，该会话就看到 skill——父代理靠它知道 namespace 与传法，不需要写 `AGENTS.md`。
  该事件在 `session_start` 之后触发；绑定生效的会话（已上锁的子代理）不注册 skill，
  父代理与未上锁会话照常注册。
- **语义变化（相对前身）**：前身把 edit/write/grep/find/ls 一律拒绝；现在范围内
  的 edit/write/grep/find/ls 放行（读写模式），只读场景用 bindings 的 `readOnly`。
  `powershell`/`codemode` 与未知工具仍然一律拒绝。
- **bash 白名单 + helper 沙箱**：binding 的 `bash.read` / `bash.write` 给出命令前缀（按
  空白切词逐 token 匹配），命中的命令在 tool_call 里被原地改写成
  `<helper> --spec ~/.cache/pi-subagent-extend/spec-<pid>.json -- bash -lc '<cmd>'`
  （pi 的 `ToolCallEventResult` 只能 block，改参数得改 `event.input`）。helper 是
  `packages/helper` 的 Rust 二进制，在 `exec` 前把自身关进沙箱：Landlock 强制文件范围
  （根可读、只有 spec 列出的目录可写），私有网络命名空间断 TCP/UDP/DNS，私有 mount
  命名空间盖住 nscd/resolved 的 unix socket 并给出私有 /tmp，私有 PID 命名空间加重挂的
  /proc 把宿主进程藏起来（PID 1 是转发信号的监督者，命令在它下面），命令启动前清空
  capability。内核要求 Landlock ABI 7（Linux 6.15+）。命令含 `; & | < > \` $ \\` 等元字符一律拒，白名单前缀拼不进别的
  命令。helper 缺失或 ABI 不足时 fail closed。沙箱挡的是越界写与联网，不挡读：跑测试
  要读整棵树，读的约束仍在 `read`/`grep` 这些工具层。

## 3. 验收状态

| 编号 | 项 | 状态 | 依据 |
| --- | --- | --- | --- |
| A1 | 无配置时不生效 | ✅ | `node test/extension.test.mjs` 第 1 例 |
| A2 | 范围内放行 / 范围外拒绝 / 执行器与未知工具拒绝 | ✅ | 第 2 例 |
| A3 | readOnly、显式空范围、损坏 bindings fail closed | ✅ | 第 3–5 例 |
| A4 | maxReads 预算、allowTools、缺省 path | ✅ | 第 7–9 例 |
| A5 | 用法 skill 经 resources_discover 注册；已上锁会话不注册 | ✅ | 第 10–11 例 |
| A6 | typecheck | ✅ | `pnpm run typecheck` |
| A7 | 活体验证：父会话可见 skill | ✅ | 2026-10-28 buddy-proxy 内 `pi -p` 列 skill，输出含 `pi-subagent-extend` |
| A8 | 活体验证：带 bindings 的前台子代理被拦截 | ✅ | 同日 `be-core` + scope `package.json` 委派，子代理读 `README.md` 被拒，文案含范围与来源 |
| A9 | glob 语义回归（`**` 不被 `*` 规则二次改写；`dir/` 与 `dir`、`dir/**` 等价） | ✅ | 第 15 例；活体：`be-core`/`fe` + scope `web/src/features/balance/**` 放行整目录 |
| A10 | bash 白名单 / 元字符拒绝 / writable / 缺 helper 时 fail closed | ✅ | 第 12–14 例 |
| A11 | 活体验证：子代理在沙箱里跑通 typecheck | ✅ | 2026-10-28 buddy-proxy 内 `be-core` + `bash.allow: ["pnpm run typecheck"]`，子代理回报 tsc 通过 |
| A12 | helper 隔离属性 | ✅ | 2026-11-10 端到端：走扩展 `tool_call` 生成命令后真跑，范围外 `touch` 被拒、`curl` 连不上、`getent hosts` 无结果、网卡只剩 `lo`、`2>/dev/null` 正常；`/proc` 只剩 1..7、宿主 pid 不可见、同用户进程 `environ` 读不到、`kill` 报无此进程、`CapEff`/`CapBnd` 为 0 |
| A13 | 内核能力门槛 | ✅ | `helper --describe` 报 ABI 7 / supported；第 27 例用假 helper 验证 ABI 不足时 bash 被拒 |
| A14 | 进程生命周期 | ✅ | 命令运行期间 helper 存活；`SIGTERM` 到 helper 后命令结束；`SIGKILL` 到 helper 后不产生孤儿（PDEATHSIG）；退出码 0/7/42 逐级透传 |
| A15 | 上下文隔离：三个入口各管一半 | ✅ | `node test/context.test.mjs` 第 7–9 例（主会话注入不剥、后台子代理剥且不注入、前台子代理剥且不注入） |
| A16 | 标记不闭合时降级而非静默 | ✅ | 上下文第 3、10 例：整段保留 + warning |
| A17 | 主代理专属文件的有无两种情形 | ✅ | 上下文第 5–6 例：有则注入 section，无则不动 sections |
| A18 | 端到端：四种会话（主 / 前台子代理 / 后台子代理 / 对照） | ✅ | `pnpm run test:e2e` 4 例；主会话与对照组答出 code，两个子代理答 `NONE`；后台子代理的答案由它自己写的文件取证 |
| A19 | 真实工程（buddy-proxy）的标记剥离 | ✅ | 用 `stripMarkedSections` 跑其 `AGENTS.md`：删 894 字符、33 行，无不闭合、无标记残留；被剥的正是「派单纪律」与「提交前的隐私审查」 |

实测记下来的坑：`pi -p -nt`（`noTools: "all"`）不会把 skills 段放进提示词，模型会回答
「没有可用 skill」。验证 skill 是否注册不要加 `-nt`。

### 已修的工具 bug：glob 二次改写（2026-10-30）

旧实现串联 replace：`**`→`.*` 之后，紧接着的 `*` 规则又把新生成的 `*` 改写掉，导致
`"**"` 编译成 `^.[^/]*$`、`"web/src/**"` 编译成 `^web\/src\/.[^/]*$`——只有精确
文件名能用，通配范围全部失效（派单时表现为「路径不在任务范围内」，很容易被误判成
模型不听话）。现改为单趟扫描生成正则，`*`/`**`/`?` 一次定性，测试第 15 例覆盖。

同一处还修了尾斜杠：`compile()` 只认 `/**` 结尾与无通配的纯路径，`web/src/features/balance/`
既不匹配前者、又因为含 `*?` 以外的字符走纯路径分支，被拼成 `.../balance//**`，一条都匹配
不到。现在先去掉尾斜杠再展开，`dir/`、`dir`、`dir/**` 三种写法等价。

## 4. 遗留

1. **后台子代理路径未实测**：前台（async: false，in-process）已验证；后台子代理走
   ambient discovery，需要全局安装扩展才加载，未单独跑过。
2. **bash 沙箱不约束读**：白名单命令在沙箱里仍能读整棵树（测试要 node_modules 与
   配置）。要连读一起管，只能把命令收得更窄或上更重的方案（per-command seccomp、
   预置测试脚本），当前没做。
3. **helper 是从源码构建的 Rust 二进制**：需要 cargo（`pnpm run build:helper`，
   `install.sh` 也会自动构建）。宿主需 Landlock ABI 7（Linux 6.15+）与可用的 user
   namespace；任一条不满足时 bash 关闭，其余功能不受影响。
4. **未做的事**：不改 pi 核心、不改 pi-subagents；没有 opencode 变体（pi 专用）。

## 5. 源码地图

```text
packages/pi-plugin/src/index.ts            扩展本体（策略解析 + tool_call 拦截 + skill 注册）
packages/pi-plugin/src/profile.ts          agent 角色默认值入口（profile("writer")）
packages/pi-plugin/src/context-scope.ts    上下文隔离逻辑（标记剥离、main-only 注入）
packages/pi-plugin/src/main-context.ts     环境加载入口：主会话注入 / 后台子代理剥标记
packages/pi-plugin/src/child-context.ts    agent 声明的入口：子代理剥标记
packages/pi-plugin/test/extension.test.mjs 离线测试（范围、bash、profile，32 例）
packages/pi-plugin/test/context.test.mjs   离线测试（上下文隔离，10 例）
packages/pi-plugin/install.sh              装/卸
packages/helper/src/                       沙箱 helper（spec/namespace/sandbox/supervise）
packages/pi-plugin/skills/pi-subagent-extend{,-probes,-context}/SKILL.md  三个用法 skill
```

## 6. 相关材料

- pi-subagents bindings 规则：`~/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/extension-bindings.js`
  （namespace 正则、16 KiB/深度/属性数上限）、`docs/tool-reference.md` 搜 extensionBindings
- pi 扩展 API 类型：`~/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
  （`ToolCallEvent` 联合类型、`ToolCallEventResult.block/reason`）
- 同类仓库：`~/extensions/subagent-only-skills/`（布局与测试模板来源）

## bash 读写两列与探针（2026-10-30）

### bash 配置

`bash.allow`（单列表）→ `bash.read` / `bash.write`。两列都是授权面；分类只影响探针的「写入活动」判定。
条目两种写法：字面量（空白切词前缀）与 `re:`（正则整串）。不自动探测正则——参数常含 `*`、`.`，
误授权比误拒绝危险。旧 `allow` 字段仍解析，按 write 处理。

### 探针（src/probe.ts）

四条判据：只读空转（定时器驱动，warn → 宽限 → abort）、原地打转（同命令第 N 次 warn、第 N+1 次停）、
早可收工（bash 输出命中成功标记后 N 分钟无新改动）、造杂物（write/edit 目标命中禁用模式即拒）。

关键决定：
- 「写入活动」= edit/write 调用 + ��中 `bash.write` 的命令。`bash.read` 不算，否则拿 bash 只读打转
  就绕过判据。这条是本仓最容易再次搞错的地方。
- warn 的载体只能是「拦下一次 tool_call」：定时器到点自己拦不了正在跑的调用。abort 走
  `ctx.actions.abort()`，不等边界；混批时 `terminate: true` 兜底。
- `readOnly: true` 的任务跳过两条时间判据。
- 定时器 unref + `session_shutdown` 清理，避免残留。

### 撞权限（src/deny-count.ts）

`maxDenies`（缺省 3，写 0 关闭）：第 N 次被拒 warn 并提示「向父代理报告缺什么」，第 N+1 次停。

### 验收

| # | 项 | 结果 | 证据 |
| --- | --- | --- | --- |
| A13 | bash 两列 + `re:` | ✅ | 测试 16 |
| A14 | 读写归类不影响计时器 | ✅ | 测试 17 |
| A15 | 只读空转 warn → abort；只读任务豁免 | ✅ | 测试 18 |
| A16 | 原地打转 warn → stop | ✅ | 测试 19 |
| A17 | 造杂物拒绝 + 撞权限 warn → stop | ✅ | 测试 20 |
| A18 | 全套离线测试 | ✅ | 21 例通过；typecheck 通过 |
| A19 | 真机：原地打转 | ✅ | `fe` + 同一条 `pnpm run typecheck` 连跑，第 3 次 warn、第 4 次停，子代理输出了完整汇报 |
| A20 | 真机：只读空转 | ✅ | `be-core` + `idleWriteMs/abortGraceMs = 2s`，被停后汇报「交付受阻 + 需要父代理放行什么」 |
| A21 | 真机：早可收工 | ✅ | `be-core` + `successIdleMs = 1s`，typecheck 命中成功标记后 1 秒停，汇报写明被哪条判据停下 |
| A22 | 真机：撞权限 | ✅ | `fe` + `maxDenies = 2`，第 3 次被拒后停，转告父代理扩权 |

### 停机方式的两个坑（2026-10-30 实测）

1. **不能用 `ctx.actions.abort()`**：硬 abort 会把模型正在生成的收尾汇报一起掐掉，父代理只收到一条工具错误。
   实测同一个任务：带 abort 时最终输出被截断成一行「先确认 typecheck 脚本所在位置」，去掉后是完整汇报。
2. **也不能用 `terminate: true`**：pi 在工具批次结束时直接结束本轮，模型仍然拿不到一个 turn 写汇报。
   最终方案：停机只置内部状态，之后每个 tool 边界都返回 `block`（不带 terminate），模型失去工具后自然收敛到输出汇报。

## worktree setup hook（2026-11-14）

需求：worktree 里的 `node_modules` 是指向主仓的符号链接，pnpm 会把它重建成层级错误的相对链接，导致 tsc 找不到包；希望子代理启动前在工作树里先跑特定命令。

查过：pi-subagents 已经官方支持这条，不需要新造——`worktreeSetupHook` + `worktreeSetupHookTimeoutMs`，配在 `~/.pi/agent/extensions/subagent/config.json`，每个 worktree 创建后跑一次，stdin 给 `{repoRoot, worktreePath, agentCwd, branch, index, runId, baseCommit}`，stdout 必须是一个 JSON（`syntheticPaths` 在 diff 前删掉）。

实现：`scripts/worktree-setup.mjs`，先探测再装。三条实测结论：

1. **符号链接必须先 unlink。** 直接 `pnpm install` 会顺着链接装进目标，链接本身不被替换，故障原样存在（同目录下实测确认）。
2. **探针是判据，安装器退出码只进日志。** pnpm 12 装完所有依赖后仍因 `ERR_PNPM_IGNORED_BUILDS` 返回 1，按退出码判失败会误拒每次 launch。
3. **安装根要能处理没有根 manifest 的仓。** 本仓包在 `packages/pi-plugin`，只扫一层会扫到 `packages/`（无 package.json）而放过真正的包——改成 ≤2 层有界扫描。

真机验证（本仓，`worktree: true`）：worktree 内 `packages/pi-plugin/node_modules` 是真实目录，`typescript` 解析路径落在 worktree 内部（非主仓），`tsc --noEmit` 退出码 0；hook 日志 `~/.cache/pi-worktree-setup/<runId>.log` 记录 `ready <worktree>/packages/pi-plugin`。

一个容易误判的现象：在 worktree **根**执行 `ls node_modules` / `require.resolve('typescript')` 会失败，因为本仓根本没有根 manifest；判据要放在 `packages/pi-plugin` 下。第一轮实验就是撞了这个，差点误判成 hook 没生效。

## Agent profile：角色默认值（2026-11-14）

### 要解决的问题

`extensionBindings` 只有「每次派单时手写」一个入口。忘了传不是少几条命令的禁令，而是 `tool_call` 开头 `if (!policy.active) return`——**全部限制消失**。授权面于是依赖父代理每次记得写全。

### 为什么不能「项目级运行时自动检测」

查过上游，官方没有声明默认值的位置：

- `docs/agents.md` 的 agent 字段表（到 `memory` 为止）有 `tools`/`excludeTools`/`extensions`/`subagentOnlyExtensions`/`toolBudget`/`acceptance`……**没有 bindings**。
- `docs/configuration.md` 里 `extension-bindings` 只出现在 `disabledFeatures` 表——那是「禁掉这个 per-call 参数」的开关，不是默认值。
- 子代理进程能拿到的身份仅三个变量，且都不是通用信号：`PI_SUBAGENT_EXTENSION_BINDINGS`（**只在真传了 bindings 时才设**，`encodeExtensionBindings(undefined) → undefined`）、`PI_SUBAGENT_CHILD` 与 `PI_SUBAGENT_PARENT_SESSION`（**只给后台 runner**，`async-execution.js:555` 是唯一赋值处）。没有 agent 名的环境变量，也没有 `--name`。

所以「忘了传 bindings 的前台子代理」与主会话在环境上**完全一样**，`session_start` 读 `.pi/subagent-bindings.json` 自动生效会连主会话一起锁。受众只能靠加载方式区分。

### 做法

`src/profile.ts` 导出 `profile(name)`，返回一个扩展工厂；agent 在 `subagentOnlyExtensions` 里声明这份两行 loader，主会话不加载，天然 child-only。默认值数据放项目 `.pi/subagent-bindings.json`，按角色分键。

合并语义（`mergeConfig` / `parsePolicyObject`）：

- 调用方的键覆盖 profile，`bash` **整个对象**覆盖（不合并数组，避免静默扩权）。
- `bash.deny` 取并集，**调用方无法放宽**——这才是用户要的「结构性禁掉」，因为纯默认值会被显式 bindings 覆盖。
- profile 允许不写 `scope`：文件全拒、命令白名单照用，漏传是响的失败。
- profile 读不到（文件/JSON/两个键都没有）→ `denyAll`，不退回不设限。
- 本次 bindings 自己写坏时保持全拒，不让 profile 把它盖成「可用」。

### 实现上的接缝

bindings 必须在 factory 定格（前台子代理的 env 只在会话启动前存在），profile 却是文件、要按会话 `cwd` 读，所以在 `session_start` 解析，并把 `policy`/`probe`/`denyCounter` 从 `const` 改为可重建（`armProbe()`）。

### 验收

离线 32 例（新增 5 例：profile 默认值生效、与 bindings 合并、调用方覆盖 bash、deny 不可放宽含 `/permission` 可见、profile 缺失时失败关闭）。

写测试踩的一个坑：`await plain.call(...)?.block` 会被解析成 `await (promise?.block)`—— `?.` 先绑在 Promise 上，永远得 `undefined`，看起来像策略失效。先 `const r = await …` 再判。

## 升级为「子代理全套件」与上下文隔离（2026-11-13）

包名从 `pi-subagent-permission` 改为 `pi-subagent-extend`，定位从「只管权限」扩成「子代理相关的一次收齐」。
没有兼容别名：旧标识一律拒绝，而不是两套并行。

### 命名改动范围

仓库内 135 处引用（13 个跟踪文件），含 npm 名、helper crate 与二进制名、
`PI_SUBAGENT_EXTEND_HELPER` 环境变量、`~/.cache/pi-subagent-extend` 缓存目录、`/tmp/.pi-subagent-extend-<pid>`、
`pi-subagent-extend/1` 绑定命名空间、拒绝文案前缀、两个 skill 目录。三种命名形式都要一起换：
带连字符的（包名/路径）、带下划线的（crate）、全大写的（环境变量）——只换拼写形式容易漏。

仓库外同步了三处：buddy-proxy 的 9 个 agent 定义（`subagentOnlyExtensions`）、`.pi/README.md`、
以及 `tools/subagent-watch.ts` 里数拒绝次数的正则（不入 git，但前缀改了会静默失配）。
项目级软链 `pi-subagent-permission` 悬空后必须重建，否则扩展根本不加载。

### 三个入口按「怎么被加载」分受众

前台子代理同进程、没有 `PI_SUBAGENT_CHILD`，和主会话的环境无法区分；后台子代理是独立进程、有该变量。
所以「只给主代理」的逻辑不能靠运行时判断，只能靠加载方式定受众：

| 入口 | 加载方式 | 行为 |
| --- | --- | --- |
| `src/index.ts` | agent 声明 + 环境加载 | 范围与 bash |
| `src/main-context.ts` | 只走环境加载 | 主会话注入 `.pi/main-only.md`；后台子代理（`PI_SUBAGENT_CHILD === "1"`）里剥标记 |
| `src/child-context.ts` | 只由 agent 声明 | 剥标记，永不注入 |

注入用 `sections`（`main_only_instructions`）而不是重写整段 systemPrompt：pi 按 section 做差量，
只补一条系统消息，提示词缓存仍命中。剥离是就地在 `systemPromptOptions.contextFiles[i].content` 上做，
标记不闭合时整段保留并给 warning——宁可让子代理多看见一段，也不要因为猜错边界删掉半个文件。

### 顺手清掉的死代码

改后暴露的既有问题：`Probe` 收下 `bashRule` 却从不读（分类早就由调用方完成）——连同
`ProbeDeps.bashRule`、构造函数赋值、测试里的构造参数一起删；`#schedule` 返回 `unknown` 换成
`TimerHandle = object | number`（Node 的 Timeout 对象或假时钟的数字）；`status()` 里的嵌套三元改 if/else；
`as unknown as` 补 SAFETY 注释说明不变量。

### 修正了一个错误的因果解释

README 原写「沙箱里 pnpm 一定用项目内 `.pnpm-store`，因为 bwrap 把项目目录单独 bind 成挂载点，
跨挂载无法建硬链接」。helper 换掉 bwrap 后这条已经不成立（helper 只做 MS_PRIVATE、私有 /tmp、新 /proc，
不 bind 项目目录）。实测定位到真正原因：**是写权限不是挂载**——只读根下全局 store 不可写，pnpm 就退回
`<项目>/node_modules/.pnpm-store`；把 store 写进 `bash.writablePaths` 后 `pnpm store path` 回到
`~/.local/share/pnpm/store/v11`（沙箱内实测）。两种都能跑测试，因为项目内 store 落在本来就可写的
`node_modules/` 下。

验证：`pnpm run typecheck` 通过；`node test/extension.test.mjs` 27 例、`node test/context.test.mjs` 10 例、
`cargo test` 14 例全绿；`node test/e2e.test.mjs` 4 例真会话全绿（含真实 `async:true` 后台子代理）。

### 端到端测试的形状（为什么不用 `pi -p`）

`pi -p` 在父代理空闲时退出。后台子代理（`async:true`）还在跑的时候父进程没了，取证只能靠事后翻文件，
而「父轮提前结束」本身就是被测行为的一部分。改用 pi 官方导出的 `RpcClient`（`--mode rpc`）：
会话是长寿子进程，什么时候结束由测试决定。

两个使用要点：

- `RpcClient` 缺省的 `cliPath` 是相对 **cwd** 的 `dist/cli.js`，而测试的 cwd 是临时工程，会直接报
  `Cannot find module '<工程>/dist/cli.js'`。用 `import.meta.resolve("@earendil-works/pi-coding-agent")`
  解析出包入口，再取同目录的 `cli.js` 显式传入。
- 取证不依赖父轮被唤醒：后台子代理的 task 要求它把答案写进 `.pi/child-answer.txt`，测试轮询该文件。
  因为答案里若出现 code 就说明泄露，而父代理**看得见** code（它若代笔就会写成真 code），
  所以「文件里是 NONE」本身就证明是子代理写的。

判定设计：提问里不含任何 code，code 只存在于被隔离的内容里；再加一个不装扩展的对照组，
它必须答得出 code——否则「答 NONE」就分不清是剥离生效还是模型没找到内容。

### 标记改用 `main-agent-only:start/end`（2026-11-13）

原本用自定义的 `<!-- main-only -->`，但 buddy-proxy 的 `AGENTS.md` 早已圈好了一段，用的是
`<!-- main-agent-only:start -->` … `<!-- main-agent-only:end -->`。按实际在用的那套统一，
不再维护第二种写法（旧标记现在不识别，也不做兼容）。文件名 `.pi/main-only.md` 保持不变——
那是「整段只给主代理」的第二个机制，与标记不是一回事。
