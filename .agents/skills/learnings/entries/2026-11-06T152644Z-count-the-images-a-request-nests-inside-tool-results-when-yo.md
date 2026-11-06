---
recorded: 2026-11-06T15:26:44Z
incident_date: 2026-11-06
---
# Count the images a request nests inside tool results when you bound a request

**Rule:** A window that bounds a model request's images must read every place the request shape puts one: Anthropic `tool_result.content[]`, Responses `function_call_output.output[]`, not only the top-level `content[]`. Bound bytes there too.

**Trigger surface:** Changing `apps/kortix-sandbox-agent-server/src/services/llm-proxy/llm-image-window.ts` or `packages/llm-gateway/src/pipeline/image-window.ts`, or adding a request shape (a new ingress, a new harness) that carries images.

**Incident:** Found 2026-11-06 while auditing the Bedrock request-size fix (#11934). Claude Code puts every tool screenshot inside a `tool_result` block, and the sandbox proxy window counted none. A real `claude` run through the proxy grew ~4.8 MB per 15 screenshot reads, passed Anthropic's 32 MB cap after ~100 reads, and every later turn of that session failed with "Request too large (max 32MB)": the session stays broken, because Claude Code resends its whole history.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/llm-image-window.test.ts` ("images inside a tool_result count", "a Responses function_call_output image counts", the 100-screenshot byte cap, and the cut matching the gateway window). The real-binary check is `scripts/claude-daemon-e2e.ts --proxy`: the biggest request must stay flat across turns.
