---
recorded: 2026-08-25T23:33:32Z
commit: ed74e34af4
---
# Bun's fetch has a hidden 300 s idle timeout — every model hop opts out

*Incident (2026-08-25 22:04Z, SampleCo session 9c27242e):* a turn on
`codex/gpt-5.6-sol` at reasoning effort `max` died after 273.8 s with
`{"message":"The operation timed out.","code":"upstream_timeout"}`. Nothing in
this repo sets a 300 s timer; the gateway's own budgets are 90 s / 5 min for
response headers and 90 min for body inactivity. Measured on Bun 1.3.14 the
same night: `fetch` throws `TimeoutError: The operation timed out.` at 300.0 s
when the socket is idle (no headers, or headers then silence); a stream that
drips a byte every 60 s lives past 420 s; a caller `signal` does NOT disable
it; `timeout: false` (or `0`) does. The provider was still thinking.

**Rules.**
1. Every fetch on the model path passes `timeout: false`: gateway → provider
   (`upstreamFetch`, `packages/llm-gateway/src/upstream-fetch.ts`, used by
   both `callUpstream` and the AI-SDK transport), API relay → gateway
   (`apps/api/src/llm-gateway/wire.ts`), box llm-proxy → API
   (`kortix-sandbox-agent-server/src/llm-proxy.ts`). The gateway's explicit
   timeouts are the only ones on that path.
2. A timeout you did not write is still yours to know about. When an error
   message is not in the repo, measure the runtime before blaming the
   provider: `bun-idle.ts` (headers-then-silence, no-headers, drip, option
   variants) took 12 minutes and settled it.

*Automation:* `packages/llm-gateway/src/upstream-fetch.test.ts` (option is
forwarded; Bun accepts it on a real request).
