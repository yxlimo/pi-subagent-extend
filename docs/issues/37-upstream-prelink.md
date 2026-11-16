# #37 — 上游：配了 worktreeSetupHook 时不要预软链 node_modules

## 问题

上游建 worktree 时，`finalizeCreatedWorktree`（`worktree.js:773`）会先把主仓根部的 `node_modules`
软链进工作树，**然后**才跑项目的 `worktreeSetupHook`。而 `setupHook` 本来就在那个函数的签名里 ——
上游知道项目会自己布置依赖，却仍然先软链。

后果（`docs/internal`、SKILL 与 README 都记过实测）：声明里跑 `pnpm install` 会顺着软链写进主仓；
用 `virtualStoreType: global` 时还会把主仓 `node_modules/.modules.yaml` 里的相对 `virtualStoreDir`
按工作树的深度改写（4 级 → 6 级）。

## 已投递

**PR #3288**（open）—— 不是直接掐掉软链，而是加配置项，默认零行为变化：

```json
{ "worktreeNodeModulesLink": "always" | "never" }
```

- 默认 `always`，行为与现在完全一致
- `never` 时跳过 `linkNodeModulesIfPresent`
- 挂在 `FAIL_CLOSED_CONFIG_KEYS` 上：配置写错就报错，而不是静默继续软链
- 覆盖 9 个文件（配置、校验、4 处转发、1 处开关），+66/−3

中途否掉过两个更激进的版本：

1. 「配了 hook 就不软链」—— 一个只写 `.env` 的 hook 会平白失去软链，破坏面太大
2. 「先跑 hook 再软链」—— 本来靠软链读依赖的 hook 脚本会失效

review 反馈已修：Greptile 的 P1（resume 的四处 payload 里漏了一处，导致复活后重新软链）已改并回帖。

## 本仓要不要跟着改

**建议不改。** `packages/worktree-setup/worktree-setup.sh` 里的 unlink 服务的是「项目没有配
`worktreeNodeModulesLink`」的情况，也就是绝大多数项目。两者并存没有冲突：上游关掉软链之后，
hook 里的 `if [ -L node_modules ]` 自然为假，什么都不做。

## 待你决策

PR 合并后是否要更新 README/SKILL，把「本仓 hook 负责删软链」改成「优先用上游配置，hook 兜底」。
