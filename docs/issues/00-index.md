# issues — 待决与已核实的问题

来源：2026-11-15 buddy-proxy 通宵测试后整理的清单（A 组范畴/停机、B 组 worktree、C 组 hook/pnpm、D 组健壮性），
A 组与 B1、C1 已修并提交；这里记剩下五条。**每个文件一个问题，末尾写「待你决策」或「无需决策」。**

| 编号 | 文件 | 结论 |
| --- | --- | --- |
| C2 | [c2-hook-exit-code.md](c2-hook-exit-code.md) | 不是 bug（退出码即契约是既定决定）；补了自检模板 |
| C3 | [c3-duplicate-declaration.md](c3-duplicate-declaration.md) | 已不存在，属历史遗留报告 |
| D1 | [d1-dirty-worktree-deleted.md](d1-dirty-worktree-deleted.md) | 设计如此：内容已存成 patch；无需改动 |
| D2 | [d2-offline-listen-eacces.md](d2-offline-listen-eacces.md) | 已修：offline 时拉起 loopback、不再设 Landlock 网络规则 |
| #37 | [37-upstream-prelink.md](37-upstream-prelink.md) | 已提 PR #3288，等维护者 |
