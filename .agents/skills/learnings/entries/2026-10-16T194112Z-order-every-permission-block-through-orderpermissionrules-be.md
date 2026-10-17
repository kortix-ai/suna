---
recorded: 2026-10-16T19:41:12Z
incident_date: 2026-10-16
---
# Order every permission block through orderPermissionRules before OpenCode reads it

**Rule:** Kortix guarantees one permission precedence on both harnesses: the most specific matching rule wins, whatever the key order. OpenCode applies the LAST matching rule in key order, so every permission block that reaches OpenCode goes through `orderPermissionRules` (`@kortix/api-contract/permission-rules`). Never fix one map by hand-placing `*` first; never assert a compiled permission with `toEqual` alone (it ignores key order) — evaluate it with OpenCode's `findLast`.

**Trigger surface:** building, merging or forwarding a `permission` block: `apps/api/src/projects/lib/compile-agent-config.ts`, kortixd `harness/open-code/lifecycle.ts` `buildOpencodeConfigContent`, `tool-access.ts`, `harness/pi/interactions.ts`, or a new path that hands OpenCode config.

**Incident:** 2026-10-16, a prod session on v0.13.57: an agent with a `skills:` list got `skill: { <listed>: allow, …, '*': deny }`, so OpenCode refused every Skill call. #10000 fixed only that function; an author's `bash: { "git push *": ask, "*": allow }` or `{ bash: ask, "*": allow }` still resolved to the `*` rule on OpenCode while pi used the specific one. #10089 fixed the class.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/permission-precedence.test.ts` (pi resolver == OpenCode `findLast` over the ordered block; composed config from an unordered compiled set; plugin hook == `orderPermissionRules`), the OpenCode-evaluation rows in `apps/api/src/projects/lib/compile-agent-config.test.ts`, and `packages/api-contract/src/__tests__/permission-rules.test.ts`.
