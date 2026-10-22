---
recorded: 2026-09-28T23:52:31Z
incident_date: 2026-09-29
---
# Curate modalities and reasoning options for every managed model

**Rule:** Every managed model in `MANAGED_MODELS` must serve `modalities` and
`reasoning_options` from the curated lineup, never only from a models.dev record.
OpenCode reads image support only from `modalities.input`. It builds the thinking
control only from effort values. A model without a models.dev record gets neither.
Probe each effort value through the gateway before listing it.

**Trigger surface:** Adding or changing a model in `MANAGED_MODELS`, `managedModels()`
in `catalog-models.ts`, or the sandbox catalog overlay and reconcile.

**Incident:** On 2026-09-29, image input and the thinking control were found missing for
GLM 5.3 Flash (in the lineup since 2026-08-27) and DeepSeek V4.1 Flash (since
2026-09-17). The gateway accepted images for both models. In sessions, OpenCode replaced
every image with "Cannot read image (this model does not support image input)". The
agent then fell back to OCR or answered without the image. A sandbox that booted on the
baked catalog also kept stale capabilities, because the reconcile compared model ids only.
Fixed in #8026.

**Enforcement:** `catalog-models.test.ts` → "every served vision model advertises image
input and a thinking control". `opencode-catalog.test.ts` → "restarts once when a
booted managed model has stale image capability".
