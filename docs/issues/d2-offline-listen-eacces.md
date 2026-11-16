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

## 决定：放行 bind（2026-11-16，选 A）

按方案 A 改了 `sandbox.rs`，但**实测发现只放行 bind 不够**：

```text
A（只放 bind、仍拒绝 connect）
  bind 127.0.0.1 -> OK
  bind 0.0.0.0   -> OK
  loopback client -> EACCES        ← 同一个沙箱里的 client 连不上自己刚起的 server
```

原因是 Landlock 的网络规则**按端口**，没有表达「只允许 loopback」的方式：放行 bind 而拒绝
connect，等于 server 起得来但谁都连不上，测试依然跑不通。

再试「完全不设 Landlock 网络规则」：

```text
A2a（无网络规则，lo 仍是 down）
  loopback client -> ENETUNREACH
```

新 netns 里 loopback 是**管理性 down** 的，bind 不需要接口所以能成功，但连不上去。

## 最终实现

两步一起做：

1. `namespace.rs` 新增 `bring_up_loopback()`：unshare 出 netns 之后用 `SIOCGIFFLAGS` /
   `SIOCSIFFLAGS` 把 `lo` 拉起（`IFF_UP | IFF_RUNNING`）。命名空间里依然只有这**一个**接口、
   没有路由，所以「出不去」这件事没有变。
2. `sandbox.rs`：offline 时**不设任何 Landlock 网络规则**。隔离交给命名空间 —— Landlock 的
   按端口规则无法表达「只允许 loopback」，它会顺带拒掉测试最需要的本地连接。

## 实测（Landlock ABI 11）

| 场景 | 结果 |
| --- | --- |
| 本地往返（server + client 同沙箱） | `loopback client -> CONNECTED` / `reply -> pong` |
| `bind 127.0.0.1` / `bind 0.0.0.0` | OK |
| `connect 1.1.1.1:80` | `ENETUNREACH` |
| `dns.lookup("github.com")` | `EAI_AGAIN` |
| 对照 `offline: false` | `connect -> CONNECTED` |

## 待你决策

无 —— 已按你的选择实现。唯一需要知道的是语义变化：断网的含义从「Landlock 拒绝 TCP」
变成「命名空间里没有出口路由」，对外表现是 errno 由 `EACCES` 变成 `ENETUNREACH`。
README 与 SKILL 已同步改写。
