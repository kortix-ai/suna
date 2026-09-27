---
recorded: 2026-09-25T08:15:43Z
incident_date: 2026-09-24
commit: 01a84b5ca7
---
# A model check that says "usable" must use the scope the gateway uses, or a chat pins a model that fails every turn

**Rule:** Every check made before a request — a picker list, a servability probe, a create-time validation, a per-message replacement check — resolves with the personal-key scope the gateway uses at request time (`resolveSessionPersonalOwner`, `personalUserId`). When a change narrows what a session may reach, find every such check of that resource and move it in the same PR.

**Incident (dev, 2026-09-24):** #7563 made agents their own principal by default, so a shared session no longer reaches one person's ChatGPT connection. Teams channel sessions pinned to `codex/*` then failed every message with "Connect Codex to use this model". The per-message check (`channelTurnModel`) still counted the sender's own connection, so it never replaced the model, and `/model` changed only new sessions. PR #7593.

**Follow-up (dev, 2026-09-25):** the same gap sat in `PUT /sessions/:id/model` and `PUT …/provider-secret-pools`: a session shared with the project accepted its owner's own ChatGPT connection and member-granted keys. Both now check with the session's gateway scope, and the web key editor lists only keys the session can use.

**Enforcement:** `unit-channel-model-access.test.ts` (a follow-up in a shared session is checked with `personalUserId: null`), `unit-channel-vision-model.test.ts` (probe inputs and cache key carry the scope), `default-model.test.ts` (a shared session's default is checked without personal keys), `unit-session-model-keys.test.ts` (model change), `provider-secret-pools.test.ts` (a shared session refuses a member-granted key), flow `SEC-POOL-2` (`403 SHARED_SESSION_PERSONAL_KEY`, `400 INVALID_SESSION_MODEL`).
