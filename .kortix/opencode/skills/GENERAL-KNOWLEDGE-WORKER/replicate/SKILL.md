---
name: replicate
description: Discover, compare, and run AI models using Replicate's API. Use this skill whenever the task involves AI-generated media — images (text-to-image, style transfer, editing, upscaling, background removal), video, audio, or any other ML model output. Requires a REPLICATE_API_TOKEN — ask the user for it if not already set.
---

## When to use this skill

Use Replicate any time the task involves running an AI/ML model — most commonly:

- **Image generation** — text-to-image, style variations, artistic rendering
- **Image editing** — inpainting, outpainting, upscaling, background removal
- **Video generation** — text-to-video, image-to-video
- **Audio** — speech synthesis, music generation, voice cloning
- **Any other ML inference** — classification, segmentation, embeddings, etc.

If the user asks to generate or transform visual/audio content with AI, this is the right tool. Always ask for `REPLICATE_API_TOKEN` if it's not already available.

## Recommended Image Generation Models

| Use Case | Model |
|---|---|
| General image gen (best quality) | `black-forest-labs/flux-1.1-pro` |
| Fast image gen | `black-forest-labs/flux-schnell` |
| SDXL standard | `stability-ai/sdxl` |
| Image editing / inpainting | `stability-ai/stable-diffusion-inpainting` |
| Upscaling | `nightmareai/real-esrgan` |
| Remove background | `cjwbw/rembg` |
| Face generation | `tencentarc/photomaker` |

Always fetch the model's current schema before running — schemas change.

## Docs & Reference

- **Full HTTP API reference**: https://replicate.com/docs/reference/http
- **llms.txt** (LLM-optimized overview): https://replicate.com/docs/llms.txt
- **OpenAPI schema** (machine-readable): https://api.replicate.com/openapi.json
- Set an `Accept: text/markdown` header when requesting docs pages to get a Markdown response.

## Workflow

1. **Check for REPLICATE_API_TOKEN** — if not set in env, ask the user before proceeding
2. **Choose the right model** — use the recommended models above, or search the API
3. **Fetch model schema** — GET `/v1/models/{owner}/{name}` to see exact input parameters
4. **Create prediction with a random seed** — POST to `/v1/predictions`; always use a fresh random seed per generation to ensure varied output
5. **Poll for results** — GET prediction until status is `"succeeded"` (typically 10–60s)
6. **Download and display output** — save the file locally and show it to the user; don't just report the URL
7. **Back up outputs** — URLs expire after 1 hour

## Generating varied output

Always use a random seed per prediction — never hardcode or reuse a seed unless the user explicitly asks for reproducibility. Vary prompts meaningfully (composition, lighting, mood, subject details) when generating multiple variations. Fire multiple predictions concurrently for faster results.

## Choosing models

- Use the search and collections APIs to find and compare models. Do not list all models — it's a firehose.
- Collections are curated by Replicate staff and vetted.
- Prefer official models: they're always running, have stable APIs, predictable pricing, and are maintained by Replicate.
- Community models can take a long time to boot unless deployed as always-on.

## Running models

Three ways to get output from a prediction:

1. Create a prediction, store its `id`, and poll until completion.
2. Set `Prefer: wait` header for a synchronous blocking response (fast models only).
3. Set a webhook URL — Replicate POSTs to it when the prediction completes.

Guidelines:

- Use `POST /v1/predictions` — it supports both official and community models.
- Always fetch and check model schemas before running. Schemas change.
- Validate inputs against schema constraints (min, max, enum). Don't violate them.
- Omit optional parameters unless you have a specific reason to set them.
- Use HTTPS URLs for file inputs. Base64 works but is less efficient.
- Fire multiple predictions concurrently — don't wait serially.
- Output URLs expire after 1 hour — save files if you need to keep them.

## HTTP API Reference

Base URL: `https://api.replicate.com/v1`
Auth: `Authorization: Bearer $REPLICATE_API_TOKEN` on every request.

### Authentication
All requests require the header: `Authorization: Bearer <token>`
Get tokens at https://replicate.com/account/api-tokens

---

### Search

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/search?query=<q>&limit=<n>` | Search public models, collections, and docs (beta). Returns model data + `metadata.tags`, `metadata.score`. |

---

### Predictions

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/predictions` | Create a prediction (any model — official or community). Pass `version` as `{owner}/{name}` for official models or `{owner}/{name}:{version_id}` for community. |
| `GET` | `/predictions/{prediction_id}` | Get prediction state. Status: `starting` → `processing` → `succeeded` / `failed` / `canceled`. |
| `GET` | `/predictions` | List all predictions (paginated, 100/page). Supports `created_after`, `created_before`, `source` query params. |
| `POST` | `/predictions/{prediction_id}/cancel` | Cancel a running prediction. |

**`POST /predictions` body:**
```json
{
  "version": "owner/model:version_id",
  "input": { "prompt": "...", "seed": 12345 },
  "webhook": "https://...",
  "webhook_events_filter": ["start", "output", "logs", "completed"]
}
```

**Headers for predictions:**
- `Prefer: wait` or `Prefer: wait=60` — block up to 60s for synchronous response
- `Cancel-After: 30s` — auto-cancel after duration (e.g. `30s`, `5m`, `1h`)

**Prediction status values:** `starting`, `processing`, `succeeded`, `failed`, `canceled`

---

### Models (Official endpoint)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/models/{owner}/{name}/predictions` | Create prediction using an official model (no version ID needed). |
| `GET` | `/models/{owner}/{name}` | Get model metadata + latest version schema. |
| `GET` | `/models` | List public models. Supports `sort_by` (`model_created_at`, `latest_version_created_at`) and `sort_direction` (`asc`, `desc`). |
| `QUERY` | `/models` | Search public models by text (body: plain text query). |
| `POST` | `/models` | Create a new model. |
| `PATCH` | `/models/{owner}/{name}` | Update model metadata (description, readme, github_url, paper_url, weights_url, license_url). |
| `DELETE` | `/models/{owner}/{name}` | Delete a model (private only, no versions). |
| `GET` | `/models/{owner}/{name}/examples` | List example predictions for a model. |
| `GET` | `/models/{owner}/{name}/readme` | Get model README as Markdown. |
| `GET` | `/models/{owner}/{name}/versions` | List all model versions (sorted newest first). |
| `GET` | `/models/{owner}/{name}/versions/{version_id}` | Get a specific version + its `openapi_schema`. |
| `DELETE` | `/models/{owner}/{name}/versions/{version_id}` | Delete a model version (private only). |

**Fetch input schema for a model:**
```bash
curl -s -H "Authorization: Bearer $REPLICATE_API_TOKEN" \
  https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro \
  | jq ".latest_version.openapi_schema.components.schemas.Input"
```

---

### Collections

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/collections` | List all curated collections. |
| `GET` | `/collections/{collection_slug}` | Get a collection + its models. Useful slugs: `text-to-image`, `super-resolution`, `image-to-video`, `audio-generation`, etc. |

---

### Deployments

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/deployments` | Create a deployment (always-on model instance). |
| `GET` | `/deployments` | List all deployments. |
| `GET` | `/deployments/{owner}/{name}` | Get a deployment. |
| `PATCH` | `/deployments/{owner}/{name}` | Update a deployment. |
| `DELETE` | `/deployments/{owner}/{name}` | Delete a deployment. |
| `POST` | `/deployments/{owner}/{name}/predictions` | Create a prediction using a deployment. |

---

### Trainings (Fine-tuning)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/models/{owner}/{name}/versions/{version_id}/trainings` | Create a training (fine-tune). |
| `GET` | `/trainings/{training_id}` | Get training status. |
| `GET` | `/trainings` | List trainings. |
| `POST` | `/trainings/{training_id}/cancel` | Cancel a training. |

---

### Hardware & Account

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/hardware` | List available hardware SKUs (used when creating models/deployments). |
| `GET` | `/account` | Get the authenticated account info. |

---

### Webhooks

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/webhooks/default/secret` | Get the signing secret for verifying webhook payloads. |

**Webhook event types:** `start`, `output`, `logs`, `completed`
Replicate signs webhook POSTs — verify using the signing secret from the endpoint above.
