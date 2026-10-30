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

### 不要叠加的东西

- **不要给写实现类子代理设 `toolBudget.hard`**：它先封读和搜索，子代理拿不到上下文反而更容易空转，探针随后把 run 判死，看起来像探针误伤。要限制就限制范围（`scope`）和时长（`timeoutMs`）。
- **不要同时配 `successPatterns` 和 gate 的同一份验证**：一处判成功就够了，两处容易先后不一致。
- **不要用 `probe: false` 来「省事」**：默认只开打转和撞权限，关掉等于放弃两个最便宜的错误信号。真要静音就写 `probe: { repeatBash: 50 }` 这类具体放宽。
