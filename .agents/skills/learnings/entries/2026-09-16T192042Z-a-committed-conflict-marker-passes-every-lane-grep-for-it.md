---
recorded: 2026-09-16T19:20:42Z
incident_date: 2026-09-16
commit: 15fa494528
---
# A committed conflict marker passes every lane — grep for it

**When:** resolving any merge, especially in a file no build step reads.
`a5290753fa` (#7314) committed `straight into `.claude/skills/learnings/SKILL.md` and shipped it to `staging`.
Every CI lane stayed green: nothing compiles, lints or imports that file. It
surfaced only when the next promote produced a NESTED conflict. Note the rule
can only key on `<<<<<<< ` and `>>>>>>> ` at line start — a Setext heading
underlines its title with exactly `=======`, so flagging the middle marker
rejects ordinary markdown. *Enforcer:* `tests/unit/conflict-markers.test.ts`
scans every `git ls-files` path and fails with `path:line`; proven against the
real corruption replanted in the same file, and against the naive rule.
