---
title: Native image generation in sessions
status: in progress (branch image-gen)
owner: Jay Suthar
updated: 2026-10-28
---

# Native Image Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user with a connected ChatGPT account asks "generate an image of X" in a Kortix session. The agent calls a real image model (`gpt-image-2` on their ChatGPT plan). The chat shows a dedicated image card with an animated "Generating image" state that becomes the image.

**Architecture:** Four layers, one change each. (1) The LLM gateway gets `POST /images/generations` and `/images/edits`. They resolve the project's ChatGPT login with the existing `resolveUpstream` and relay to `chatgpt.com/backend-api/codex/images/*`. (2) kortixd gets a Kortix tool `image_gen` that calls that route with the session token and saves the PNG under `/workspace`. (3) The SDK treats an `image_gen` call as a deliverable, like `show`, so it stays visible after the turn folds. (4) The existing `image-gen` card on web and mobile gets a real generating, ready, failed and stopped design.

**Tech Stack:** Bun, Hono (`apps/llm-gateway`), `@kortix/llm-gateway`, kortixd + pi, `@kortix/sdk`, `@kortix/ui` (React 19), Expo / React Native.

**Spec:** This file. The spec is the "Spec" section below. On execution this file moves to `.agents/skills/learnings/work/image-generation/README.md` on the feature branch, with the `work/` frontmatter (`title`, `status`, `owner`, `updated`).

---

## Spec

### Problem (evidence)

A prod session (`kortix/codex/gpt-6.1-sol`, ChatGPT plan) was asked for a paper-cutout image. The sandbox transcript shows:

1. `codemode` searched tools for "image generation" and found only `image_search` (Google Images).
2. The agent wrote `create_art.py`, which draws shapes with Pillow, ran it, then called `show`.

Kortix has no image-generation path:

- The gateway serves only `chat/completions`, `messages`, `responses` and `models` (`apps/llm-gateway/src/routes.ts:92-98`).
- kortixd has 5 Kortix tools and none of them generates images (`KORTIX_TOOL_NAMES`, `packages/manifest-schema/src/constants.ts:431`).

The ChatGPT plan can generate images. Codex CLI ships a default-on tool that POSTs `{prompt, model: "gpt-image-2", background, quality: "auto", size: "auto"}` to `<chatgpt base>/images/generations`. Edits POST JSON `images: [{image_url: "data:…"}]` (max 5) to `/images/edits`. The response is `{created, data: [{b64_json, generation_id?}], background?, quality?, size?}` (source: `openai/codex` `codex-rs/codex-api/src/images.rs`, `codex-rs/ext/image-generation/src/tool.rs`).

### Product brief (product-thinking format)

| | |
|---|---|
| Job | A user asks the agent for an image. Today the agent fakes one with Python drawing code, or the user leaves Kortix for ChatGPT. |
| Change | One Kortix tool `image_gen`, one gateway route pair, and one card. Credentials, auth, traces and the turn UI are reused. |
| Reuse | The SDK already knows `image_gen`: status text "Creating an image..." (`packages/sdk/src/core/turns/state.ts:207`), narration "Made an image" / "Edited an image" (`segments/narration.ts:368-373`), the Outputs panel (`createArtifactKind`), and the `image-gen` renderers on web (`packages/ui/src/session/tool/tools/image-gen-tool.tsx`) and mobile (`apps/mobile/components/session/tool/tools/image-gen-tool.tsx`). The ChatGPT login resolves through `resolveCandidates` for any `codex/<slug>` (`apps/api/src/llm-gateway/resolution/resolve-candidates.ts:485-496`). |
| Metric | Gateway traces with `metadata.operation = "images.generations" \| "images.edits"`: distinct projects per week (adoption) and the share with `ok = true` (health; target ≥ 95 %). |
| Kill | No kill: this is a core capability. Investigate when 7-day success is under 90 %. |

### Decisions (confirm at review)

- **D1 — Tool name `image_gen`.** Every SDK and UI path above keys on this name. Its input keeps the legacy `action` field (`generate` | `edit`), so narration and Outputs work unchanged.
- **D2 — v1 credential: ChatGPT connection only.** The tool requests `codex/gpt-image-2`. Kortix credits need per-image pricing and a wallet hold. An OpenAI API key needs the BYOK fee rules. Both are follow-ups (see "Parked"). Without a ChatGPT connection, the card shows "Connect ChatGPT to generate images" with the connect action.
- **D3 — Existing projects get `image_gen` by default.** The base starter writes an explicit `tools:` list (`packages/starter/templates/base/kortix.yaml:86-91`). Today a listed manifest loads only the names it lists (`compileTools`, `apps/api/src/projects/lib/compile-agent-config.ts:290-301`). Without D3 almost no existing project would get the tool. New rule: `DEFAULT_ON_KORTIX_TOOLS = ['image_gen']` load unless the manifest names that key. A project opts out with an agent `tools` switch (`image_gen: false`) or a permission rule (`image_gen: deny`). A project replaces it by mapping `image_gen` to its own module. *Alternative: opt-in only (add the line to the starter, announce it). This is safer for the contract but nearly invisible.*
- **D4 — The card is a deliverable.** After a turn settles, `splitTurnWork` hoists only `show` / `show_user` (`packages/sdk/src/core/turns/segments/work-split.ts:30-35`). Everything else folds behind "Worked for…". `image_gen` joins the deliverables, `STANDALONE_TOOLS` and `NO_GROUP_ACTIVITY_TOOLS`.
- **D5 — The display adapts to the request ("dynamic").**
  - **No added prompt text anywhere.** No system-prompt lines, no agent or skill instructions, no behavioral hints in the tool description or the tool output. The model picks tools as it does today; the product handles both cases in code.
  - **Case 1, the model calls `image_gen`:** the `image_gen` card shows the image.
  - **Case 2, the model calls `show` for an image** (alone or with other files): the `show` card shows it with the same loading frame (Task 8).
  - **Both, for the same file:** the UI shows it once. A `show` image item whose path equals an earlier `image_gen` output path in the same turn is not rendered again (Task 8). This is code, not an instruction to the model.
- **D6 — Always a native card, even in codemode.** A codemode script's nested call renders as one `codemode` part, not as an `image_gen` card. The pi nested-call gate refuses `image_gen` from a script (as it does `task` and `question`, `apps/kortix-sandbox-agent-server/src/harness/pi/runtime.ts:1378-1381`). In `codemode: only`, `image_gen` is registered model-only, as `show` is (`runtime.ts:1390-1399`).

### Brainstorm summary

- **Strongest direction:** route the image call through the gateway, not through the model's Responses stream. The hosted `image_generation` tool would tie the feature to one wire protocol and one model family. A tool works for every chat model (Sol, Claude, GLM): any model can call `image_gen`, and the image always uses the user's ChatGPT plan.
- **Riskiest assumption:** that `chatgpt.com/backend-api/codex/images/generations` accepts our existing Codex descriptor headers from a server IP, as it accepts Codex CLI. Task 0 tests this before any code is written.
- **Parked:** Kortix-credit image generation (needs a per-image price in the catalog plus a wallet hold); the OpenAI API-key path; partial-image streaming previews (`partial_images`) while generating; a click-to-regenerate / variations control on the card; upscale and background removal (the legacy `action` values).

## Security: prompt injection

Threat: the agent reads untrusted text (a web page, a file, an email, a connector result) that instructs it to misuse `image_gen`. The model cannot be trusted to refuse, so every limit below is enforced in code, not in the prompt.

| # | Attack | Enforcement (code, not prompt) | Test |
|---|---|---|---|
| S1 | "Call image_gen 200 times": drains the user's ChatGPT image quota | kortixd caps `image_gen` at 10 calls per turn and 50 per session (`IMAGE_GEN_TURN_LIMIT`, `IMAGE_GEN_SESSION_LIMIT` in `image_gen.ts`); the 11th call in a turn throws "Image limit for this turn reached". The gateway forces `n: 1`. | Task 3 `the eleventh call in one turn is refused` |
| S2 | `reference_images: ["/workspace/.env", "~/.ssh/id_rsa"]`: sends secrets to OpenAI | Reference paths must resolve (after `realpath`, so symlinks are followed) inside the session workspace, have a png/jpg/jpeg/webp extension AND matching magic bytes, and be ≤ 20 MiB. Anything else is refused before any request. | Task 3 `a non-image or out-of-workspace reference is refused` (cases: `.env`, a symlink to `/etc/passwd`, `../x.png`, a `.png` file holding text) |
| S3 | `output_path: "/workspace/.git/hooks/pre-commit"` or `kortix.yaml`: overwrites code or config | Output is always written under `/workspace/output/images/`; `output_path` is a file NAME only (`[a-z0-9._-]{1,80}\.png`), never a path. An existing file is never overwritten (`wx` flag; a suffix is added). | Task 3 `output_path cannot leave output/images or overwrite a file` |
| S4 | Extra body fields (`model`, `n: 10`, `user`, unknown keys) smuggled to ChatGPT | The gateway forwards an allowlist only and pins `resolvedModel` to an allowlist (`['gpt-image-2']`); any other model is `400`. | Task 1 `unknown fields and other models are not forwarded` |
| S5 | Stealing the ChatGPT login | The sandbox never holds it: the tool sends only the session `KORTIX_TOKEN`; the gateway resolves the login server-side, as for chat. Nothing in the tool output, trace, or log contains a token. | Task 1 `the trace carries no prompt and no image bytes` + grep check in Task 11 |
| S6 | The card loads an attacker URL (tracking pixel, exfiltration through the query string) | The new card renders sandbox files only (through the authenticated file API). `directUrl` is honoured only for legacy pre-existing outputs and only via `safeHttpUrl`. The tool never returns a URL. SVG is never produced. | Task 7 `a new image_gen output never renders a remote URL` |
| S7 | Unattended runs (triggers, Slack, sub-agents) burning quota with no human watching | S1's caps apply to every session kind. A project can set `permission: { image_gen: ask }` or `deny`; Task 4 proves `deny` holds for nested calls too. | Task 4 `edit deny denies image_gen` |
| S8 | Text inside a generated image instructs the model later | Same exposure as any image the agent views today; the tool output never includes image content, only the path. Accepted risk, noted. | — |

## Global Constraints

- Branch: new canonical branch `image-gen`, created with `pnpm worktree create --name image-gen --yes --no-start` (from fresh `origin/dev`). All work happens under `../suna-image-gen`. Not `services-page`.
- Commit only after Jay approves executing this plan. Ask Jay before merging to `dev` (his standing rule overrides the self-merge default in CLAUDE.md).
- Never run a suite. Run each test file named in a task: `pnpm --filter <pkg> test <file>`. A Mac exits `2` on suite runs.
- `packages/sdk`: load the **sdk** skill. TDD is mandatory. End each SDK task with the gates run and a shippable YES/NO/NOT YET.
- Load **ponytail** before writing code, and **animations-dev** before writing the card motion.
- Kortix tool modules import only `node:*` (`apps/kortix-sandbox-agent-server/src/services/tools/kortix/*`). After a change, run `bun run apps/cli/scripts/generate-kortix-tools.ts`.
- The tool output is a small JSON object with a path. Image bytes never enter a tool output, a trace, or a log.
- Gateway traces carry no prompt and no image: `request: null`, `response: null`.
- UI follows `.agents/skills/kortix-brand/SKILL.md`: token values only. The busy glyph is `SessionDotMatrix`. No icon spinner (`Loading` is the only spinner). Motion respects `prefers-reduced-motion`.
- UI verification follows Jay's rule: tests, `eslint` and typecheck, then Jay checks visually. No agent-driven browser. Backend surfaces (gateway route, tool, real session) are verified with real HTTP and a real session.
- No customer data in fixtures, tests, commits or the PR. Use synthetic prompts and IDs.
- pi only. Add no OpenCode-specific code (OpenCode is deprecated).
- Model id sent by the tool: `codex/gpt-image-2`. Sizes: `auto`, `1024x1024`, `1536x1024`, `1024x1536`. Max 5 reference images, max 20 MiB each. Tool timeout 300 s.

## Review Focus

1. **No ChatGPT connection, or the login expired.** The card shows the gateway's message plus a "Connect ChatGPT" action. → tests in Task 1 (`provider_not_connected`, `provider_reauth_required`) and Task 3 (refusal surfaces message + suggestion).
2. **The ChatGPT image limit is reached (429).** The card shows "Image limit reached" plus the retry time from `retry-after`. The pool account rests, as for chat. → Task 1 test `429 notes the pool cooldown`.
3. **The user presses Stop during the 30–120 s generation.** The upstream fetch aborts, no file is written, and the card shows "Stopped", not an endless shimmer. → Task 3 test `an aborted turn aborts the request and writes no file`; Task 7 test `an aborted call maps to stopped`.
4. **The model calls `image_gen` inside a codemode script.** It gets "Call image_gen directly" and retries directly, so the card renders. → Task 4 tests.
5. **A reload in the middle of a generation.** The card returns in the generating state from the transcript (`status: running`), with elapsed time measured from the part's `time.start`, not from mount. → Task 7 test `elapsed time counts from the part start`.

---

### Task 0: Live probe of the ChatGPT images endpoint (gate)

**Files:**
- Create: `output/image-probe/probe.ts` (gitignored `output/`, never committed)

**Interfaces:**
- Produces: a recorded answer to "does `/images/generations` and `/images/edits` work with our Codex descriptor headers?" and the real response shape. Later tasks assert this exact shape.

- [ ] **Step 1: Write `probe.ts`.** Read the access token and account id from Jay's local Codex CLI login (`~/.codex/auth.json`, present on this machine). Refresh it with `codex login` first if it has expired. Never print the token. Send the headers of `codexDescriptor` (`apps/api/src/llm-gateway/resolution/descriptors.ts:184-202`): `originator: codex_cli_rs`, `User-Agent: CODEX_USER_AGENT`, `ChatGPT-Account-ID`, `Authorization: Bearer <access>`.
- [ ] **Step 2: Run 4 calls and save each status, headers, latency, and response keys (not bytes) to `output/image-probe/result.json`:**
  1. generate, `size: "auto"`;
  2. generate, `size: "1536x1024"`, `quality: "low"`;
  3. edit with 1 PNG data URL;
  4. generate with `n: 2` (expect a refusal or 1 image; record which).
- [ ] **Step 3: Gate.**
  - **Calls 1 and 3 return 200 with `data[0].b64_json`:** continue.
  - **Either returns 401, 403 or 404:** stop and report to Jay with the status and body. The fallback is the OpenAI API-key path (D2 changes).
  - **Record** the median latency and any `x-codex-*` / rate-limit headers in the plan's work folder (no tokens, no IDs).

**Task 0 result (2026-10-28, a Pro Lite ChatGPT plan, Codex descriptor headers):**

| Call | Status | Latency | Result |
|---|---|---|---|
| generate, `size: auto` | 200 | 14.2 s | 1 image, server chose `1374x1145`, `quality: low` |
| generate, `1536x1024`, `low` | 200 | 17.7 s | 1 image, `1536x1024`, 4.0 MB base64 |
| edit, 1 PNG data URL | 200 | 14.2 s | 1 image, `1254x1254` |
| generate, `n: 2` | 200 | 13.8 s | 1 image: `n` is ignored |

- Response keys: `created, background, data[{b64_json, generation_id}], output_format, quality, safety_identifier, size, usage`.
- The requested size is not the delivered size (`1024x1024` → `1254x1254`). The card uses the requested size only for its placeholder and switches to the image's natural size on load.
- Limit headers: `x-codex-active-limit: imagegen_premium`, `x-codex-primary-used-percent`, `x-codex-primary-window-minutes: 1440`, `x-codex-primary-reset-after-seconds`. The gateway forwards `x-codex-primary-*` headers so a 429 can say when the limit resets.

### Task 1: Gateway images handler

**Files:**
- Create: `packages/llm-gateway/src/pipeline/images.ts`
- Test: `packages/llm-gateway/src/pipeline/images.test.ts`
- Modify: `packages/llm-gateway/src/pipeline/simple-handler.ts` (export the existing `authorize`, `bearer`, `requestId`, `identity` helpers, unchanged)
- Modify: `packages/llm-gateway/src/pipeline/index.ts`
- Modify: `packages/llm-gateway/src/create-gateway.ts` (add `images` to the returned object)

**Interfaces:**
- Consumes: `GatewayHooks.authorize|authenticate`, `resolveUpstream`, `refreshCredential`, `notePoolRateLimit`, `recordTrace` (`packages/llm-gateway/src/domain/hooks.ts`); `gatewayErrorResponse` (`pipeline/error-response.ts`); `GatewayResolutionError`.
- Produces:
  ```ts
  export type ImageOperation = 'generations' | 'edits';
  export interface ImageRequest { authorization: string | undefined; rawBody: string; operation: ImageOperation; signal?: AbortSignal }
  export function handleImageRequest(runtime: HandlerRuntime, req: ImageRequest): Promise<Response>;
  // createGateway(...) returns { chatCompletions, messages, responses, listModels, images: (req: ImageRequest) => Promise<Response> }
  ```

Behavior the tests pin:
- The forwarded body is an allowlist: `prompt` (required, non-empty), `size`, `quality`, `background`, `images` (edits only, 1–5 entries). `n` is forced to `1`. `model` becomes `descriptor.resolvedModel`.
- v1 serves only `descriptor.provider === 'openai-codex'`. Any other descriptor gets `400 image_model_unsupported` with "Image generation needs a connected ChatGPT account.", and no upstream call.
- The success body streams through unread (`new Response(upstream.body, …)`). A 4 MB base64 body is never parsed by the gateway.

- [ ] **Step 1: Write the failing tests** (use the hook and `fetchImpl` fakes of `simple-handler.test.ts`):

```ts
test('generations posts the prompt to the ChatGPT images endpoint with the login headers', …)
  // url === 'https://chatgpt.com/backend-api/codex/images/generations'
  // headers.authorization === 'Bearer access-1'; headers['chatgpt-account-id'] === 'acct-1'
  // JSON body: { model: 'gpt-image-2', prompt: 'a red cube', n: 1, size: 'auto' }; no other keys
  // response.status === 200; (await response.json()).data[0].b64_json === FAKE_B64
test('edits forwards at most five reference images', …)            // 6 images → 400 invalid_request, fetch not called
test('a model that is not a ChatGPT login is refused before any upstream call', …)  // 400 image_model_unsupported
test('an unconnected ChatGPT account answers the resolution error', …)
  // resolveUpstream throws GatewayResolutionError('provider_not_connected', …) → 400, body.code === 'provider_not_connected', body.suggestion present
test('a 401 refreshes the login once and retries', …)              // 2 fetches; 2nd authorization === 'Bearer access-2'
test('429 notes the pool cooldown and answers image_rate_limited', …)
  // upstream 429 retry-after: 120 → notePoolRateLimit(principal, 'secret-1', 120); response 429, body.code === 'image_rate_limited', body.retry_after === 120
test('a missing bearer token is 401 before the body is read', …)
test('the trace carries no prompt and no image bytes', …)
  // one trace; metadata.operation === 'images.generations'; request === null; JSON.stringify(trace) excludes 'a red cube'
test('client abort cancels the upstream fetch', …)                 // signal passed to fetchImpl is aborted after req.signal aborts
test('unknown fields and other models are not forwarded', …)       // body {model:'codex/gpt-image-1', n:10, user:'x'} → 400 for the model; with gpt-image-2 the forwarded keys are exactly the allowlist and n === 1
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @kortix/llm-gateway test src/pipeline/images.test.ts` → "Cannot find module './images'".
- [ ] **Step 3: Implement `handleImageRequest`.** Upstream timeout: `AbortSignal.any([req.signal, AbortSignal.timeout(300_000)])`. Error envelope: the same `gatewayErrorResponse` shape the chat path uses (`message`, `code`, `suggestion`, `requestId`).
- [ ] **Step 4: Run, expect PASS** (same command). Also run `pnpm --filter @kortix/llm-gateway exec tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(gateway): images generations and edits through the ChatGPT login`.

### Task 2: Standalone gateway routes

**Files:**
- Modify: `apps/llm-gateway/src/routes.ts`
- Test: `apps/llm-gateway/src/server.test.ts`
- Modify: `apps/api/src/llm-gateway/wire.ts:503-508` (OpenAPI `registerPath` entries for `/images/generations` and `/images/edits`. Docs only: the `/v1/llm/*` catch-all already proxies them)

**Interfaces:**
- Consumes: `gateway.images` (Task 1).
- Produces: `POST {/, /v1/, /v1/llm/, /v1/openai/}images/{generations,edits}`. The sandbox reaches it as `${KORTIX_LLM_BASE_URL}/images/generations`.

- [ ] **Step 1: Write the failing tests.**
  - `test('POST /v1/images/generations reaches gateway.images with operation generations')`
  - `test('an oversized image body is 413 before gateway.images runs')`: reuses `readAdmittedBody`, which keeps the inflight-budget admission.
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @kortix/llm-gateway-server test src/server.test.ts`.
- [ ] **Step 3: Implement.** Add `images` to the `Gateway` type. Add an `images(operation)` route factory beside `inference()`. It uses the same admission, `releaseWhenResponseEnds` and `recordOutcome`. A thrown error gets the Responses-style 503 envelope `failure('responses', …)` already uses.
- [ ] **Step 4: Run, expect PASS.** Then run `bun run apps/api/scripts/dump-routes.ts` and commit any change to `tests/spec/routes.generated.json`.
- [ ] **Step 5: Commit** — `feat(gateway): serve /images routes`.

### Task 3: The `image_gen` Kortix tool

**Files:**
- Create: `apps/kortix-sandbox-agent-server/src/services/tools/kortix/image_gen.ts`
- Modify: `apps/kortix-sandbox-agent-server/src/services/tools/host.ts:30-36` (add to `KORTIX_TOOLS`)
- Modify: `packages/manifest-schema/src/constants.ts:431` (`KORTIX_TOOL_NAMES` += `'image_gen'`)
- Modify: `apps/kortix-sandbox-agent-server/src/harness/pi/interactions.ts` (`TOOL_CAPABILITY.image_gen = 'edit'`: it writes a file, so `edit: deny` stops it, per learning 2026-10-01)
- Regenerate: `apps/cli/src/kortix-tools.generated.json`
- Test: `apps/kortix-sandbox-agent-server/src/__tests__/kortix-tools.test.ts` (Bun.serve fake on a real port, as for `image_search`)
- Modify: `apps/kortix-sandbox-agent-server/src/harness/README.md:1209` (tool list row)

**Interfaces:**
- Consumes: `POST ${KORTIX_LLM_BASE_URL}/images/{generations|edits}` with `Authorization: Bearer ${KORTIX_TOKEN}` (Task 2).
- Produces the tool contract the UI (Task 7) and the SDK narration read:
  ```ts
  // parameters (JSON Schema): required ['action', 'prompt']
  // action: 'generate' | 'edit'; prompt: string
  // reference_images?: string[]   (edit: 1–5 workspace paths; png | jpg | jpeg | webp; ≤ 20 MiB each)
  // size?: 'auto' | '1024x1024' | '1536x1024' | '1024x1536'   (default 'auto')
  // quality?: 'auto' | 'low' | 'medium' | 'high'              (default 'auto')
  // transparent_background?: boolean                           (default false)
  // output_name?: string   (file name only, /^[a-z0-9._-]{1,80}\.png$/; written under /workspace/output/images/; default `<slug-of-prompt, ≤ 40 chars>-<yyyymmdd-hhmmss>.png`; never overwrites)
  // execute → JSON string:
  { "path": string, "action": "generate" | "edit", "size": string, "model": "gpt-image-2" }
  ```
- Description text: factual only, no behavioral instructions (D5):
  > "Generate or edit an image with gpt-image-2. Saves a PNG under /workspace/output/images/ and returns its path."

- [ ] **Step 1: Write the failing tests:**

```ts
describe('image_gen', () => {
  test('generate posts to the gateway images route with the session token and saves the PNG', …)
    // fake receives POST /v1/llm/images/generations, authorization 'Bearer tok', body.model 'codex/gpt-image-2', body.n 1
    // returned JSON.path exists; first 8 bytes === PNG magic; JSON.action === 'generate'
  test('edit sends each reference image as a data URL', …)          // body.images[1].image_url startsWith 'data:image/jpeg;base64,'
  test('a missing reference image is refused before any request', …) // error names the path; fake saw 0 requests
  test('six reference images are refused', …)
  test('a gateway refusal surfaces its message and suggestion', …)
    // fake 400 { code: 'provider_not_connected', message: 'Connect Codex to use this model.', suggestion: 'Connect your ChatGPT…' } → thrown message contains both
  test('no gateway env names what is missing', …)                  // no KORTIX_LLM_BASE_URL → error names KORTIX_LLM_BASE_URL
  test('an aborted turn aborts the request and writes no file', …)
  test('the eleventh call in one turn is refused', …)              // S1: fake saw 10 requests
  test('a non-image or out-of-workspace reference is refused', …)  // S2: .env, symlink → /etc/passwd, ../x.png, text-in-.png; fake saw 0 requests
  test('output_path cannot leave output/images or overwrite a file', …) // S3: '../kortix.yaml' refused; an existing name gets a suffix
})
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter kortixd test src/__tests__/kortix-tools.test.ts`.
- [ ] **Step 3: Implement `image_gen.ts`.** Follow `image_search.ts` (local `ToolContext` interface, `node:*` imports only). Resolve a relative path against `context.directory`. Create the parent directory with `mkdir -p`.
- [ ] **Step 4: Run, expect PASS.** Then:
  - Regenerate the CLI copy: `bun run apps/cli/scripts/generate-kortix-tools.ts`.
  - Run `pnpm --filter @kortix/cli test src/__tests__/kortix-tools-embedded.test.ts`.
  - Run `pnpm --filter kortixd test src/__tests__/tool-host.test.ts`.
- [ ] **Step 5: Commit** — `feat(kortixd): image_gen Kortix tool`.

### Task 4: pi renders `image_gen` as its own part

**Files:**
- Modify: `apps/kortix-sandbox-agent-server/src/harness/pi/runtime.ts:1378-1381` (`nestedCallGate`: refuse `image_gen` from a script) and `:1390-1399` (`presentationExtension`: register `image_gen` model-only when `codemodeMode === 'only'`)
- Test: `apps/kortix-sandbox-agent-server/src/__tests__/pi-harness.test.ts` (next to the existing `show` model-only and `task`/`question` gate tests; find them by grepping `directly, not from a script`)

- [ ] **Step 1: Write the failing tests:**
  - `test('image_gen called from a codemode script is refused with call it directly')`: the reason equals `'Call image_gen directly, not from a script.'`.
  - `test('codemode only still declares image_gen to the model')`.
  - `test('edit deny denies image_gen')`: in the permission test that covers `toolCapability`.
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter kortixd test src/__tests__/pi-harness.test.ts`.
- [ ] **Step 3: Implement.** Generalize the two places to a `const NATIVE_PART_TOOLS = ['show', 'image_gen']` list. Keep `task` and `question` in the gate.
- [ ] **Step 4: Run, expect PASS.** Also run `pnpm --filter kortixd exec bun run lint`, which enforces the architecture rules.
- [ ] **Step 5: Commit** — `feat(kortixd): image_gen always renders as its own transcript part`.

### Task 5: Existing projects get `image_gen` (D3)

**Files:**
- Modify: `packages/manifest-schema/src/constants.ts`. Add `export const DEFAULT_ON_KORTIX_TOOLS = ['image_gen'] as const`, with a doc comment: "Kortix tools a manifest's `tools:` list loads unless it names the key."
- Modify: `apps/api/src/projects/lib/compile-agent-config.ts:290-301`. `kortix_tools` = the listed names plus each default-on name the map does not mention.
- Modify: `apps/cli/src/commands/tools.ts`, so `kortix tools ls` lists what a session gets.
- Modify: `packages/starter/templates/base/kortix.yaml:86-91`. Add `image_gen: kortix:image_gen      # generates images with your ChatGPT plan`, then regenerate the starter embed with `bun run packages/starter/scripts/generate-embedded.ts` (writes `packages/starter/src/embedded.generated.json`).
- Test: `apps/api/src/projects/lib/compile-agent-config.test.ts`, `apps/cli/src/__tests__/tools-command.blackbox.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `test('a tools list written before image_gen existed still loads image_gen')`: `tools: { web_search: 'kortix:web_search' }` → `kortix_tools` equals `['web_search', 'image_gen']`.
  - `test('image_gen mapped to a project module compiles as a project tool')`: `project_tools.image_gen === 'tools/img.ts'` and `kortix_tools` excludes it.
  - `test('kortix tools ls shows image_gen for a list that does not name it')`: stdout row `image_gen       kortix  kortix:image_gen`.
- [ ] **Step 2: Run, expect FAIL:**
  - `pnpm --filter kortix-api test src/projects/lib/compile-agent-config.test.ts`
  - `pnpm --filter @kortix/cli test src/__tests__/tools-command.blackbox.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.** Also run `pnpm --filter @kortix/manifest-schema test src/__tests__/json-schema.conformance.test.ts`: `image_gen: kortix:image_gen` must validate.
- [ ] **Step 5: Commit** — `feat(manifest): image_gen loads by default for existing tool lists`.

### Task 6: SDK: `image_gen` is a deliverable (D4)

**Files:**
- Modify: `packages/sdk/src/core/turns/segments/work-split.ts:30-35` (`isDeliverableSegment`)
- Modify: `packages/sdk/src/core/turns/segments/session-activity-groups.ts:43` (`NO_GROUP_ACTIVITY_TOOLS`) and `:131-139` (`STANDALONE_TOOLS`)
- Test: `packages/sdk/src/core/turns/segments/work-split.test.ts`, `session-activity-groups.test.ts`

**Interfaces:**
- Produces: no new export. `STANDALONE_TOOLS` gains a member. The public-surface snapshot (`packages/sdk/src/public-surface.snapshot.json`) lists names only and does not change.

- [ ] **Step 1: Write the failing tests** (load the **sdk** skill first):
  - `test('a settled turn hoists an image_gen card above the final text')`: segments `[tool bash, tool image_gen, text]` → `hoisted` = `[image_gen]`, `work` = `[bash]`.
  - `test('a failed image_gen is still hoisted so its error is visible')`
  - `test('image_gen never folds into a burst group')`
- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @kortix/sdk test src/core/turns/segments/work-split.test.ts src/core/turns/segments/session-activity-groups.test.ts`.
- [ ] **Step 3: Implement.** Extract one `DELIVERABLE_TOOLS = new Set(['show', 'show_user', 'image_gen'])` in `session-activity-groups.ts` and read it from `work-split.ts`. Do not keep two lists.
- [ ] **Step 4: Run, expect PASS.** Then run the sdk skill's gates and paste their output with a shippable verdict.
- [ ] **Step 5: Commit** — `feat(sdk): image_gen cards stay visible after the turn folds`.

### Task 7: Web image card

**Files:**
- Create: `packages/ui/src/session/media/image-frame.tsx`: the shared frame (aspect box, generating surface, fade-in image)
- Create: `packages/ui/src/session/tool/tools/image-gen-view.ts`: pure mapping from a tool call to view state
- Test: `packages/ui/src/session/tool/tools/image-gen-view.test.ts`
- Modify: `packages/ui/src/session/tool/tools/image-gen-tool.tsx` (rewrite the body; keep `ToolRegistry.register('image-gen', …)`)
- Modify: the i18n catalog the file already reads (`packages/ui/src/i18n/en.ts`) for the new strings

**Interfaces:**
- Consumes: `partInput`, `partOutput`, `useFileContent`, `parseImageOutput` (exists), `SessionDotMatrix`, `TextShimmer`, the "Connect ChatGPT" action at `packages/ui/src/session/models/model-selector.tsx:921`.
- Produces:
  ```ts
  export type ImageGenPhase = 'generating' | 'ready' | 'failed' | 'stopped';
  export interface ImageGenView {
    phase: ImageGenPhase; action: 'generate' | 'edit'; prompt: string;
    aspectRatio: '1 / 1' | '3 / 2' | '2 / 3';          // from input.size; 'auto' → '1 / 1'
    imagePath: string | null; directUrl: string | null; // via parseImageOutput (legacy outputs keep working)
    startedAt: number | null;                           // part time.start, for elapsed time
    error: { message: string; suggestion?: string; connectChatGpt: boolean } | null;
  }
  export function imageGenView(call: ToolCallBlock): ImageGenView;   // the `ToolProps['call']` type
  export function ImageFrame(props: { aspectRatio: string; src: string | null; alt: string; pending: boolean; label?: ReactNode; onOpen?: () => void }): JSX.Element;
  ```

Design (one direction; Jay reviews it visually):
- **Card:** always open, with no collapsible `BasicTool` row. Width `min(100%, 28rem)`. The frame takes the requested aspect ratio before any pixel exists, so the layout does not jump.
- **Generating:** a `bg-muted` frame with one slow diagonal sheen (transform-only, ~1.8 s, ease-in-out, infinite; static under `prefers-reduced-motion`). Header: `SessionDotMatrix` (seeded by the call id, 14 px) + `TextShimmer` "Generating image" / "Editing image" + elapsed `0:42` (`tabular-nums`). The prompt sits below in 2 muted lines.
- **Ready:** the image fades in (opacity 0→1 and blur 4 px→0, ~240 ms ease-out). Click opens the file viewer, as the `show` image does. Hover shows open and download (reuse `ShowFileActions`). The caption is the prompt.
- **Failed:** a quiet row in the frame with message + suggestion. When `connectChatGpt` is true, show a "Connect ChatGPT" button.
- **Stopped:** a "Stopped" row with no shimmer.

- [ ] **Step 1: Write the failing tests:**

```ts
test('a running call maps to generating with the aspect of its size')        // size '1536x1024' → '3 / 2'
test('a completed JSON output maps to ready with the image path')
test('a provider_not_connected error maps to failed with the connect action') // connectChatGpt === true
test('an aborted call maps to stopped')
test('elapsed time counts from the part start')                               // startedAt === part.state.time.start
test('a legacy image_gen output with replicate_url still renders')            // directUrl set
test('a new image_gen output never renders a remote URL')                     // output {path, url:'https://evil'} → directUrl === null
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @kortix/ui test src/session/tool/tools/image-gen-view.test.ts`.
- [ ] **Step 3: Implement** `image-gen-view.ts`, then `ImageFrame`, then the card. Load **animations-dev** before the motion code.
- [ ] **Step 4: Run, expect PASS.** Then:
  - `npx eslint packages/ui/src/session/tool/tools/image-gen-tool.tsx packages/ui/src/session/media/image-frame.tsx`
  - `pnpm --filter Kortix-Computer-Frontend typecheck`: no new errors compared with `origin/dev`.
  - `.agents/skills/kortix-brand/scripts/audit.sh packages/ui/src/session/media/image-frame.tsx packages/ui/src/session/tool/tools/image-gen-tool.tsx`: clean.
- [ ] **Step 5: Commit** — `feat(ui): image generation card with a live generating state`.

### Task 8: `show` images get the same loading frame, and one image renders once (D5)

**Files:**
- Modify: the image branch of `ShowContentRenderer` in `packages/ui/src/session/tool/shared/show-helpers.tsx`
- Test: the existing show-helpers test file (or create `show-image-loading.test.tsx` beside it)

- [ ] **Step 1: Write the failing tests:**
  - `test('a show image renders the image frame while its file loads')`: while `useFileContent` is pending, the frame with `aria-busy="true"` is in the DOM, and no bare path text.
  - `test('a show image already drawn by image_gen in the same turn is not drawn again')`: a turn with `image_gen` output path `/workspace/output/images/a.png` then `show` of the same path → one image in the DOM. A `show` with that image plus a PDF still renders the PDF.
  - Put the path comparison in one pure SDK-free helper next to `image-gen-view.ts` (`imagePathsShownByImageGen(turnCalls): Set<string>`) and unit-test it there.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Render `ImageFrame` with `pending` while the file loads (label "Loading image").
- [ ] **Step 4: Run, expect PASS.** Run the same eslint and brand audit as Task 7.
- [ ] **Step 5: Commit** — `feat(ui): show images load in the image frame`.

### Task 9: Mobile card parity

**Files:**
- Modify: `apps/mobile/components/session/tool/tools/image-gen-tool.tsx`
- Modify: `apps/mobile/lib/session/tools/web-media.ts`. Import the view mapping from `@kortix/ui` if mobile can consume it; otherwise port `imageGenView` and reuse its tests.

- [ ] **Step 1: Port the four phases** (generating sheen with Reanimated, ready fade-in, failed with connect action, stopped). Follow `apps/mobile/design.md` (no borders, no descriptions) and `apps/mobile/AGENTS.md` primitives.
- [ ] **Step 2: Verify:** `pnpm --filter kortix exec tsc --noEmit` (the `apps/mobile` package is named `kortix`) and eslint on the changed files. Jay checks on his device (Expo Go, Android).
- [ ] **Step 3: Commit** — `feat(mobile): image generation card parity`.

### Task 10: User docs

**Files:**
- Modify: `apps/web/content/docs/project/tools.mdx` (add an `image_gen` row: what it does, ChatGPT requirement, opt-out via `agents.<name>.tools` or `permission`)
- Modify: `apps/web/content/docs/project/models.mdx` (a ChatGPT plan also generates images)
- Modify: `.agents/skills/learnings/work/image-generation/README.md` (this plan; set `status`)

- [ ] **Step 1: Write the doc changes.** Keep the voice in `.agents/skills/kortix-brand/SKILL.md`.
- [ ] **Step 2: Verify:** no test reads these docs; the docs build check runs at release. These pages are for people, never loaded into the agent's prompt.
- [ ] **Step 3: Commit** — `docs: image generation with a ChatGPT plan`.

### Task 11: Real-surface verification (local, then dev)

- [ ] **Step 1: Local gateway, real HTTP.** Start the worktree stack (`pnpm worktree start image-gen`). Mint a token as in `tests/e2e/helpers/session-auth.ts`, connect a ChatGPT account to a local project (Jay signs in once), then:
  `curl -s -X POST localhost:<api>/v1/llm/images/generations -H "Authorization: Bearer $T" -d '{"model":"codex/gpt-image-2","prompt":"a red cube on white","size":"1024x1024"}' | jq '.data[0].b64_json | length'`
  Expected: a number > 10,000. Negative check: a project with no ChatGPT → `400`, `.code == "provider_not_connected"`.
- [ ] **Step 2: Real pi session.** Create a session, then send "Generate an image of a paper-cutout astronaut flying from Earth to the Moon." Assert through `GET /v1/p/<ext>/8000/kortix/runtime/messages/<runtime_session_id>`:
  - one `image_gen` part, `status: completed`, `input.action == "generate"`;
  - output `path` under `/workspace/output/images/`;
  - if the model also called `show` for that path, the UI rendered it once (Task 8).
  Then read the file through the files API: the first 8 bytes are the PNG magic.
- [ ] **Step 3: Codemode-only session.** Repeat step 2 with `KORTIX_PI_CODEMODE=only`. The `image_gen` part is still native.
- [ ] **Step 4: Stop mid-generation.** The part ends aborted and no file exists.
- [ ] **Step 5: Hand Jay the visual check** (web light and dark themes, desktop at 720 × 480, mobile): generating state, ready, failed (disconnected project), stopped.
- [ ] **Step 6: PR, merge, dev.** Open the PR with the **create-pr** skill. Ask Jay before merging. Run `gh workflow run deploy-dev.yml --repo kortix-ai/suna -f surface=changed`. Confirm `/health` on api, gateway and sandbox image serves the merge SHA. Repeat steps 1–2 against `https://dev-api.kortix.com` with a new session (a kortixd change reaches new sessions only).
- [ ] **Step 7: Close the loop.**
  - Set the work folder `status` to the merge SHA.
  - Add a weekly changelog line.
  - Tell the team that `image_gen` loads by default (D3) and how to opt out.
  - Check the gateway image traces after 7 days: success rate and distinct projects.

---

## Phase 2 — universal image models (2026-10-28)

Jay: image generation is not ChatGPT-only. Any model that can generate images (Gemini image models, OpenAI `gpt-image-*` with an API key, xAI, OpenRouter image models, and Kortix-managed models when the lineup has one) goes through one shared tool and one shared card.

### Live probe (2026-10-28, dev keys, cheapest models)

| Protocol | Call | Status | Latency | Response |
|---|---|---|---|---|
| OpenAI Images | `api.openai.com/v1/images/generations`, `gpt-image-1-mini`, low | 200 | 9.2 s | `data[0].b64_json`, `output_format: png`, `size: 1024x1024`, `usage {input_tokens, output_tokens, *_details.image_tokens}` |
| OpenAI Images | `/v1/images/edits` JSON `images: [{image_url: data:…}]` | 200 | 8.8 s | same shape; edits work as JSON |
| Chat + image output | `openrouter.ai/api/v1/chat/completions`, `google/gemini-2.5-flash-image`, `modalities: ["image","text"]`, `image_config: {aspect_ratio: "3:2"}` | 200 | 6.5 s | `choices[0].message.images[0].image_url.url` = `data:image/png;base64,…`; `usage.cost` 0.0387 USD |
| Chat + image output | same, user content `[{type:text},{type:image_url}]` (edit) | 200 | 8.2 s | same |
| OpenAI Images (xAI) | `api.x.ai/v1/images/generations`, `grok-imagine-image`, `response_format: b64_json` | 200 | 6.1 s | `data[0].{b64_json, mime_type: image/jpeg}`; `usage.cost_in_usd_ticks` (1e10 ticks = 1 USD) |
| Gemini native | `generativelanguage.googleapis.com/v1beta/models/<m>:generateContent` | not probed | — | no Google key on this machine; contract from Google docs: `generationConfig.responseModalities: ["IMAGE"]`, `imageConfig.aspectRatio`, response `candidates[0].content.parts[].inlineData {mimeType, data}`, `usageMetadata` |

### Decisions (Phase 2)

- **U-D1 — One request contract, owned by Kortix, OpenAI-shaped.** `POST /images/generations` and `/images/edits` accept `{model, prompt, aspect_ratio?, quality?, background?, n?, images?}`. `model` is a Kortix model id (`codex/gpt-image-2`, `openai/gpt-image-1`, `google/gemini-2.5-flash-image`, `xai/grok-imagine-image`, `openrouter/google/gemini-2.5-flash-image`, a managed id) or `"auto"` / absent. The response is always `{created, model, provider, data: [{b64_json, mime_type}], size?, usage?}` whatever the upstream protocol, so the tool and any OpenAI-compatible client read one shape. `model` = the routed Kortix id that answered; `provider` = the public provider name.
- **U-D2 — The API owns which model answers.** The gateway sends `resolveRoute(principal, { requestedModel, requires: { imageInput, imageOutput: true } })`. The API returns a `ModelRoutePlan` (`policyId: 'image'`, primary + fallbacks, `fallbackOn: 'any-error'`):
  - explicit model: allowed only if the catalog says its output modalities include `image` (or it is `codex/gpt-image-2`); otherwise refuse `not_an_image_model`, naming up to 5 image models the project can use;
  - `auto`: the image models the project can reach right now, in this order: ChatGPT connection (`codex/gpt-image-2`) → each connected BYOK provider's preferred image model (`openai`, `google`, `openrouter`, `xai`, in that order; preference lists are constants, filtered by catalog presence) → managed lineup models with image output. Empty → `image_model_unavailable`.
- **U-D3 — Three protocol adapters in the gateway, chosen from the descriptor, never from the model name alone:**
  - `openai-images` — provider `openai-codex`, a genuine `api.openai.com` base, or `api.x.ai`. Sends `response_format: "b64_json"` except for `gpt-image*` / `chatgpt-image*` models (they reject it and always return base64). `aspect_ratio` maps to `size`: `1:1`→`1024x1024`; `3:2`, `4:3`, `16:9`→`1536x1024`; `2:3`, `3:4`, `9:16`→`1024x1536`; `auto`→`auto` (`size` omitted for xAI).
  - `gemini` — a `generativelanguage.googleapis.com` base (the catalog stores the OpenAI-compat base `…/v1beta/openai`; the adapter uses `…/v1beta`). API key in `x-goog-api-key`. `imageConfig.aspectRatio` unless `auto`. Edits send `inlineData` parts.
  - `chat-image` — every other OpenAI-compatible descriptor (OpenRouter, managed, custom). `modalities: ["image","text"]`, `image_config: {aspect_ratio}` unless `auto`; edits send `image_url` content parts.
  - Any other descriptor kind (Anthropic, Bedrock) → skip that candidate with `image_model_unsupported`.
- **U-D4 — Billing reuses the chat pipeline.** Each answered call records one `UsageEvent` through `hooks.recordUsage`, so ChatGPT plans (`billingMode: none`) cost nothing, BYOK gets the existing BYOK treatment, and managed is charged. Upstream cost: the provider's own figure when it sends one (`usage.cost` from OpenRouter, `cost_in_usd_ticks / 1e10` from xAI), else tokens × `descriptor.pricing`. A managed candidate with neither is skipped (`image_model_unpriced`): Kortix never serves a managed image it cannot charge. Managed candidates take the same billing admission/hold as chat; BYOK and ChatGPT never touch the wallet.
- **U-D5 — The tool is model-neutral.** New params `model?` and `aspect_ratio?` (`auto`, `1:1`, `3:2`, `2:3`, `16:9`, `9:16`, `4:3`, `3:4`); `size` is removed. The image is saved with the extension of its mime type (`png`, `jpeg`→`jpg`, `webp`); `output_name` is a base name (`[a-z0-9._-]{1,80}`, any given image extension is replaced). Output `{path, action, model, provider, size}`, where `size` is read from the saved image's header (`WxH`). Description stays factual (no behavioral hints).
- **U-D6 — The card is provider-neutral.** The placeholder ratio comes from `input.aspect_ratio` (legacy `input.size` still read). The ready card shows the model that made the image. Failed codes `image_model_unavailable`, `provider_not_connected`, `provider_reauth_required` show one generic action that opens the project's model/provider settings (web); mobile shows the message (R13). The SDK field `connectChatGpt` becomes `connectModel` (unpublished branch: no compatibility shim).
- **U-D7 — Error codes added:** `image_model_unavailable` (no image model reachable; suggestion: "Connect ChatGPT, or add an OpenAI, Google, xAI or OpenRouter key in project settings."), `not_an_image_model`, `image_model_unpriced`. Existing: `image_model_unsupported`, `provider_not_connected`, `provider_reauth_required`, `image_rate_limited`. Rulings R6 (an image 429 never cools a login for chat) and R11 (trailing `[code]` in tool errors) still hold.

### Task 12: API image-model policy

**Files:** `apps/api/src/llm-gateway/routing/` (resolve-route and a new `image-models.ts`), `apps/api/src/llm-gateway/models/catalog-models.ts` (an `imageOutput` capability from `modalities.output`), `apps/api/src/llm-gateway/internal-routes.ts` (accept `requires.imageOutput` on the RPC), tests beside each.

**Interfaces:** Consumes `ModelRouteInput.requires.imageOutput?: boolean` (`packages/llm-gateway/src/domain/routing.ts`, already added). Produces the U-D2 plan and refusals as `GatewayResolutionError(code, message, suggestion)` the RPC already carries.

- [ ] Tests first: `auto with only a ChatGPT connection plans codex/gpt-image-2`; `auto with a Google key and a ChatGPT connection plans codex first, then google`; `auto with no image-capable credential refuses image_model_unavailable`; `an explicit text model refuses not_an_image_model and names available image models`; `an explicit catalog image model passes through as the primary`; `requires.imageOutput absent keeps chat routing unchanged` (regression). Run each file with `pnpm --filter kortix-api test <file>`.
- [ ] Implement; typecheck; `pnpm --filter kortix-api lint` rules (layering, no process.env, no console).

### Task 13: Gateway protocol adapters and billing

**Files:** `packages/llm-gateway/src/pipeline/images.ts` (+ new `pipeline/image-adapters.ts`), tests; `apps/llm-gateway/src/clients/api-client.ts` (send `requires.imageOutput`).

**Interfaces:** Consumes the U-D2 plan. Produces the U-D1 response. Keeps every Phase 1 guarantee: allowlisted fields, `n` forced to 1, abort, 300 s timeout, R6, R3 headers for ChatGPT, traces without prompt/image/token.

- [ ] Tests first (fake upstreams, one per protocol, shapes from the live probe table): `openai-images generate and edit`, `xAI gets response_format b64_json and no size`, `gemini native generate with aspect ratio and an edit with inlineData`, `chat-image reads message.images data URL`, `auto falls back to the next planned model when the first is not connected`, `anthropic descriptor is skipped as image_model_unsupported`, `managed without a price is skipped as image_model_unpriced`, `usage event per answered call: ChatGPT none, BYOK byok, OpenRouter cost taken from usage.cost, xAI cost from ticks`, `response is normalized to {created, model, provider, data[{b64_json, mime_type}]}`.
- [ ] Implement; package typecheck.

### Task 14: Model-neutral `image_gen` tool

**Files:** `apps/kortix-sandbox-agent-server/src/services/tools/kortix/image_gen.ts`, `src/__tests__/kortix-tools.test.ts`, regenerated CLI snapshot.

- [ ] Tests first: `model and aspect_ratio are forwarded; absent model sends auto`; `a jpeg answer is saved as .jpg and size is read from the image header`; `output_name replaces a given extension`; `the output names the model and provider that answered`; all Phase 1 security tests stay green.
- [ ] Implement per U-D5; regenerate `apps/cli/src/kortix-tools.generated.json`.

### Task 15: Provider-neutral card (SDK, web, mobile)

**Files:** `packages/sdk/src/core/turns/tools/image-gen-view.ts` (+ test, snapshots, CHANGELOG), `packages/ui/src/session/tool/tools/image-gen-tool.tsx` (+ tests), `apps/mobile/components/session/tool/tools/image-gen-tool.tsx` (+ tests), i18n catalogs (web 9, mobile 8).

- [ ] Tests first: `aspect_ratio 16:9 gives a 16 / 9 placeholder`, `legacy size still works`, `image_model_unavailable maps to connectModel`, `the ready view exposes the model`.
- [ ] Implement per U-D6. Web action opens the project's model/provider settings through the existing navigation used by the model picker's connect actions. Brand audit, eslint, both typechecks, mobile tsc.

### Task 16: Docs, plan, PR

- [ ] `apps/web/content/docs/project/tools.mdx` and `models.mdx`: image generation works with any connected image model; list the providers and the auto order; limits unchanged. SDK reference for the renamed field.
- [ ] Update the PR body (#10990) to the universal scope.
