---
recorded: 2026-08-22T18:30:42Z
commit: 08d13b6ebf
---
# A standalone service needs explicit caller wiring in every environment

2026-08-22. The API stopped hosting an in-process gateway and became a reverse
proxy. Self-host Compose configured `LLM_GATEWAY_PROXY_TARGET`. Dev ECS did not.
The gateway deployed healthy at the correct SHA, but the API returned
`gateway_unavailable` for every LLM route. The edge converted that origin `503`
into `MAINTENANCE_MODE`, which hid the missing environment variable.

**The rule.** A service extraction is incomplete until every caller in every
deployment topology has an explicit target. Configure local, self-host, dev,
staging, production, and shadow environments in the same change. Verify through
the caller route. A healthy callee does not prove that its caller can reach it.

**The enforcement.** Terraform now injects `LLM_GATEWAY_PROXY_TARGET` into each
cloud API task. The end-to-end verification calls `/v1/llm/health` through the
API origin and requires the standalone gateway health response.

*Incident:* dev API returned `gateway_unavailable` after gateway PR #6737.
The public edge surfaced it as blocking maintenance. Direct origin inspection
identified the missing target before user traffic resumed.
