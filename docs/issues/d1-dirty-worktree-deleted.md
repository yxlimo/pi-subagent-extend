# D1 — 脏工作树被删除（以及观察到的 `git add`）

## 原始报告

子代理在 worktree 里改了文件，结束时整个 worktree 连同分支被删；期间还观察到 `git add` 跑过。

## 核实（读 pi-subagents 0.88.1 源码）

`git add` 不是谁在偷改索引，而是上游抓 patch 的第一步 —— `src/runs/shared/worktree.js:964`：

```js
function captureWorktreeDiff(setup, worktree, agent, patchPath) {
    removeSyntheticPathsBeforeDiff(worktree);          // 先把 node_modules 软链摘掉
    runGitChecked(worktree.path, ["add", "-A"]);       // ← 观察到的 git add
    const patch = runGitChecked(worktree.path, ["diff", "--cached", ...opts, setup.baseCommit]);
    fs.writeFileSync(patchPath, patch, "utf-8");
```

也就是说：**工作树 + 索引 vs baseCommit 的差异被写成了 patch 文件**，未提交的改动同样在里面，
跟子代理有没有 commit 无关。

删除与否由 `cleanupWorktrees` 的两道校验决定（`worktree.js:1327` 起）：

1. `handoffRecordsPatch()` —— 交付清单里确实登记了这份 patch
2. `validateWorktreePatchRepresentsCurrentWorktree` —— 磁盘上那份 patch 与当前工作树逐字节一致

两条都过才 `git worktree remove --force` + `git branch -D`；任何一条不过就保留工作树。

## 所以内容没丢

交付物是 `handoff.json` 的 `groups[].children[].patch`：

```text
{ path, branch, changed, diffStat, filesChanged, insertions, deletions }
```

`branch -D` 之后子代理自报的分支名和 SHA 就失效了（对象要等 gc 才回收，默认两周），
这一点已经在两处处理过：

- 本仓 `src/handoff-hint.ts`：父代理收到的 `Worktree handoff:` 行后面补一句「交付物在
  `groups[].children[].patch`，没有应用到当前 checkout」
- 上游 PR #3283（已合并）：在 reference 行上直接写明交付物位置

## 待你决策

无。这不是缺陷。
