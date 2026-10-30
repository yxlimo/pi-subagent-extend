# pi-allow-reads

pi 扩展：把一个会话（主要是子代理）能碰的文件限制在任务范围内。父代理委派时指定本次任务的文件/目录，子代理会话里范围之外的 tool_call 一律拒绝，防止子代理漫无目的地扫仓库。

| npm package | directory | host | what it does |
| --- | --- | --- | --- |
| `pi-allow-reads` | `packages/pi-plugin` | pi extension | 会话激活时读取任务范围，`tool_call` 阶段拦截范围外的一切调用 |

## 布局

```
packages/pi-plugin       pi 扩展   (src/, test/extension.test.mjs, install.sh, skills/pi-allow-reads{,-probes}/SKILL.md)
```

## 行为

fail closed：范围生效时，下表之外的任何工具也一律拒绝。

| 工具 | 行为 |
|------|------|
| `read` | 解析 path（缺省视为 cwd），命中范围放行，否则拒绝；受 `maxReads` 预算约束 |
| `edit` / `write` | 同上；`readOnly` 时即使范围内也拒绝 |
| `grep` / `find` / `ls` | 同上（path 缺省为 cwd） |
| `bash` | 没配白名单时一律拒绝；配了则只放行 `bash.read` / `bash.write` 命中的命令，并改写为 bwrap 沙箱里执行（根只读、默认断网、scope 可写需 `writable`）；命令含 shell 元字符直接拒绝 |
| `powershell` / `codemode` | 一律拒绝（没有路径可判，能绕过范围） |
| `structured_output` | 放行（会话级运行时工具，不碰文件系统） |
| 其余未知工具 | 拒绝；`allowTools` 里点名的工具放行（执行器类仍拒绝） |

范围生效时会话开始有提示；`/allowed-reads` 查看当前范围、模式、bash 白名单、read 计数、撞权限计数与探针状态。

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
{ "pi-allow-reads/1": { "scope": ["lib/router/**"], "bash": { "read": ["pnpm run typecheck"], "write": ["pnpm test"] } } }
```

放行的命令会改写成：

```
bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --unshare-net --die-with-parent --chdir <cwd> -- bash -lc '<命令>'
```

- 条目两种写法：字面量按空白切词逐 token 前缀匹配（`pnpm test` 匹配 `pnpm test -t foo`，不匹配 `pnpm publish`）；`re:` 前缀按正则整串匹配（`"re: ^pnpm -r (test|build)"`）。不自动猜正则——命令参数常含 `*`、`.`，猜错方向是误授权。
- `read` 列放行只读命令（typecheck、grep），`write` 列放行会写文件的命令（测试、构建）。两列都是授权；分类只影响探针的「写入活动」判定。两边都命中时按 write 算。
- 命令里出现 `; & | < > \` $ \` 等元字符直接拒绝，白名单前缀拼不进别的命令。
- 默认只读根、断网：写仓库外被拒、联网被拒。`"writable": true` 把 scope 命中的目录绑成可写（测试产物落地）；`"network": true` 放开网络。
- 找不到 `bwrap` 时 fail closed：白名单命令也不执行，拒绝理由说明原因。`PI_ALLOW_READS_BWRAP` 可指定二进制路径。
- 上限明确：沙箱防的是**越界写和联网**，不是读。跑测试本身就要读整棵树（`node_modules`、配置），所以 `cat` 仓库里范围外的文件在沙箱内仍可读——读的约束仍由 `read`/`grep` 等工具层负责。

## 配置来源

只有一条：pi-subagents 的 `extensionBindings`。没有 bindings 时扩展不生效，父会话与未绑定范围的子代理不受影响。已上锁的会话也不再注册下面的用法 skill。

通配符：`**` 任意层目录、`*` 单层内任意字符、`?` 单字符。纯路径 glob 额外匹配该目录自身与其下所有内容：范围写 `src` 或 `src/**` 都覆盖 `src` 全目录。

## 与 pi-subagents 配合（推荐用法）

前置条件：给需要上锁的 agent 声明扩展。前台子代理不加载 ambient extensions，所以推荐在 agent 定义的 frontmatter 里显式声明（对前台与后台子代理都生效）：

```markdown
---
name: worker
description: 在指定范围内完成实现任务
subagentOnlyExtensions: /home/shay/extensions/pi-allow-reads/packages/pi-plugin/src/index.ts
---
```

`subagentOnlyExtensions` 只在该 agent 的子代理会话里加载本扩展，父会话不加载。

父代理每次委派时通过 `extensionBindings` 传入本次任务的范围：

```
subagent(
  agent: "worker",
  task: "修复 login.ts 里的空指针",
  extensionBindings: { "pi-allow-reads/1": { "scope": ["src/auth/**"], "maxReads": 20 } }
)
```

bindings 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `scope` | `string[]` | 任务范围的 glob 列表；必填，空数组 = 拒绝一切文件访问 |
| `readOnly` | `boolean` | 默认 `false`；`true` 时范围内也禁止 `edit`/`write` |
| `maxReads` | `number` | 可选，成功 read 次数上限 |
| `allowTools` | `string[]` | 可选，额外放行的非执行器工具名 |

namespace 是 `pi-allow-reads/1`。pi-subagents 把 bindings 编码进 `PI_SUBAGENT_EXTENSION_BINDINGS` 传给子代理，本扩展在激活时一次性读取（前台子代理的该环境变量只在会话启动前存在，之后恢复，不能懒读）。bindings 损坏或 `scope` 非法时 fail closed：会话保持运行但所有文件访问被拒绝，拒绝理由写明原因。

父代理模型需要知道的约定打包成两个 skill，随扩展发布：

| skill | 内容 |
| --- | --- |
| `skills/pi-allow-reads` | 文件范围、bash 两列与 `re:` 正则、沙箱、调用模板 |
| `skills/pi-allow-reads-probes` | 四条探针判据、撞权限计数、warn/stop 语义、被停后怎么读汇报 |

扩展用 `resources_discover` 把两个目录一起注册给会话：扩展被加载，skill 就进系统提示的可用列表，模型委派涉及范围限制的子代理时会读到对应那份。不需要往 `AGENTS.md` 或系统提示里写约定。`/skill:pi-allow-reads` 与 `/skill:pi-allow-reads-probes` 可手动加载。

前提：父会话也要加载本扩展，skill 才能到达父代理。`./install.sh` 全局软链即可——父会话没有 bindings，扩展是空操作，无副作用；子代理那一侧的加载用 `subagentOnlyExtensions`（前台生效）或全局自动发现（仅后台子代理）覆盖。

## 不经 pi-subagents 使用

配置通道只有 bindings 一个。没有父代理时，手工导出同一环境变量即可（内容是 bindings 的 JSON）：

```bash
PI_SUBAGENT_EXTENSION_BINDINGS='{"pi-allow-reads/1":{"scope":["src/**"],"readOnly":true}}' \
pi -e ~/extensions/pi-allow-reads/packages/pi-plugin/src/index.ts --tools read --no-session -p "<task>"
```

## 安装

```bash
cd packages/pi-plugin
./install.sh
```

软链 `~/.pi/agent/extensions/pi-allow-reads`，pi 自动发现。范围生效与否完全由配置决定：没有 bindings、环境变量和范围文件时扩展是空操作，全局链接对父会话无害。卸载 `./install.sh --uninstall`。

不装全局链接、只在某个 agent 的子代理里加载时，用 frontmatter 的 `subagentOnlyExtensions`（路径指向本包的 `src/index.ts`），不需要安装步骤。

## 开发

```bash
cd packages/pi-plugin && pnpm install && pnpm run typecheck && pnpm test
```

离线测试不调模型，只验证范围判定：`node test/extension.test.mjs`。

## 边界与注意

- 范围是文件级不是内容级：范围含 `docs/**` 即允许读全目录。
- `bash` 一律拒绝是设计而非缺陷：shell 命令里的路径无法可靠解析，且能带走环境变量。
- 扩展在 `tool_call` 阶段拦截，不替换沙箱：子代理继承父进程环境与凭据，防误用不防恶意；不可信输入需要容器级隔离。
- 未知工具 fail closed 意味着别的扩展注册的工具也会被拦；确需使用的工具写进 `allowTools`。
- 嵌套子代理不继承 bindings：范围外的子代理不带本扩展的绑定，扩展在其会话里不生效。需要约束嵌套就别给范围会话开 `allowNestedSubagents`，或给嵌套调用显式传 bindings。
