---
name: pi-subagent-extend-context
description: 委派子代理时用它把主代理专属内容从子代理提示词中移除：AGENTS.md 里用 <!-- main-agent-only:start --> 圈出的段落子代理看不到，主代理专属规则另放 .pi/main-only.md 只注入主会话。适用场景：AGENTS.md 里混着委派纪律、等待方式、汇报口径、主代理专属的写权限边界，子代理读到会白占上下文并错认职责。含三个入口的分工、标记写法、标记不闭合时的降级、与 inheritProjectContext 全有全无开关的取舍。
---

# 上下文隔离：让 AGENTS.md 只喂该喂的那部分

`AGENTS.md` 是整份进的：子代理会连同「怎么委派、怎么等结果、汇报口径」这些只对主代理有意义的段落一起读到，白占上下文，还可能让它把主代理的动作当成自己的职责。

本 skill 解决这个：**主代理看到全部，子代理看到去掉主代理专属部分之后的版本。**

文件范围与 bash 白名单见 `pi-subagent-extend`，探针判据见 `pi-subagent-extend-probes`。三件事互不依赖，可以只用其中一个。

子代理在 `worktree` 里装依赖是另一件事（`worktreeSetupHook`），同样见 `pi-subagent-extend`。

## 用在什么场景：这段内容属于谁

| 内容 | 放哪 | 子代理看得见吗 |
| --- | --- | --- |
| 子代理也该遵守的（术语、验收命令、禁推 git、代码风格） | `AGENTS.md` 普通段落 | 看得见 |
| 只有主代理该知道的，但和仓库规则写在一起更顺 | `AGENTS.md` 里用 `<!-- main-agent-only:start -->` 圈起来 | 看不见（被剥掉） |
| 整段都只给主代理（委派方式、等待与追问节奏、和用户的交互口径） | `.pi/main-only.md` | 看不见（只注入主会话） |

三者可以混用。判断标准很简单：**子代理照着做会不会做错事**——会，就圈起来或挪走。

## 标记写法

```markdown
# 仓库约定

## 术语

**Upstream**：指上游的 API。

<!-- main-agent-only:start -->
## 委派

用 `subagent` 工具委派，等它的结果再决定下一步。汇报口径：改了哪些文件、跑了什么、
结果如何。
<!-- main-agent-only:end -->

## 验收

`mise run test` 全绿。
```

整段（含两个注释和尾随空行）在子代理的提示词里被删除，主代理照常读到。注释本身对模型是透明的，所以主代理那侧不会看到多余的标记噪音。

规则只有一条：**成对闭合**。只有开头没有结尾时，这一整段原样保留、不剥离，并在会话里记一条 warning——宁可让子代理多看见一段，也不要因为猜错边界删掉半个文件。

## 主代理专属文件

`.pi/main-only.md`（相对项目根，路径写死）。有就注入，没有就什么都不做。

注入方式是用 pi 的 `sections`，不是替换整段提示词：pi 按 section 做差量，改动只补一条系统消息，前面的提示词缓存仍然命中。

```markdown
<!-- .pi/main-only.md -->
## 委派与协作

委派一律带 extensionBindings，范围按任务给，别给整个仓库。
子代理异步跑的时候不要干等，先做别的；它回来了再收口。
```

内容按原样进提示词，不加工、不加标题——想让它长什么样就写什么样。

## 三个入口的分工（改动 agent 定义时看这段）

包装了三个入口，加载方式不同，**不要混着声明**：

| 入口 | 谁加载 | 行为 |
| --- | --- | --- |
| `src/index.ts` | agent 的 `subagentOnlyExtensions` + 环境加载 | 权限范围与 bash 白名单（本文不涉及） |
| `src/main-context.ts` | 只走环境加载（`package.json` 的 pi.extensions，即项目 `.pi/extensions/` 软链或全局安装） | 主会话注入 `.pi/main-only.md`；后台子代理里改为剥标记 |
| `src/child-context.ts` | 只由 agent 的 `subagentOnlyExtensions` 声明 | 剥标记，永远不注入 |

agent 定义里两个路径一起写：

```yaml
subagentOnlyExtensions: /path/to/pi-subagent-extend/packages/pi-plugin/src/index.ts, /path/to/pi-subagent-extend/packages/pi-plugin/src/child-context.ts
```

为什么拆成两个而不是一个文件：**前台子代理和主会话无法从进程内区分**。前台子代理是同进程的会话、没有 `PI_SUBAGENT_CHILD`，和主会话的环境一模一样；后台子代理是独立进程、有该变量。所以「主代理专属」的逻辑只能靠加载方式来定受众，不能靠运行时判断。`main-context.ts` 里那句 `PI_SUBAGENT_CHILD === "1"` 就是用来挡后台子代理的——它同时被环境加载，否则会漏。

## 和 inheritProjectContext 的取舍

pi-subagents 有现成开关：`inheritProjectContext: false` 让子代理**完全不读** AGENTS.md（实现上直接把 `noContextFiles` 打开，连文件都不读）。

- 仓库规则对子代理毫无意义时，用它最省事，零代码。
- 但仓库规则里只要有一条子代理也该遵守（验收命令、禁推 git、术语），全关就得把这些复制进每个 agent 定义，代理一多便成为重复维护。

本 skill 的标记法保留单文件、单份维护。两套不冲突：`inheritProjectContext: false` 时标记自然也没有意义（文件根本没读进来）；为 `false` 的 agent 不需要声明 `child-context.ts`。

另外注意 `context: "fork"` 的子代理：它拿的是父代理整份系统提示词，project context 一并带过去，所以标记会被 `child-context.ts` 剥掉，但 `.pi/main-only.md` 的注入已经在父代理提示词里发生，属于预期外的残留。**要隔离就别用 fork context。**

## 排查

| 现象 | 原因 |
| --- | --- |
| 子代理还是读到了标记里的内容 | agent 定义没声明 `child-context.ts`；或者那次是 fork context |
| 子代理读到了 `.pi/main-only.md` | 这个文件被放进了 AGENTS.md 或某个 skill，它不是自动扩散的；或者 agent 用了 fork context |
| 主会话看不到 `.pi/main-only.md` | 扩展没走环境加载（只声明在 `subagentOnlyExtensions` 里就不会在主会话加载） |
| 看到「没有闭合，该段未剥离」 | 标记少了一半，补上 `<!-- main-agent-only:end -->` |
