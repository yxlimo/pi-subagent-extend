# HANDOFF — pi-allow-reads

交接文档。后续独立 agent 接手时读这一份 + `README.md` 即可，不必翻本机历史。

| | |
| --- | --- |
| 交付物 | 一个 pi 扩展：把子代理可碰的文件限制在父代理指定的任务范围内，范围外 tool_call 一律拒绝 |
| 位置 | `/home/shay/extensions/pi-allow-reads/`（独立 git 仓库，本地提交，未推远程） |
| 前身 | 原单文件 `~/extensions/pi-allow-reads.ts`（只读白名单版），本仓库是重写 + 迁移，原文件已删除 |
| 状态 | 已实现、离线测试通过（15 例）、typecheck 通过；活体验证通过（前台子代理拦截 + 父会话 skill 可见） |

## 1. 仓库结构

```
pi-allow-reads/
├── packages/pi-plugin/
│   ├── src/index.ts            扩展本体
│   ├── test/extension.test.mjs 离线测试
│   ├── install.sh              装/卸（软链 ~/.pi/agent/extensions/pi-allow-reads）
│   ├── package.json            pi 清单（"pi.extensions": ["src/index.ts"]）
│   ├── skills/pi-allow-reads/SKILL.md  用法 skill，随扩展注册
│   └── tsconfig.json
├── README.md
└── HANDOFF.md                  本文件
```

只有 pi 一个宿主；`packages/` 那一层是为了跟 `~/extensions/` 下其他仓库布局一致。

## 2. 机制要点

- **配置通道**：pi-subagents 0.83 的 `subagent` 工具有 `extensionBindings` 参数
  （`src/extension/schemas.js`），父代理按次传 JSON，namespace 形如 `包名/版本`。
  pi-subagents 经 `src/runs/shared/child-launch.js` 把它编码进
  `PI_SUBAGENT_EXTENSION_BINDINGS` 环境变量传给子代理。本扩展的 namespace 是
  `pi-allow-reads/1`，在 `src/index.ts` 的 `BINDING_NAMESPACE`。
- **读取时机**：bindings 在扩展激活（factory）时定格。文档
  （pi-subagents `docs/tool-reference.md` 的 extensionBindings 行）明确：前台子代理
  的该环境变量只在会话启动前存在，之后父进程环境恢复，tool_call 里读不到。
  配置通道只有这一个；早先的 `PI_ALLOWED_FILES` / `.pi/allowed-reads.txt` 兜底
  通道已删除。
- **前台子代理不加载 ambient extensions**：要让扩展在子代理里可用，agent 定义必须
  写 `subagentOnlyExtensions`（前台后台都生效）或 `extensions`，或只跑后台子代理
  靠全局自动发现。README 推荐前者。
- **文件来源已删除**：早先按会话 cwd 惰性解析 `.pi/allowed-reads.txt` 的路径
  随旧通道一起移除，策略在激活时一次定格。
- **用法 skill 随扩展加载**：`skills/pi-allow-reads/SKILL.md`（调用模板、字段表、
  注意事项）经 `resources_discover` 事件的 `skillPaths` 注册给会话（pi 1.4 的
  `ResourcesDiscoverResult`；目录会被递归扫描找 `SKILL.md`）。扩展被加载到哪个
  会话，该会话就看到 skill——父代理靠它知道 namespace 与传法，不需要写 `AGENTS.md`。
  该事件在 `session_start` 之后触发；绑定生效的会话（已上锁的子代理）不注册 skill，
  父代理与未上锁会话照常注册。
- **语义变化（相对前身）**：前身把 edit/write/grep/find/ls 一律拒绝；现在范围内
  的 edit/write/grep/find/ls 放行（读写模式），只读场景用 bindings 的 `readOnly`。
  `powershell`/`codemode` 与未知工具仍然一律拒绝。
- **bash 白名单 + bwrap 沙箱**：binding 的 `bash.allow` 给出命令前缀（按空白切词
  逐 token 匹配），命中的命令在 tool_call 里被原地改写成
  `bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp [--unshare-net]
  [--bind <scope dir> <scope dir>] --die-with-parent --chdir <cwd> -- bash -lc '<cmd>'`
  （pi 的 `ToolCallEventResult` 只能 block，改参数得改 `event.input`）。命令含
  `; & | < > \` $ \\` 等元字符一律拒，白名单前缀拼不进别的命令。找不到 bwrap
  时 fail closed。沙箱挡的是越界写与联网，不挡读：跑测试要读整棵树，读的约束仍在
  `read`/`grep` 这些工具层。

## 3. 验收状态

| 编号 | 项 | 状态 | 依据 |
| --- | --- | --- | --- |
| A1 | 无配置时不生效 | ✅ | `node test/extension.test.mjs` 第 1 例 |
| A2 | 范围内放行 / 范围外拒绝 / 执行器与未知工具拒绝 | ✅ | 第 2 例 |
| A3 | readOnly、显式空范围、损坏 bindings fail closed | ✅ | 第 3–5 例 |
| A4 | maxReads 预算、allowTools、缺省 path | ✅ | 第 7–9 例 |
| A5 | 用法 skill 经 resources_discover 注册；已上锁会话不注册 | ✅ | 第 10–11 例 |
| A6 | typecheck | ✅ | `pnpm run typecheck` |
| A7 | 活体验证：父会话可见 skill | ✅ | 2026-10-28 buddy-proxy 内 `pi -p` 列 skill，输出含 `pi-allow-reads` |
| A8 | 活体验证：带 bindings 的前台子代理被拦截 | ✅ | 同日 `be-core` + scope `package.json` 委派，子代理读 `README.md` 被拒，文案含范围与来源 |
| A9 | glob 语义回归（`**` 不被 `*` 规则二次改写；`dir/` 与 `dir`、`dir/**` 等价） | ✅ | 第 15 例；活体：`be-core`/`fe` + scope `web/src/features/balance/**` 放行整目录 |
| A10 | bash 白名单 / 元字符拒绝 / writable / 缺 bwrap 时 fail closed | ✅ | 第 12–14 例 |
| A11 | 活体验证：子代理在沙箱里跑通 typecheck | ✅ | 2026-10-28 buddy-proxy 内 `be-core` + `bash.allow: ["pnpm run typecheck"]`，子代理回报 tsc 通过 |
| A12 | bwrap 隔离属性 | ✅ | 同参数手跑：写 `~/escape-probe` 被拒（Read-only file system）、`curl` 连不上 |

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
3. **bwrap 是外部依赖**：Linux 才有；没装时 bash 关闭但其余功能不受影响。
4. **未做的事**：不改 pi 核心、不改 pi-subagents；没有 opencode 变体（pi 专用）。

## 5. 源码地图

```
packages/pi-plugin/src/index.ts            扩展本体（策略解析 + tool_call 拦截 + skill 注册）
packages/pi-plugin/test/extension.test.mjs 离线测试（15 例）
packages/pi-plugin/install.sh              装/卸
packages/pi-plugin/skills/pi-allow-reads/SKILL.md  用法 skill
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

`maxDenies`（缺省 0 = 关闭）：第 N 次被拒 warn 并提示「向父代理报告缺什么」，第 N+1 次 abort。

### 验收

| # | 项 | 结果 | 证据 |
| --- | --- | --- | --- |
| A13 | bash 两列 + `re:` | ✅ | 测试 16 |
| A14 | 读写归类不影响计时器 | ✅ | 测试 17 |
| A15 | 只读空转 warn → abort；只读任务豁免 | ✅ | 测试 18 |
| A16 | 原地打转 warn → stop | ✅ | 测试 19 |
| A17 | 造杂物拒绝 + 撞权限 warn → stop | ✅ | 测试 20 |
| A18 | 全套离线测试 | ✅ | 20 例通过；typecheck 通过 |
