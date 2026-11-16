# D2 — 断网沙箱里 listen() 报 EACCES

## 原始报告

`offline: true` 的子代理里起不了 HTTP server，`listen()` 直接 `EACCES`，导致依赖本地 server 的测试
（supertest、happy-dom、playwright 的本地桩之类）只能开 `network: true` 才能跑。

## 实测（2026-11-16，内核 Landlock ABI 11）

```text
$ helper --spec spec-offline.json -- node listen.js
pi-subagent-extend-helper: network isolated, resolver sockets shadowed: /run/nscd
BIND_ERROR EACCES                      ← offline: true

$ helper --spec spec-online.json -- node listen.js
BOUND 45871                            ← offline: false
```

## 原因

`packages/helper/src/sandbox.rs:87`：

```rust
if spec.offline {
    ruleset = ruleset
        .handle_access(AccessNet::BindTcp)?     // 纳入管辖
        .handle_access(AccessNet::ConnectTcp)?; // 纳入管辖，且不加任何端口规则 ⇒ 全拒
}
```

Landlock 的语义是「纳入管辖但不给规则 = 拒绝全部端口」，所以 bind 和 connect 一起被拒。
对 connect 这是我们要的；对 bind 则过严。

## 为什么放行 bind 是安全的

`offline: true` 时代码已经 `unshare(CLONE_NEWNET)` 建了独立网络命名空间，里面只有自己一个
loopback。**绑定的端口只在自己那个命名空间里存在，宿主和其它进程都连不上。** 真正需要挡的是
connect（出网），不是 bind。

## 两个方案

**A. 只管辖 ConnectTcp（一行改动）**
`offline` 分支删掉 `.handle_access(AccessNet::BindTcp)?`。效果：断网子代理里可以起 server，
但一切出网连接仍被拒，DNS 仍被 resolv 影子挡住。

**B. 加 spec 字段 `allow_bind`（默认 false）**
需要改 spec 结构、`--describe`、TS 层的 bindings 语法和文档。更保守，但多一个用户要理解的概念。

我的建议是 **A**：B 的「默认关闭」等于现状，等于没解决问题；而 A 的安全性由 netns 本身保证，
不依赖 Landlock 的 bind 规则。

## 待你决策

选 A / B / 不改。选 A 我会：改 `sandbox.rs`、加一条 cargo 测试（offline 下 bind 成功而 connect 失败）、
更新 README 与 SKILL 里「offline 到底禁什么」的措辞（现在是笼统的「不联网」）。
