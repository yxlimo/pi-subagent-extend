// Judge: the worktree dispatch default (payload null vs the role md) and the bash deny refusal wording.
// Offline test for the pi-subagents-extend extension.
//
// Runs the extension against a fake pi API, so the scope contract can be
// checked without a live pi session. The policy is captured when the extension
// activates, so every case re-activates with its own environment.
//
//   node test/extension-judge.test.ts

import assert from "node:assert/strict"
import { join } from "node:path"
import { handler, writeAgentMd, workdir } from "./harness.ts"

// 1. A dispatch payload's `worktree: null` counts as absent: the role md's
//    extend.worktree.enabled: true still fills the default. shouldDefaultWorktree
//    already treats null as absent on the input (`??=` semantics); the strategy
//    lookup must not disagree with it, or a payload that only wanted to leave the
//    key unset silently suppresses the role default.
{
  const proj = join(workdir, "judge-worktree-null")
  writeAgentMd({
    cwd: proj,
    role: "wt-judge-null",
    extend: { permissions: { scope: ["."], allowTools: ["subagent"] }, worktree: { enabled: true } },
  })
  const h = await handler({
    cwd: proj,
    rawBindings: true,
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { worktree: null, permissions: { scope: ["."], allowTools: ["subagent"] } },
    }),
  })
  const input: Record<string, unknown> = { agent: "wt-judge-null", task: "x" }
  assert.equal(await h.call("subagent", input), undefined, "filling the default is not a refusal")
  assert.equal(input.worktree, true, "a payload worktree: null counts as absent; the role md default applies")
  h.restore()
  console.log("  ok   a payload worktree: null does not suppress the role md's worktree default")
}

// 2. The bash deny refusal says the command is blocked by a deny entry and quotes
//    the entry itself, so the reader sees which line of which policy blocked it.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["git diff"], deny: ["git stash"] } },
    }),
  })
  const refused = await h.call("bash", { command: "git stash" })
  assert.ok(refused && refused.block, "a deny entry blocks the command")
  assert.match(refused.reason, /command blocked by a deny entry/, `the refusal names a deny entry, got: ${refused.reason}`)
  assert.match(refused.reason, /"git stash"/, `the refusal quotes the deny entry, got: ${refused.reason}`)
  h.restore()
  console.log("  ok   the deny refusal names a deny entry and quotes it")
}

// 3. The bash deny refusal keeps the source label: the reader still learns which
//    layer contributed the entry.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["git diff"], deny: ["git stash"] } },
    }),
  })
  const refused = await h.call("bash", { command: "git stash" })
  assert.ok(refused && refused.block, "a deny entry blocks the command")
  assert.ok(
    refused.reason.includes("(source: extensionBindings pi-subagents-extend/1)"),
    `the refusal keeps the source label, got: ${refused.reason}`,
  )
  h.restore()
  console.log("  ok   the deny refusal keeps the (source: …) label")
}

// 4. The bash deny refusal is layer-neutral: it names no configuration file ("the
//    project profile" no longer exists as a layer) and no layer that supposedly
//    owns or cannot lift the entry — it states only what the code backs: a deny
//    entry is a restriction no layer can remove.
{
  const h = await handler({
    bindings: JSON.stringify({
      "pi-subagents-extend/1": { scope: ["**"], bash: { allow: ["git diff"], deny: ["git stash"] } },
    }),
  })
  const refused = await h.call("bash", { command: "git stash" })
  assert.ok(refused && refused.block, "a deny entry blocks the command")
  assert.ok(
    !refused.reason.includes("project profile"),
    `the refusal must not name the deleted profile layer, got: ${refused.reason}`,
  )
  assert.ok(
    !refused.reason.includes("cannot lift"),
    `the refusal must not claim a layer owns the prohibition, got: ${refused.reason}`,
  )
  assert.match(
    refused.reason,
    /no layer can remove it/,
    `the refusal states the backed fact about a deny entry, got: ${refused.reason}`,
  )
  h.restore()
  console.log("  ok   the deny refusal is layer-neutral and states what the code backs")
}
