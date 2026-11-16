# C2 — worktree hook 的退出码与「装好了没」的判据

## 原始报告

buddy-proxy 的 worktree setup 是否真的成功，只看 hook 的退出码；怀疑 pnpm 明明装好了却退非 0，
导致 worktree 被判定失败。

## 核实

`packages/worktree-setup/worktree-setup.sh` 只做四件事：找不到 `<worktree>/.pi/worktree-setup.sh` 就
空转退 0；删掉主仓的 `node_modules` 软链；`sh` 跑项目声明并把输出写进
`~/.cache/pi-worktree-setup/<目录名>.log`；把声明的退出码原样传出。**它不判断「装好没」。**

这不是疏漏，是 2026-11-14 定下的「退出码即契约」：hook 一旦自己判树，就得知道每个包管理器
把依赖放在哪、什么算装好，而这些正是项目自己最清楚的东西。

已知的真实坑（实测过）：pnpm 12 在装了全部依赖之后，若遇到没有审批的 build script，仍然退
`ERR_PNPM_IGNORED_BUILDS` 的 1。所以「装了但退 1」是常态，不是异常。

## 处理

不是代码缺陷。SKILL 里原来只有一句「自己写 `|| true` 或加一条自检」，没有可抄的写法，
现在补了模板（见 `skills/pi-subagent-extend/SKILL.md` 的 worktree hook 一节）。

## 待你决策

无。除非你想让 hook 自己判树 —— 那等于推翻「退出码即契约」，让 hook 去理解 pnpm/npm/yarn 的布局，
我不建议。
