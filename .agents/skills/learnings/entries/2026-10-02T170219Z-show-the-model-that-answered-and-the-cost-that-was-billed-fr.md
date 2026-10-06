---
recorded: 2026-10-02T17:02:19Z
incident_date: 2026-10-02
---
# Show the model that answered and the cost that was billed from the gateway's record, never from what a session asked for

**Rule:** A screen that names the model of a turn, or its cost, reads both from
the gateway's request record. The transcript of either harness holds the model
a turn ASKED for, and a client prices a turn from that id. The two differ every
time a fallback chain, a vision reroute or a default resolves the request to
another model. When they differ, the requested model is the wrong name and the
wrong price. Compare route ids with route ids: `resolved_model` is the
upstream's id for an own key or a ChatGPT plan, so it cannot be compared with
`requested_model`; `metadata.servedModel` and `metadata.fallbackFrom` can.

**Trigger surface:** Adding a model name, a cost, or a token price to a session
surface (web, mobile, CLI, a channel message); grouping gateway spend by model;
changing what a gateway trace records; changing how a turn's cost is estimated
in `packages/sdk/src/core/turns/state.ts`.

**Incident:** 2026-10-02, production. A project's chain answered 1,251 requests
of its sessions from a Kortix model in 39 minutes after a ChatGPT plan reached
its usage limit, and Kortix debited $13.86 for them. The session composer kept
naming the selected ChatGPT model. Each turn and the session total showed $0,
because the browser prices a `codex/…` model at zero. The project spend
breakdown listed the charges under the ChatGPT model. The gateway billed
correctly; nothing on the session screen was true. Blast radius: every session
a fallback model answers, on both harnesses. No data loss.

**Enforcement:**
`apps/api/src/__tests__/integration-session-model-usage.test.ts` (real
PostgreSQL: served model, fallback, turn attribution, legacy rows, spend by
model), `packages/llm-gateway/src/pipeline/simple-handler.test.ts` (the trace
names `servedModel` and `fallbackFrom`),
`apps/web/src/features/session/turn/served-model.test.ts`,
`apps/web/src/features/session/session-turn-meta-rows.test.ts` ("a fallback
turn never shows the estimate for the model that did not answer"), and flow
`SESS-46`.
