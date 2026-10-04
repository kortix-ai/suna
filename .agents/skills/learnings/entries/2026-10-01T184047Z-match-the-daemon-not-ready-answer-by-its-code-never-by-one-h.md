---
recorded: 2026-10-01T18:40:47Z
incident_date: 2026-10-01
---
# Match the daemon not-ready answer by its code, never by one harness's error text

**Rule:** When code branches on "the session runtime refused this request
because it is not up yet", read the daemon's `code: "runtime_not_ready"`
(`RUNTIME_NOT_READY_CODE`, `packages/api-contract/src/runtime-relay.ts`) and keep
BOTH texts as the fallback for a daemon without the code: `sandbox runtime not
ready` (pi, and OpenCode's boot steps) and `opencode not ready` (the OpenCode
process gate). Never match one harness's text alone. In a client, call the SDK's
`isRuntimeNotReadyResponse` / `isSandboxNotReadyError`.

**Trigger surface:** Any `includes('… not ready')` or regex on a daemon 503 body:
the preview proxy (`apps/api/src/http/sandbox-proxy/preview.ts`), prompt
dedupe, client error boundaries, toast suppression, telemetry ignore lists. Any
new harness or daemon gate that answers 503 before forwarding a request.

**Incident:** 2026-10-01, found while migrating clients off OpenCode names (W6),
not from a user report. The preview proxy released a prompt's Idempotency-Key
claim only when the 503 body contained `opencode not ready`. A pi runtime
answers `sandbox runtime not ready`, so the claim stayed and the client's retry
under the same key got the `200 {"status":"duplicate"}` short-circuit: a prompt
sent through the proxy while a pi runtime booted was dropped. The same text
match was in 5 web call sites, and no SDK pattern matched the pi text, so a pi
boot window surfaced as an error instead of "starting". Blast radius: pi
sessions only (`pi_harness`, opt-in).

**Enforcement:** `apps/api/src/http/sandbox-proxy/preview-characterization.test.ts`,
"a not-ready 503 with the daemon text of a pi runtime passes through and
releases the dedupe claim" (and the `runtime_not_ready` code case): both fail
when the proxy matches one text again. `packages/sdk/src/core/http/runtime-errors.test.ts`
covers the SDK predicates. `apps/web/scripts/sdk-boundary.mjs` rule
`runtime-not-ready-string` rejects the literal in web source.
