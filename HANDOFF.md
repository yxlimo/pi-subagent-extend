# HANDOFF — pi-allow-reads

交接文档。后续独立 agent 接手时读这一份 + `README.md` 即可，不必翻本机历史。

| | |
| --- | --- |
| 交付物 | 一个 pi 扩展：把子代理可碰的文件限制在父代理指定的任务范围内，范围外 tool_call 一律拒绝 |
| 位置 | `/home/shay/extensions/pi-allow-reads/`（独立 git 仓库，本地提交，未推远程） |
| 前身 | 原单文件 `~/extensions/pi-allow-reads.ts`（只读白名单版），本仓库是重写 + 迁移，原文件已删除 |
| 状态 | 已实现、离线测试通过（10 例）、typecheck 通过；未做活体验证 |

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
  该事件在 `session_start` 之后触发，本扩展无条件注册（父会话扩展是空操作时也要
  注册，skill 才能到达父代理）。
- **语义变化（相对前身）**：前身把 edit/write/grep/find/ls 一律拒绝；现在范围内
  的 edit/write/grep/find/ls 放行（读写模式），只读场景用 bindings 的 `readOnly`。
  `bash`/`powershell`/`codemode` 与未知工具仍然一律拒绝。

## 3. 验收状态

| 编号 | 项 | 状态 | 依据 |
| --- | --- | --- | --- |
| A1 | 无配置时不生效 | ✅ | `node test/extension.test.mjs` 第 1 例 |
| A2 | 范围内放行 / 范围外拒绝 / 执行器与未知工具拒绝 | ✅ | 第 2 例 |
| A3 | readOnly、显式空范围、损坏 bindings fail closed | ✅ | 第 3–5 例 |
| A4 | maxReads 预算、allowTools、缺省 path | ✅ | 第 7–9 例 |
| A5 | 用法 skill 经 resources_discover 注册 | ✅ | 第 10 例 |
| A6 | typecheck | ✅ | `pnpm run typecheck` |
| A7 | 活体验证（真 pi 会话里 spawn 一次验证拦截） | ❌ 未做 | 见第 4 节遗留 |

## 4. 遗留

1. **活体验证未做**：需要一次真实 pi 会话——agent 定义带 `subagentOnlyExtensions`，
   父代理传 bindings spawn，确认范围内外行为与拒绝文案。bindings 环境变量的实际
   传递路径（前台/后台子代理各一遍）未在真机上验证过。
2. **skill 与活体加载未真机验证**：`resources_discover` 的 skill 注册与 bindings
   环境变量的传递路径都只在离线测试里覆盖，需要一次真实 pi 会话确认（skill 出现在
   父会话可用列表、spawn 后拦截生效）。
3. **未做的事**：不改 pi 核心、不改 pi-subagents；没有 opencode 变体（pi 专用）。

## 5. 源码地图

```
packages/pi-plugin/src/index.ts            扩展本体（策略解析 + tool_call 拦截 + skill 注册）
packages/pi-plugin/test/extension.test.mjs 离线测试（10 例）
packages/pi-plugin/install.sh              装/卸
packages/pi-plugin/skills/pi-allow-reads/SKILL.md  用法 skill
```

## 6. 相关材料

- pi-subagents bindings 规则：`~/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/extension-bindings.js`
  （namespace 正则、16 KiB/深度/属性数上限）、`docs/tool-reference.md` 搜 extensionBindings
- pi 扩展 API 类型：`~/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
  （`ToolCallEvent` 联合类型、`ToolCallEventResult.block/reason`）
- 同类仓库：`~/extensions/subagent-only-skills/`（布局与测试模板来源）
