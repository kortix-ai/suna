---
recorded: 2026-09-17T21:45:22Z
incident_date: 2026-09-17
commit: 32c3328bfe
---
# Verify managed model access and prices at the serving endpoint

**When:** changing the managed model lineup or token rates. Call `/chat/completions`
with the deployment key for each model and read input modalities and all token
rates from the provider's current model feed. A public `is_ready` flag does not
prove that the key can route to the model.

**Near-miss (PR #7359):** GLM-5.3-Flash advertised `is_ready: true` but returned
HTTP 400 instead of the expected capacity 429. Two DeepSeek cached-input rates
in the draft catalog differed from Morph's model feed before merge.

**Enforcement:** `packages/llm-catalog/src/managed.test.ts` pins the corrected
cache rates; preview `target-full` rejects a missing managed vision model.
