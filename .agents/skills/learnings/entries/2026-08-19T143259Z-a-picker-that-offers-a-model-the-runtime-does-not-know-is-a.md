---
recorded: 2026-08-19T14:32:59Z
incident_date: 2026-08-19
commit: c622dd2858
---
# A picker that offers a model the runtime does not know is a silent outage; the runtime must learn the set from the API it talks to

**When:** adding or changing a managed model (`LLM_GATEWAY_MANAGED_MODELS`,
`@kortix/llm-catalog` MANAGED_MODELS), or touching how the sandbox daemon
builds OpenCode's `kortix` provider (`apps/kortix-sandbox-agent-server/src/opencode.ts`).
The web picker reads the API (`/model-picker`, `/v1/llm/models`); OpenCode in the
guest accepts only the ids in the provider map it BOOTED with, built from the
image-baked `/opt/kortix/llm-catalog.json`. That file is frozen at template-build
time and nothing rebuilds a template for a catalog change, so every managed
model added after the bake is offered by the picker and rejected by the guest
(`ModelNotFound: kortix/<id>`, 2 ms after the user message, before any gateway
call). Rules: (1) the guest must fetch the managed set from the API on EVERY boot
(`GET /models?scope=managed`, ~3 KB) and overlay it — never trust a baked list
for anything deployment-config decides; (2) a boot-path fetch gets its own small
budget and a bundled fallback, and is started in parallel with the clone, never
awaited on the critical path beyond a cap; (3) a catalog "refresh" that can
silently fall back (here 2.5 s/4 s for a 3.3 MB body) is not a refresh — size the
payload to the budget; (4) a `session.error` with no assistant message must be
rendered under the turn that failed, or the user sees nothing at all.
*Incident:* prod 2026-08-19, `grok-4.6` and `deepseek-v4-pro-0813` (added
2026-08-12/13) returned no reply in every session on templates built before
then; 0 gateway log rows ever. PR #6576.
*Enforcer:* `managed-fallback-sync.test.ts` (bundled table vs `MANAGED_MODELS`
drift — cited here since 2026-08-19 but ABSENT on `main` until 2026-08-27, when
adding `glm-5.3-flash` found the gap; it now lives in
`apps/api/src/llm-gateway/models/` and fails on a missing, extra, misnamed,
mis-sized, or mis-priced bundled entry), the daemon's `opencode-catalog.test.ts` (stale file + live overlay; failed
fetch → bundled floor; await cap), `managed-scope.test.ts`; web: sync-store
per-turn `session.error` tests. Not enforced: a live "picker ⊆ guest provider
map" assertion after deploy — run the dev sweep by hand until it exists.
