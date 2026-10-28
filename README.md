# pi-allow-reads

pi 扩展：把一个会话（主要是子代理）能碰的文件限制在任务范围内。父代理委派时指定本次任务的文件/目录，子代理会话里范围之外的 tool_call 一律拒绝，防止子代理漫无目的地扫仓库。

| npm package | directory | host | what it does |
| --- | --- | --- | --- |
| `pi-allow-reads` | `packages/pi-plugin` | pi extension | 会话激活时读取任务范围，`tool_call` 阶段拦截范围外的一切调用 |

## 布局

```
packages/pi-plugin       pi 扩展   (src/index.ts, test/extension.test.mjs, install.sh)
```

## 行为

fail closed：范围生效时，下表之外的任何工具也一律拒绝。

| 工具 | 行为 |
|------|------|
| `read` | 解析 path（缺省视为 cwd），命中范围放行，否则拒绝；受 `maxReads` 预算约束 |
| `edit` / `write` | 同上；`readOnly` 时即使范围内也拒绝 |
| `grep` / `find` / `ls` | 同上（path 缺省为 cwd） |
| `bash` / `powershell` / `codemode` | 一律拒绝（没有路径可判，能绕过范围） |
| `structured_output` | 放行（会话级运行时工具，不碰文件系统） |
| 其余未知工具 | 拒绝；`allowTools` 里点名的工具放行（执行器类仍拒绝） |

范围生效时会话开始有提示；`/allowed-reads` 查看当前范围、模式与 read 计数。

## 配置来源

只有一条：pi-subagents 的 `extensionBindings`。没有 bindings 时扩展不生效，父会话与未绑定范围的子代理不受影响。

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

父代理模型需要知道这个约定，在项目 `AGENTS.md`（或父代理系统提示）里加一条即可：

```markdown
委派给 worker 的子代理必须传 extensionBindings 指定任务范围：
extensionBindings: { "pi-allow-reads/1": { "scope": ["<本任务涉及的文件/目录 glob>"] } }
子代理范围外的所有 tool_call 会被拒绝。
```

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
