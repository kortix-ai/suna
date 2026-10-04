---
recorded: 2026-09-29T23:35:34Z
incident_date: 2026-09-23
---
# Resolve a session's OpenCode root from the control plane's pin when the box has no local pin; never create a root because a list timed out

**Rule:** A box's local pin file is a cache, not the authority. When it is
missing, resolve the boot root with the control plane's pin
(`project_sessions.opencode_session_id`, returned by `initial_turn_claim`).
Never treat "OpenCode did not answer the root list" as "the store is empty".
Create a root only when OpenCode answers with none.

**Trigger surface:** Changes to daemon root resolution
(`resolveExistingRoot`, `maybeCreateInitialOpencodeSession` in
`harness/open-code/boot.ts`), to the pin relay (`pinOpencodeSession`), to where
the daemon keeps durable state, or to any path that boots a new daemon on an
old box (legacy-runtime bootstrap, home rebuilds, provider rehomes).

**Incident:** 2026-09-23 to 2026-09-29, prod. The legacy-runtime bootstrap
relaunched migrated boxes onto the current daemon. The daemon had no pin file
yet, and OpenCode took ~26 s to answer. The 20 s root list timed out, and the
daemon created an empty root and relayed it over the durable pin. The web
opened those sessions blank while the TUI still listed the real root. 3
sessions in one enterprise project were affected. Found from a user report on
2026-09-29 and repaired in place (pin file plus relay, no deletes). Fixed in
#8322.

**Enforcement:** `apps/api/src/http/projects/turn-stream.test.ts` (the claim
returns the durable pin), `initial-turn-lifecycle.test.ts` (the daemon records
it), `boot-replay-prevention.test.ts` (a pinned older root wins over a newer
empty root; timeout with a pin defers).
