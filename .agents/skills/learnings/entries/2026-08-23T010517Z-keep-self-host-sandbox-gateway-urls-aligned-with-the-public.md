---
recorded: 2026-08-23T01:05:17Z
incident_date: 2026-08-23
commit: 9228ebb2e2
---
# Keep self-host sandbox gateway URLs aligned with the public proxy route

**When:** changing `LLM_GATEWAY_PROXY_TARGET`, Caddy LLM matchers, or sandbox
gateway URL resolution. Test the final public URL through the deployed proxy.
Internal proxy mode does not prove that `/v1/llm-gateway/v1` is public.
*Incident:* self-host sessions received Caddy `404` because Compose selected that
internal prefix while Caddy exposed `/v1/llm` directly to the gateway.
*Enforcer:* `compose-assets.test.ts` pins `LLM_GATEWAY_BASE_URL` to the public
`${KORTIX_URL}/v1/llm` route.
