---
name: pi-allow-reads-probes
description: 给受限子代理配置探针判据时使用：只读空转、原地打转、早可收工、造杂物、撞权限。写明 extensionBindings 里 pi-allow-reads/1 的 maxDenies 与 probe 字段、默认值、warn 与 stop 的停机语义，以及子代理被停后如何读它的汇报。文件范围与 bash 白名单见 skill pi-allow-reads。
---

# 探针：检测子代理的空转与无效工作

范围限制（`scope`）只用来看住「能碰哪些文件」；探针看的是「有没有在推进」。两者共用同一次委派的 `extensionBindings`，namespace 同为 `pi-allow-reads/1`。

判据全部 fail closed：命中之后不再放行任何工具调用，子代理只能写汇报。

## 默认行为

不写 `probe` 时只有两条纯错误信号在工作，误伤小：

| 判据 | 默认 | 说明 |
| --- | --- | --- |
| 原地打转 | 开，`repeatBash: 3` | 同一条 bash 命令原文（trim 后）第 3 次 → warn，第 4 次 → stop |
| 撞权限 | 开，`maxDenies: 3` | 连续被范围规则拒绝第 3 次 → warn，第 4 次 → stop |

会误伤慢任务的三条必须显式配置：`probe: {}` 一次打开全部默认值，写部分字段则只打开写到的那些，`probe: false` 全关。

| 判据 | 字段 | 默认值（显式开启后） | 触发 |
| --- | --- | --- | --- |
| 只读空转 | `probe.idleWriteMs` / `probe.abortGraceMs` | 6 分钟 / 2 分钟 | 这么久没有任何写入活动 → warn；再过宽限 → stop |
| 早可收工 | `probe.successIdleMs` / `probe.successPatterns` | 5 分钟 / `["fail=0", "0 failed", ...]` | bash 输出命中成功标记后，这么久无新改动 → stop |
| 造杂物 | `probe.forbidWritePatterns` | `[]` | `write`/`edit` 目标路径命中正则 → 直接拒绝该次写入 |

## 什么算「写入活动」

只有两种事件会重置空转计时器：

1. `edit` / `write` 工具调用
2. bash 命令命中 `bash.write` 列

`bash.read` 列的命令、`read` / `grep` / `find` / `ls` 都不算。所以「拿 bash 只读命令反复打转」和「拿读工具反复扫」一样会被判成空转——这是有意为之：只读命令刷得再多也不算推进。

推论：如果任务确实需要大量只读调查，要么把 `idleWriteMs` 放宽，要么设 `readOnly: true`（它会跳过「只读空转」和「早可收工」两条时间判据）。

## 配置模板

```json
"pi-allow-reads/1": {
  "scope": ["web/src/features/balance/**"],
  "bash": { "read": ["pnpm run typecheck"], "write": ["pnpm test"] },
  "maxDenies": 3,
  "probe": {
    "idleWriteMs": 360000,
    "abortGraceMs": 120000,
    "successIdleMs": 300000,
    "successPatterns": ["0 failed"],
    "forbidWritePatterns": ["_tscProbe", "TestHooks", ".*\\.src\\.tsx"]
  }
}
```

## 停机语义（父代理必须知道）

warn 只拦一次 tool_call 并把理由写给它；stop 之后**每个** tool 边界都拒绝。

停机既不调 `ctx.abort()` 也不用 `terminate`：两者都会把子代理正在写的收尾汇报一起掐掉（实测带 abort 时最终输出只剩一行）。所以被停的子代理**一定能给出汇报**——里面通常写着「已完成什么、缺什么授权、下一步打算」。

因此：

- 被停的汇报是诊断，不是任务结果。按它补授权或补信息再重派，**不要原样重试**。
- 汇报里常说「请放开某条命令」或「请把某文件加进 scope」，那是判断该扩什么范围的依据。
- 子代理也可能用 `contact_supervisor` 主动上报（该工具始终放行），那条消息同样值得读。

## 作为父代理的注意事项

- 「早可收工」的坑：成功标记命中后只要还有新改动就不停，但任务若在验证之后还要继续做别的事，就会被判「该收工了」。**把验证命令放在任务最后一步**，或者不要给它配这一条。
- `successPatterns` 默认是 `fail=0` / `0 failed` 这类测试汇总标记；项目用别的输出格式就自己写（如 `no errors`、`All files pass`）。别写成过宽的 `ok`、`passed`——几乎每条命令都会命中。
- 想限制子代理乱写调试文件，用 `forbidWritePatterns` 点名，如 `_tscProbe`、`TestHooks`、`.*\.src\.tsx`。命中是拒绝单次写入，不停机。
- 同一轮委派里反复出现「原地打转」说明任务描述有问题（要求它重复同一动作），先修任务而不是调大 `repeatBash`。
- 探针只管确定性信号。语义层面的漏测、不安全改动，交给 pi-subagents 自带的 LLM watchdog（`subagents.watchdog`），两者互补。

## 与 pi-subagents 自带能力的配合

委派规则（brief 怎么写、一个 cwd 一个写者、resume/steer 的用法）以 **pi-subagents 自带的 skill** 为准，本 skill 只讲探针这一层：范围限制管「能碰什么」，探针管「有没有在推进」。

pi-subagents 的 skill 已经规定了等待方式——派完活让出回合，靠原生完成通知唤醒，不要 sleep、不要轮询、不要对普通子代理用 `bg_wait`。要查细节按需读一节，不要通读：

```
subagent({ action: "guide", options: { topic: "tool-reference/execution-parameters" } })
subagent({ action: "guide", options: { topic: "workflows/supervisor-coordination-child-asks-parent" } })
```

本文下面列的 topic 都是 pi-subagents 随包文档里的真实小节名，版本升级后按同一地址读即可。

| 想查 | guide topic |
| --- | --- |
| `timeoutMs` / `toolTimeoutMs` / `checkpointBeforeDeadlineMs` / `toolBudget` / `extensionBindings` | `tool-reference/execution-parameters` |
| 查子代理状态与 transcript | `tool-reference/status` |
| 保留子代理、resume 资格 | `tool-reference/retained-children` |
| resume / steer / stop 的确切语义 | `tool-reference/resume`、`tool-reference/steer`、`tool-reference/stop` |
| 验收证据与 gate | `tool-reference/acceptance-gates` |
| 子代理主动问父代理（`contact_supervisor`） | `workflows/supervisor-coordination-child-asks-parent` |
| LLM watchdog 的触发时机与模型选择 | `watchdog/when-it-runs`、`watchdog/choosing-a-model` |

探针只管确定性信号（计数、时间、路径模式），下面几项管的是别的事，配好之后不需要探针再做。

### 分工表

| 需求 | 该用谁 | 怎么配 |
| --- | --- | --- |
| 整个 run 最多跑多久 | 原生 run 级 deadline | `options.timeoutMs`（或 agent frontmatter `timeoutMs`）；到期即终局 |
| 单个 tool call 卡死 | 原生 tool deadline | 已知快命令默认 5 分钟；要改就 `options.toolTimeoutMs` |
| 快到期时先收尾 | 原生 checkpoint steer | `options.checkpointBeforeDeadlineMs`（**仅 async 单代理**）：到点前在下一个 tool 边界投递「checkpoint and stop」，要求报改动/构建测试状态/剩余工作 |
| 工具调用总数封顶 | 原生 `toolBudget` | `{ soft, hard, block }`；到 hard 后默认封 read/grep/find/ls。**写实现类子代理别设**（会先封读不封写） |
| 语义质量：漏测、越界改、循环风险 | 原生 LLM watchdog | `subagents.watchdog`，边界 review + 每 N 个 tool 的 cadence review，high 级会发现给模型 |
| 交付验收：改了哪些文件、测试跑没跑 | 原生 acceptance gate | `options.gate: "pnpm test"` 或 `acceptance: { level, criteria, evidence, verify }` |
| 子代理中途要资源/要授权 | `contact_supervisor` / `intercom` | 始终放行；也可以父代理 `subagent({ action: "steer", id, message })` 反向插话 |
| 空转、打转、验证完不收工、乱写临时文件 | **探针** | 本文档上面几条 |

### 具体的配合方式

**探针 + run deadline。** deadline 管总时长，探针管「有动作但没推进」。两个都开时注意：`checkpointBeforeDeadlineMs` 会在 deadline 前发收尾 steer，若此时探针也判了空转，子代理会同时收到两个指令，以先到的为准。实践上：主任务用 `timeoutMs` 兜底，`idleWriteMs` 设在 `timeoutMs` 的三分之一左右，让它比总超时更早发现空转。

**探针 + acceptance gate。** 「早可收工」靠 bash 输出里的成功标记推断验证已过，是启发式的；真正的验收应该交给 gate——`gate: "pnpm test"` 由宿主执行并把结果记成证据。所以：**验证命令交给 gate，探针里不要配 `successPatterns` 去猜**。两者同时开时，`successPatterns` 若命中得太早（比如命令回显而不是真实结果），会把还在干活的子代理误判成该收工。

**探针 + 撞权限 + steer。** 撞权限停下后父代理有两种走法：重新派一单（探索型任务，成本低）或对保留的会话 `resume` 补授权续做（长任务，不想重来）。`resume` 会复用原子代理的 session 与契约，bindings 属于新一次 launch，可以改。

**探针 + LLM watchdog。** 不冲突，配置通道不同：探针走 `extensionBindings`，watchdog 走 settings 的 `subagents.watchdog`。watchdog 自己有一条 `stalemateRepeats`（默认 3 次同样 warning）会结束轮次，那是语义层面的；探针的打转判据是命令层面的，两者可能同时命中，不重复计费也不用互相关闭。

**探针 + 后台运行。** 后台（`async: true`）子代理在独立进程里跑，探针照常工作；`checkpointBeforeDeadlineMs` 只在 async 单代理上有效，前台阻塞运行时没有这个收尾机制，靠探针的 stop 让子代理写汇报。

### 等待方式：让出回合，不要 sleep

父代理派完活以后**不要自己 sleep 轮询**——原生完成通知会唤醒会话。而且 sleep 会占着父代理的前台 tool call，让它一直处于忙状态，完成通知于是降级成 steering 消息追加，反而更晚才到。

- 普通 async 子代理：派完就结束这一轮，等通知
- 必须在当前轮等结果：`bg_wait({ id, stopOnAttention: false })`
- 长驻交互会话：`bg_wait({ id, nonBlocking: true })`
- 想中途看进展：`subagent({ action: "status", id, options: { view: "transcript", lines: 80 } })`，按需查，不循环

别拿 `lastUpdate` 当心跳判断存活：runner 每秒在内存推进它，但只在活动分类变化时才重写 `status.json`，一次长时间安静的工具调用会让文件看起来是陈旧的。

### 不要叠加的东西

- **不要给写实现类子代理设 `toolBudget.hard`**：它先封读和搜索，子代理拿不到上下文反而更容易空转，探针随后把 run 判死，看起来像探针误伤。要限制就限制范围（`scope`）和时长（`timeoutMs`）。
- **不要同时配 `successPatterns` 和 gate 的同一份验证**：一处判成功就够了，两处容易先后不一致。
- **不要用 `probe: false` 来「省事」**：默认只开打转和撞权限，关掉等于放弃两个最便宜的错误信号。真要静音就写 `probe: { repeatBash: 50 }` 这类具体放宽。

## 与 review 子代理（sidecar 评审）配合

评审子代理在主流程之外旁挂：写实现的那单不管评审，评审单自己起一个 fresh-context 子代理看 diff。它和探针的关系是**两类 agent 配两套 bindings**。

### sidecar 评审的形态

| 形态 | 谁起 | 怎么用 |
| --- | --- | --- |
| `/parallel-review` | 用户或父代理 | 并行起多个 reviewer，各给一个角度（正确性、测试、简化），回来看综合结论；加 `autofix` 才动手改 |
| `/review-loop` | 同上 | worker → reviewer → fix-worker 循环，直到干净或到上限 |
| `/parallel-cleanup` | 同上 | 实现完之后的清理型评审，只审不改 |
| `acceptance.review` | 原生验收 | `{ level: "checked", review: { required: true } }`；`acceptanceRole: "writer"` 的 async/dynamic writer 会自动带这条 |
| `acceptanceRole: "read-only"` | 原生验收 | 只读角色（reviewer、scout、validator）推断为 `none`，不需要证据门槛 |

### bindings 怎么分

**只有强制的形态才需要配探针。** 评审子代理本来就该只读、不该跑测试、不该长时间不产出「结论」——时间判据（只读空转、早可收工）对它是误伤源，一律不配。

```json
// 实现型子代理：范围收窄 + 允许跑验证 + 探针全开
"pi-allow-reads/1": {
  "scope": ["web/src/features/balance/**"],
  "bash": { "read": ["pnpm run typecheck"], "write": ["pnpm test"] },
  "probe": { "idleWriteMs": 360000, "abortGraceMs": 120000 }
}

// 评审型子代理：只读、范围给到整棵相关树、探针只留默认两条
"pi-allow-reads/1": {
  "scope": ["web/src/features/balance/**", "web/src/lib/**"],
  "readOnly": true,
  "maxDenies": 3
}
```

要点：

- **评审要读得比实现宽**。实现子代理的 scope 只该有它要改的那块；评审要看改动涉及的依赖、类型定义、测试，scope 得覆盖这些，否则评审会一路撞权限停下，而且它撞权限的汇报会被父代理误读成「实现有问题」。
- **评审单 `readOnly: true`**：同时跳过「只读空转」和「早可收工」两条时间判据（本来就是只读任务），但「原地打转」「撞权限」「造杂物」仍然生效——评审反复跑同一条命令或乱写临时文件一样是浪费。
- **`maxDenies` 对评审单更重要**：评审忘了给某个目录的读权限时，它会立刻停下并报告「缺哪个目录」，父代理据此补 scope 重跑评审即可，不用重新实现。

### 与验收 gate 的分工

`acceptance.review` 是**验收环节**：跑完实现、证据齐了之后，再独立起一个 reviewer 判「能不能收」。
探针是**运行环节**：在实现或评审进行的**途中**判「有没有在推进」。

两者不冲突也不重复：

- 探针判死一轮实现 → 那轮没有交付，不需要进验收。
- 探针放过、审核通过 → gate 报 `verified` / 失败，跟探针无关。
- 别指望探针代替评审：探针只能看见「没写文件、重复命令、验证通过后还在磨」，看不见「改错了、漏了测试、越界重构」。

### 一个容易踩的坑

`/parallel-review` 和 `/parallel-cleanup` 的默认约定是**评审不要往仓库写文件**（`output: false`，不改代码）。如果你给的评审 bindings 里 `readOnly: false` 且 scope 包含源码目录，评审模型可能顺手「帮你修」——于是评审变成第二个写入者，而源实现子代理可能还在跑，两个写者撞同一个工作树。要么评审单 `readOnly: true`，要么等实现的 run 完全结束再起评审。
