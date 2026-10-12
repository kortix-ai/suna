---
recorded: 2026-10-10T21:47:35Z
incident_date: 2026-10-01
supersedes: 2026-09-29T233534Z-resolve-a-session-s-opencode-root-from-the-control-plane-s-p.md
---
# Guard the OpenCode boot root's claimed-pin fallback with a test that runs the boot function, not only the resolver it calls

**Rule:** The 2026-09-29 rule stands: with no local pin file, the boot root
resolves from `priorPin ?? claimedRuntimeSessionPin()` in
`maybeCreateInitialOpencodeSession`. Prove that call, not only
`resolveExistingRoot`. A refactor that moves boot code keeps a behavioral test
of the boot function green; an unused import of a fallback getter is a red flag.

**Trigger surface:** Moving or splitting `harness/open-code/boot.ts` or
`initial-session.ts`, root resolution, the pin file, or the `initial_turn_claim`
response.

**Incident:** 2026-10-01 to 2026-10-10. PR #8600 (a "behavior-preserving"
split) moved root resolution out of `boot.ts` and kept only
`readOpenCodeSessionPin()`, undoing PR #8322. Tests covered the claim and the
resolver, never the line that joins them. A box without its pin file again
adopted the newest root and relayed it over the durable pin. Fixed in PR #9511.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/initial-session-claimed-pin.test.ts`
runs `maybeCreateInitialOpencodeSession` over a fake OpenCode and a fake API:
no pin file resumes the claimed older root over a newer empty root; a local pin
still wins. The 2026-09-29 entry's enforcers stay in force. To build: the daemon
has no `@typescript-eslint/no-unused-vars` or `noUnusedLocals`, so the unused
`claimedRuntimeSessionPin` import hid for 10 days.
