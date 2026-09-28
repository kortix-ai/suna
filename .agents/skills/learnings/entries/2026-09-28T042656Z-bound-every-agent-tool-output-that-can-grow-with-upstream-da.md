---
recorded: 2026-09-28T04:26:56Z
incident_date: 2026-09-28
---
# Bound every agent tool output that can grow with upstream data: save it to a file and return the path plus its shape

**Rule:** A tool served to an agent runtime whose result size follows upstream data (a connector list, a search, an export) must bound its own output. Above a threshold (16 KB for connector calls), write the full JSON to a file outside the tracked tree, or in a directory that ignores itself, and return the path, the byte count, the shape (keys, array lengths, `pageInfo`), and a short preview. Never rely on the harness to truncate: OpenCode 1.18.23 cuts any tool output above 50 KB or 2000 lines and the model sees only the head.

**Trigger surface:** Adding or changing an MCP tool, an OpenCode custom tool, or a CLI command that agents call and that can return upstream data of unbounded size.

**Incident:** 2026-09-28. `kortix-connectors_call` returned every connector result inline. A GraphQL list query of about 93 KB reached models as "...N bytes truncated..."; models failed or improvised. Reproduced on dev with a 250-row public GraphQL query (~244 KB): the model saw 45 of 250 rows. Fixed in #7887 (`f8cb596df0`): MCP spill above 16 KB and `kortix connectors call --out <file>`.

**Enforcement:** `apps/cli/src/__tests__/connector-result-spill.test.ts` drives the real `kortix connectors mcp` process and fails if a large `call` result is returned inline (> 4 KB) or a small one is not returned unchanged. No generic check covers other tools yet: none yet: a test that runs each agent-facing tool against a large stub payload.
