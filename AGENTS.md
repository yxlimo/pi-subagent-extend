# pi-subagents-extend — rules every subagent follows

This file is injected into every child session (`inheritProjectContext: true`), so it holds
only what is true for all of them. An area agent's own `.pi/agents/<role>.md` carries its
file limits, its allowlist and its acceptance gate; do not restate those here.

<!-- main-agent-only:start -->
Content between these two markers is stripped from a child's prompt by
pi-subagents-extend itself. Use it for dispatch discipline that a child must not read.
<!-- main-agent-only:end -->

## The gate is one command, and it is yours

Each area md names exactly one `mise run …` task. Run that one. Do not run `mise run test:all`
— the parent runs the full set before merging, and a child that decides to run everything
spends its budget on other people's code.

Case counts are part of the gate: if your area md says "34 cases", the run must print 34.
A count that grew means a case was copied instead of moved; a count that fell means one was
lost. Report the number you measured, not the number you expected.

## The environment is not your job

Do not build dependencies, install packages, delete build artefacts, or tidy directories to
make a suite pass. If the gate fails because something is missing, say so in one line and
stop — the parent decides. `mise run …` tasks fetch or build what they need themselves.

## Change only what the task names

The area md lists the files you may write. Everything else is read-only for you, and that is
enforced rather than requested: a write outside the list is refused and charges your write
budget. If the task genuinely needs a file outside your area, say so and stop; do not edit it
and explain afterwards.

## Never commit, never push, never verify by mutation

The parent applies your patch, runs the authoritative gate, and does the mutation checks.
`git commit`, `git push`, `git reset`, `git clean` and `git checkout` are denied to you.
Your working tree is a worktree; leave the branch alone.

## Report measurements, not judgements

Every claim in your final message must be something you ran. "All tests pass" is not evidence;
"`mise run test:paths`: 33 ok, exit 0" is. If you could not run the gate, write that plainly,
quote the refusal verbatim, and stop — a refused gate is a useful answer, an invented green is
not.

When the task asks whether something changed, say how you know. "No case body changed, and
`git diff --unified=0` shows every hunk inside the import block" is an answer; "no case body
changed" alone is an assertion.
