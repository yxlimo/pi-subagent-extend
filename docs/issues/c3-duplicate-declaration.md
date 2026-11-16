# C3 — 重复的 worktree setup 声明

## 原始报告

同一个项目里出现了两处 setup 声明，怀疑会被执行两次。

## 核实（2026-11-16）

- `pi-subagent-extend`：`.pi/` 下只有 `worktree-setup.sh`
- `buddy-proxy`：`.pi/` 下只有 `worktree-setup.sh`（只读查看，未改动）
- 全仓搜索 `worktree-setup`：代码、README、SKILL 里只认 `.sh`，没有任何地方读 `.json`

## 结论

重复声明已经不存在。它属于更早那一轮「配置即闸门」改写之前的形态
（`.pi/worktree-setup.json` 声明 `{command, cwd}`），那套在那次改写里就被 `.sh` 取代了。
这份报告是在改写之后仍然按旧形态写的。

## 待你决策

无。
