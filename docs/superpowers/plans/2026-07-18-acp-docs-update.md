# ACP Docs Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `apps/web/content/docs` fully in line with the shipped ACP-native multi-harness runtime (PR #4510): kill all OpenCode-as-sole-runtime residue, make kortix.yaml v3 the primary manifest, and add the missing reference surface (harnesses, ACP bridge, ACP SDK primitives, v2→v3 migration).

**Architecture:** Docs are fumadocs MDX under `apps/web/content/docs` (config `apps/web/source.config.ts`, `dir: 'content/docs'`). Two new reference pages (`harnesses`, `acp-bridge`) and one new SDK page (`acp`) get added; twelve existing pages get surgical edits; `reference/manifest.mdx` gets restructured to v3-primary. Every fact below was verified in code on branch `acp-harness-runtime-v2` on 2026-07-18 — treat this plan as the fact source, and when in doubt re-verify against the cited file.

**Tech Stack:** fumadocs MDX (frontmatter `title`/`description`, `<Callout>`, `<Cards>`/`<Card>` as already used by existing pages), pnpm, bun test.

## Global Constraints

- Work happens on branch `acp-harness-runtime-v2` in `/Users/jay/root/kortix/suna-acp` (the PR branch). Do NOT create a worktree; the docs must land in PR #4510's branch or a follow-up on top of it.
- Docs live at `apps/web/content/docs` — NOT the suna-docs worktree, NOT `docs/`.
- Voice: match existing pages — short declarative prose, second person sparingly, tables for enumerable facts, `<Callout type="info" title="...">` for legacy notes. Copy card markup patterns from the existing `index.mdx` files verbatim when adding cards.
- MDX compile gate after every task: `cd /Users/jay/root/kortix/suna-acp/apps/web && pnpm exec fumadocs-mdx` (fails on invalid MDX; regenerates `.source/`). Never commit `.source/` changes unless the repo already tracks them (check `git status` — if `.source` shows as modified-tracked, include it; if untracked/ignored, leave it).
- Harness facts (single source of truth `packages/shared/src/harnesses.ts`): ids `claude`, `codex`, `opencode`, `pi`; labels "Claude Code", "Codex", "OpenCode", "Pi"; config dirs `.claude`, `.codex`, `.kortix/opencode`, `.pi`; adapters `@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`, `opencode-ai` (native `opencode acp`), `pi-acp`; stability: **opencode = stable, claude/codex/pi = experimental**.
- Feature gates are per-project **experimental feature keys** (registry `ExperimentalFeatureMapSchema` in `packages/api-contract/src/index.ts`): `experimental_harnesses` (gates selecting/starting claude/codex/pi, default OFF) and `unified_model_picker` (model-first picker, default OFF). Never call them "feature flags of the SDK".
- v2→v3 migration is real but API-only: `migrateManifestV2ToV3` in `apps/api/src/projects/lib/agent-config-v2.ts`, exposed as `POST /{projectId}/runtime-profiles/enable`. There is **no `kortix migrate` CLI command** — never document one. Guide source: `packages/manifest-schema/README.md` § "v2 → v3 migration".
- Docs pages never mention internal file paths of the monorepo (existing pages don't); cite env vars, routes, commands, and public package names only.
- Do not invent UI copy: the Runtime section is Customize → Build → "Runtime" at `/projects/[id]/customize/runtime`, rows show harness label + Experimental/connection badges, "Connect" opens the connect-model modal, "Advanced" hides manifest keys.
- No AI attribution in commits (per user CLAUDE.md). Commit messages follow repo style: `docs(web): ...`.

---

## Verified fact pack (used by multiple tasks)

**ACP bridge** (`apps/kortix-sandbox-agent-server/src/routes/acp.ts`, `src/acp/runtime.ts`, `src/acp/harness-registry.ts`), mounted under `/acp` on the in-sandbox daemon, all routes behind the signed `X-Kortix-User-Context` HMAC gate:

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/acp/` | List live ACP servers |
| `POST` | `/acp/:serverId` | One unmodified JSON-RPC 2.0 envelope per request. First POST for a new `serverId` must carry `?agent=<harnessId>` and lazily spawns exactly one harness process. Responses: `200` JSON for request/response, `202` empty for notifications and client→agent responses, `409` if the `serverId` already runs a different harness, `415` wrong content type, `400` unknown `agent` or malformed envelope, `502` upstream process error |
| `GET` | `/acp/:serverId` | SSE stream of agent-originated envelopes (`id: <n>` + `data: <json>`); `Last-Event-ID` header replays buffered events after that sequence; `404` unknown server, `406` if Accept excludes `text/event-stream`, `400` bad Last-Event-ID; keepalive comment every 15s |
| `DELETE` | `/acp/:serverId` | Terminates the harness process; idempotent `204` |

Overrides (testing/rollout): `KORTIX_ACP_<HARNESS>_PATH` replaces the launch command, `KORTIX_ACP_<HARNESS>_ARGS` is a **JSON string array** (never shell-parsed), for `CLAUDE`, `CODEX`, `OPENCODE`, `PI`. Adapters are baked pinned into the sandbox image; requests never install anything.

**Auth env by kind** (`AUTH_ENV_BY_KIND`, harness-registry.ts): `anthropic_api_key → ANTHROPIC_API_KEY`; `openai_api_key → OPENAI_API_KEY` / `CODEX_API_KEY`; `claude_subscription → CLAUDE_CODE_OAUTH_TOKEN`; `openai_compatible`/`anthropic_compatible → CUSTOM_LLM_*`. OpenCode also supports the managed gateway (`managed_gateway`).

**Persistence** (`packages/db/drizzle/20260712120000_acp_session_envelopes.sql`): table `kortix.acp_session_envelopes` — append-only ordered log of raw JSON-RPC envelopes; columns `ordinal` (identity PK), `event_id`, `session_id`, `project_id`, `runtime_id`, `direction` (`client_to_agent` | `agent_to_client`), `stream_event_id`, `envelope` (jsonb), `created_at`. Transcripts (markdown/HTML/JSONL) are projections of this log. Three-part identity: the durable Kortix **session id**, the **runtime id** (current sandbox allocation), and the harness-native **ACP session id** (from `session/new` / `session/load`) — never collapsed.

**SDK ACP surface** (`packages/sdk`, root export + `@kortix/sdk/acp`):
- `AcpClient` (`createAcpClient`) — two modes: `{ endpoint }` (session-scoped API proxy, harness resolved server-side) or `{ baseUrl, serverId, agent?, fetch? }` (direct daemon bridge). Methods: `initialize`, `newSession`, `loadSession`, `prompt`, `cancel`, `request`, `notify`, `respond`, `setSessionConfigOption`, `connect()` (SSE), `transcript()`. `streamTransport: 'auto' | 'sse' | 'poll'`.
- `AcpSession` (`createAcpSession`) — framework-free store: `connect`, `subscribe`, `getSnapshot`, `send`, `cancel`, `respondPermission`, `respondQuestion`, `rejectQuestion`, `setConfigOption`. Snapshot fields: `envelopes, chatItems, pendingPrompts, usage, turnState, connection, ready, busy, error, acpSessionId, configOptions, capabilities, agentInfo, authMethods`.
- Projections: `projectAcpChatItems`, `projectAcpTranscript`, `projectAcpUsage`, `projectAcpTurnState`, `projectAcpPendingPrompts`, `acpTranscriptMarkdown`, `acpTranscriptHtml`, `acpTranscriptJsonl`.
- React: `useSession(projectId, sessionId, options?)` (ACP under the hood), `useAcpSession({ projectId, sessionId, runtimeSessionId?, enabled?, replayStartStash? })`, `useModelPicker({ projectId, agentName, connectionId?, liveSession? })`, `usePermissionPolicy(projectId)` (deny-by-default policy, persisted per project via `GET/PUT /:projectId/acp/permission-policy`).
- Runnable example: `packages/sdk/examples/09-acp-bridge.ts` (initialize → newSession → SSE connect → prompt → answer `session/request_permission` → cancel).
- Deprecated: the OpenCode-wire projection stack — `formatTranscript` / `MessageWithParts` (`@kortix/sdk` `transcript` exports), `narrowChatEvent` event union, `classifyTurn`/`classifyPart` turn helpers. All `@deprecated`, superseded by the ACP envelope reducer + `projectAcpChatItems` + `acpTranscript*`.

**Manifest v3** (`packages/manifest-schema/src/index.v3.ts`): top-level `kortix_version: 3`, required `default_agent`, required non-empty `runtimes:` and `agents:` maps, optional `project/env/sandbox/triggers/connectors/apps`. `runtimes.<name>`: `harness` (one of the four ids, required) + optional repo-relative `config_dir`; **any other key is a hard error**. `agents.<name>`: required `runtime` (must reference a declared runtime), optional `agent` (harness-native profile id), `enabled`, `connectors`/`secrets`/`skills`/`kortix_cli` (grant sets: `all` | `none` | list, **omitted = none**), `workspace` (`runtime`|`read`|`branch`); any other key is a hard error ("Prompts, models, providers, modes, and permissions belong to the native harness config"). v1/v2 remain fully accepted; v2/v3 must be YAML (TOML rejected for version ≥ 2). Migration: `POST /{projectId}/runtime-profiles/enable` losslessly promotes v2 (every v2 agent gets `runtime: 'opencode'` + `agent: <its name>`, the four default runtime profiles are injected, legacy `opencode:` key dropped) — opt-in, no-op if already v3.

**Starter** (`packages/starter/templates/base/kortix.yaml`): `kortix init` scaffolds a **v3** manifest declaring all four runtimes plus `.claude/CLAUDE.md`, `.codex/AGENTS.md`, `.pi/README.md`, `.kortix/opencode/opencode.jsonc`; `default_agent: kortix` on the `opencode` runtime.

---

### Task 1: New reference page — `reference/harnesses.mdx`

**Files:**
- Create: `apps/web/content/docs/reference/harnesses.mdx`
- Modify: `apps/web/content/docs/reference/meta.json` (add `harnesses` after `session-runtime`)
- Modify: `apps/web/content/docs/reference/index.mdx` (add a card for the page, matching existing card markup)

**Interfaces:**
- Produces: page URL `/docs/reference/harnesses` — later tasks link to it with exactly this href.

- [ ] **Step 1: Read the two neighbor pages for voice and card markup**

Read `apps/web/content/docs/reference/config-boundary.mdx` and `apps/web/content/docs/reference/index.mdx` in full. Note the exact `<Card>` component/props used by `reference/index.mdx` — reuse them verbatim in Step 3.

- [ ] **Step 2: Create the page**

Write `apps/web/content/docs/reference/harnesses.mdx`:

```mdx
---
title: Harnesses
description: The coding-agent harnesses Kortix can run — Claude Code, Codex, OpenCode, and Pi — their stability, authentication, and how to switch.
---

Kortix talks to every coding-agent harness over one protocol: the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). A harness is
the agent runtime that executes inside the session sandbox — OpenCode, Claude
Code, Codex, or Pi. The platform, the session UI, and the SDK never speak a
harness-specific API; they speak ACP to whichever harness the agent's runtime
profile selects.

## Supported harnesses

| Harness | Manifest `harness` value | Default `config_dir` | ACP process | Stability |
| --- | --- | --- | --- | --- |
| OpenCode | `opencode` | `.kortix/opencode` | `opencode acp` (native) | Stable |
| Claude Code | `claude` | `.claude` | `@agentclientprotocol/claude-agent-acp` | Experimental |
| Codex | `codex` | `.codex` | `@agentclientprotocol/codex-acp` | Experimental |
| Pi | `pi` | `.pi` | `pi-acp` | Experimental |

OpenCode is the default and the only stable harness today. Claude Code, Codex,
and Pi ship behind the per-project `experimental_harnesses` experimental
feature, which is **off by default** — with it off, sessions cannot select or
start an experimental harness. The Claude Code and Codex processes are official
adapters maintained in the Agent Client Protocol organization; they are baked
into the sandbox image at pinned versions, never installed at request time.

## Choosing a harness

A logical agent picks its harness through its runtime profile in `kortix.yaml`:

```yaml
kortix_version: 3
default_agent: kortix

runtimes:
  opencode:
    harness: opencode
    config_dir: .kortix/opencode
  claude:
    harness: claude
    config_dir: .claude

agents:
  kortix:
    runtime: opencode
    skills: all
  reviewer:
    runtime: claude
    agent: reviewer
```

The optional `agent:` field names a harness-native agent/profile; omitting it
selects the harness's own default. Kortix compiles this to a launch plan — it
never translates prompts, models, providers, or permissions between harnesses.
Native behavior lives in each harness's normal config directory
(see [Kortix vs runtime config](/docs/reference/config-boundary)).

In the dashboard, the same choice lives in **Customize → Runtime**: one row per
runtime profile with its connection state, a **Connect** action for harnesses
that aren't set up yet, and an **Advanced** view for the underlying manifest
keys.

## Authentication

Harness model credentials are provided as session environment, sourced from
[project secrets](/docs/concepts/secrets):

| Harness | Accepted credentials |
| --- | --- |
| OpenCode | Kortix managed gateway (default), `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or an OpenAI-compatible custom endpoint |
| Claude Code | `ANTHROPIC_API_KEY`, or a Claude subscription token (`CLAUDE_CODE_OAUTH_TOKEN`) |
| Codex | `OPENAI_API_KEY` / `CODEX_API_KEY`, or a Codex subscription login |
| Pi | Managed gateway, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or an OpenAI-compatible custom endpoint |

Subscription credentials are user-scoped: they are never committed, never
copied into project configuration, and never shared across users.

## Model selection

OpenCode routes models through the Kortix gateway (gateway-prefixed model ids)
and supports changing model mid-session. Claude Code, Codex, and Pi own their
default model natively (bare model ids) and apply model changes at session
launch. The session composer's model picker is harness-aware; the unified
model-first picker ships behind the `unified_model_picker` experimental
feature (off by default).

<Callout type="info" title="Overriding the ACP process">
For controlled rollouts and testing, the sandbox daemon honors
`KORTIX_ACP_<HARNESS>_PATH` (replacement launch command) and
`KORTIX_ACP_<HARNESS>_ARGS` (a JSON string array, never shell-parsed) for
`CLAUDE`, `CODEX`, `OPENCODE`, and `PI`.
</Callout>
```

- [ ] **Step 3: Wire the nav**

In `apps/web/content/docs/reference/meta.json`, insert `"harnesses"` immediately after `"session-runtime"` in the `pages` array. In `apps/web/content/docs/reference/index.mdx`, add a card (copying the existing card markup style) titled **Harnesses**, href `/docs/reference/harnesses`, description "Supported ACP harnesses, stability tiers, authentication, and model selection."

- [ ] **Step 4: Verify**

Run: `cd /Users/jay/root/kortix/suna-acp/apps/web && pnpm exec fumadocs-mdx`
Expected: exits 0.
Run: `grep -c "experimental_harnesses" content/docs/reference/harnesses.mdx`
Expected: ≥ 1.

- [ ] **Step 5: Commit**

```bash
git add apps/web/content/docs/reference/harnesses.mdx apps/web/content/docs/reference/meta.json apps/web/content/docs/reference/index.mdx
git commit -m "docs(web): add harnesses reference page"
```

---

### Task 2: New reference page — `reference/acp-bridge.mdx`

**Files:**
- Create: `apps/web/content/docs/reference/acp-bridge.mdx`
- Modify: `apps/web/content/docs/reference/meta.json` (add `acp-bridge` after `harnesses`)
- Modify: `apps/web/content/docs/reference/index.mdx` (add card)

**Interfaces:**
- Consumes: `/docs/reference/harnesses` (Task 1) for the harness link.
- Produces: page URL `/docs/reference/acp-bridge` — Tasks 4 and 7 link to it.

- [ ] **Step 1: Create the page**

Write `apps/web/content/docs/reference/acp-bridge.mdx` using the ACP bridge table and override envs from the Verified fact pack, structured as:

```mdx
---
title: ACP bridge
description: The in-sandbox daemon's raw ACP endpoint — routes, JSON-RPC semantics, SSE replay, status codes, and process lifecycle.
---

Every session sandbox runs the Kortix daemon, and the daemon exposes a raw
[Agent Client Protocol](https://agentclientprotocol.com) bridge under `/acp`.
The bridge relays unmodified JSON-RPC 2.0 envelopes between clients and one
harness process per server id — it does not translate, filter, or re-shape the
protocol. All `/acp` routes require the signed `X-Kortix-User-Context` header;
most integrations should use `@kortix/sdk`'s
[ACP surface](/docs/sdk/acp) instead of calling the bridge directly.

## Routes
```

then the four-row route table exactly as in the fact pack, then sections:

- **Process lifecycle** — first `POST /acp/:serverId?agent=<harness>` lazily starts exactly one pinned ACP process for that server id; later requests reuse it; a different `agent` for an existing id returns `409`; `DELETE` terminates the process and is idempotent. A write queue serializes stdin writes but not request lifetimes — a long `session/prompt` never blocks answering an agent-originated permission request.
- **Streaming and replay** — SSE frame format (`id:` sequence + `data:` envelope), 15-second keepalive comments, `Last-Event-ID` replays buffered events after the given sequence; the in-sandbox buffer is bounded — durable history lives in the platform's [envelope log](/docs/reference/session-runtime).
- **Environment** — harness processes inherit only the sandbox environment plus the filtered project-secret snapshot; the `KORTIX_ACP_<HARNESS>_PATH`/`_ARGS` override callout (same text as the Task 1 callout, linking to [Harnesses](/docs/reference/harnesses)).

Write out every section in full prose matching the fact pack — no facts beyond it.

- [ ] **Step 2: Wire the nav**

Add `"acp-bridge"` after `"harnesses"` in `reference/meta.json`; add a card in `reference/index.mdx` titled **ACP bridge**, href `/docs/reference/acp-bridge`, description "The raw in-sandbox ACP endpoint — routes, SSE replay, and process lifecycle."

- [ ] **Step 3: Verify**

Run: `cd /Users/jay/root/kortix/suna-acp/apps/web && pnpm exec fumadocs-mdx`
Expected: exits 0.
Run: `grep -c "Last-Event-ID" content/docs/reference/acp-bridge.mdx`
Expected: ≥ 2.

- [ ] **Step 4: Commit**

```bash
git add apps/web/content/docs/reference/acp-bridge.mdx apps/web/content/docs/reference/meta.json apps/web/content/docs/reference/index.mdx
git commit -m "docs(web): add ACP bridge reference page"
```

---

### Task 3: Restructure `reference/manifest.mdx` to v3-primary

**Files:**
- Modify: `apps/web/content/docs/reference/manifest.mdx` (whole-page restructure)

**Interfaces:**
- Consumes: `/docs/reference/harnesses` (Task 1).
- Produces: anchors `#runtimes-v3`, `#agents-v3`, `#v2-v3-migration` — Task 5 links to `#v2-v3-migration`.

- [ ] **Step 1: Read the current page fully**

Read `apps/web/content/docs/reference/manifest.mdx`. Current shape (headings verified 2026-07-18): "Full example (v2, kortix.yaml)" → "Legacy example (v1, kortix.toml)" → "Schema version" → "`runtime:` (v2 only)" → "What's parsed where" → per-table sections → "Runtime config" (already has a v3 `runtimes:` subsection + "Legacy `opencode:`") → "`agents:` (v2)" → "`[[agents]]` (v1, legacy)" → "Round-trip rules".

- [ ] **Step 2: Restructure to v3-primary**

Make these changes, preserving all v2/v1 content as clearly-labeled legacy sections:

1. Frontmatter description → `The project manifest — every table, field, default, and validation rule, for kortix.yaml v3 (current), v2, and legacy kortix.toml (v1).`
2. New headline section **"Full example (v3, `kortix.yaml`)"** placed first, containing a complete v3 example — use the starter template shape:

```yaml
# yaml-language-server: $schema=https://kortix.com/schema/kortix.v3.schema.json
kortix_version: 3
default_agent: kortix

runtimes:
  opencode:
    harness: opencode
    config_dir: .kortix/opencode
  claude:
    harness: claude
    config_dir: .claude
  codex:
    harness: codex
    config_dir: .codex
  pi:
    harness: pi
    config_dir: .pi

agents:
  kortix:
    runtime: opencode
    skills: all
    connectors: all
    secrets: all
  reviewer:
    runtime: codex
    agent: reviewer
    skills: [code-review]
    connectors: [github]
```

Before adding the `$schema` comment line, verify a v3 JSON schema is actually published: `ls /Users/jay/root/kortix/suna-acp/packages/manifest-schema/*.json apps/web/public/schema 2>/dev/null` and grep for `kortix.v3.schema.json` in the repo. If none exists, omit the comment line and do not mention a v3 schema URL anywhere.
3. Retitle the old v2 example section to **"v2 example (`kortix.yaml`, legacy)"** and move it after the v3 sections, before the v1 section.
4. In **"Schema version"**: state v3 is current; v2 and v1 remain fully accepted and validated; v2/v3 must be YAML (TOML is rejected for version ≥ 2).
5. New section **"`runtimes:` (v3)"** `[#runtimes-v3]`: map of named runtime profiles; per-entry fields table — `harness` (required, one of `claude`/`codex`/`opencode`/`pi`, see [Harnesses](/docs/reference/harnesses)) and `config_dir` (optional, repo-relative, must stay inside the repo — no leading `/`, no `..`); profile names match `^[a-z0-9][a-z0-9_-]{0,127}$`; **any other field is a hard error** — native behavior belongs in the harness config directory.
6. New section **"`agents:` (v3)"** `[#agents-v3]`: per-entry fields table — `runtime` (required, must reference a declared runtime), `agent` (optional harness-native agent/profile id; omitted = harness default), `enabled` (default true; `default_agent` cannot be disabled), `connectors`/`secrets`/`skills`/`kortix_cli` (grant sets `all` | `none` | list; **omitted = none** — v3 is deny-by-default), `workspace` (`runtime` | `read` | `branch`); any other key is a hard error, quoting the validator: "Prompts, models, providers, modes, and permissions belong to the native harness config."
7. Retitle the existing "`agents:` (v2)" section to make its legacy status explicit and keep it.
8. Demote the existing "Runtime config" v3 subsection — its content is now covered by "`runtimes:` (v3)"; keep "Legacy `opencode:` / `[opencode]`" as a legacy subsection and note the v3 validator **rejects** top-level `opencode:` and singular `runtime:`.
9. Update the "What's parsed where" table: session/trigger launch reads `runtimes.<name>.harness` + `config_dir` to select and boot the ACP process; session token mint reads `agents.<name>` grants.
10. New section **"v2 → v3 migration"** `[#v2-v3-migration]`:

```mdx
## v2 → v3 migration [#v2-v3-migration]

Migration is opt-in and lossless, performed by the platform (there is no CLI
command for it): `POST /{projectId}/runtime-profiles/enable` promotes a v2
manifest to v3 and commits the result to the project's default branch. It
no-ops if the project is already on v3. The promotion:

- keeps every v2 agent's governance untouched, adding `runtime: opencode` and
  `agent: <its own name>` — existing agents keep running exactly as before;
- declares all four runtime profiles (`opencode`, `claude`, `codex`, `pi`)
  so every official harness becomes selectable;
- drops the legacy top-level `opencode:` key. The `opencode` runtime profile
  uses the default `.kortix/opencode` — a customized legacy `config_dir` is
  not carried over (the migrator injects the fixed defaults; verified in
  `apps/api/src/projects/lib/agent-config-v2.ts`);
- sets `kortix_version: 3` and re-validates before writing — a validation
  error aborts the migration instead of committing a broken manifest.

Native harness files are never touched.
```

11. Sweep the rest of the page: any remaining sentence claiming "the only legal value is `opencode`" for runtime, or that v2 is "the current version", gets updated to the v3 model.

- [ ] **Step 3: Verify**

Run: `cd /Users/jay/root/kortix/suna-acp/apps/web && pnpm exec fumadocs-mdx`
Expected: exits 0.
Run: `grep -n "only legal value" content/docs/reference/manifest.mdx`
Expected: no output (or only inside a clearly v2-labeled legacy section).
Run: `grep -c "kortix_version: 3" content/docs/reference/manifest.mdx`
Expected: ≥ 2.

- [ ] **Step 4: Commit**

```bash
git add apps/web/content/docs/reference/manifest.mdx
git commit -m "docs(web): make manifest reference v3-primary with v2/v1 legacy sections"
```

---

### Task 4: `reference/session-runtime.mdx` — full bridge surface, envelope durability, session identity

**Files:**
- Modify: `apps/web/content/docs/reference/session-runtime.mdx`

**Interfaces:**
- Consumes: `/docs/reference/acp-bridge` (Task 2).

- [ ] **Step 1: Read the page; apply three edits**

1. **Bridge rows:** the daemon control-surface table currently lists only `POST /acp/:serverId?agent=<harness>`. Replace that single row with the four routes (`GET /acp/`, `POST /acp/:serverId`, `GET /acp/:serverId` SSE, `DELETE /acp/:serverId`) in one-line summaries, each pointing to the new page: "full contract in [ACP bridge](/docs/reference/acp-bridge)". Note the `X-Kortix-User-Context` gate applies to all of them.
2. **New section "Durable transcript"** (after the daemon section):

```mdx
## Durable transcript

The source of truth for a session's conversation is an append-only ordered log
of raw ACP envelopes, stored by the platform per session with direction
(client-to-agent or agent-to-client), stream sequence, and timestamps. The
sandbox's own SSE buffer is bounded and disposable; history survives sandbox
replacement because the platform persists every envelope. Markdown, HTML, and
JSONL transcripts are projections of this log — JSONL is the lossless export.
```

3. **New section "Session identity"** (adjacent to the status/branch model sections):

```mdx
## Session identity

Three identifiers stay distinct for every running session:

- the **Kortix session id** — durable, survives sandbox replacement;
- the **runtime id** — the current sandbox allocation, replaced on restart;
- the **ACP session id** — the harness-native session returned by ACP
  `session/new` (or selected by `session/load`), scoped to one harness process.

The envelope log keys on all three, which is how a session's history stays
continuous across sandbox restarts and harness process replacements.
```

- [ ] **Step 2: Verify**

Run: `cd /Users/jay/root/kortix/suna-acp/apps/web && pnpm exec fumadocs-mdx`
Expected: exits 0.
Run: `grep -c "acp-bridge" content/docs/reference/session-runtime.mdx`
Expected: ≥ 1.

- [ ] **Step 3: Commit**

```bash
git add apps/web/content/docs/reference/session-runtime.mdx
git commit -m "docs(web): document full ACP bridge surface, envelope log, and session identity in session-runtime"
```

---

### Task 5: Concepts sweep — root `index.mdx`, `concepts/index.mdx`, `concepts/projects.mdx`, `concepts/sessions.mdx`, `concepts/agents.mdx`

**Files:**
- Modify: `apps/web/content/docs/index.mdx`
- Modify: `apps/web/content/docs/concepts/index.mdx`
- Modify: `apps/web/content/docs/concepts/projects.mdx`
- Modify: `apps/web/content/docs/concepts/sessions.mdx`
- Modify: `apps/web/content/docs/concepts/agents.mdx`

**Interfaces:**
- Consumes: `/docs/reference/harnesses` (Task 1), `/docs/reference/manifest#v2-v3-migration` (Task 3).

- [ ] **Step 1: `index.mdx`** — in the ASCII flow diagram, change the line `agent (OpenCode) commits + pushes` to `agent (ACP harness) commits + pushes` (keep diagram alignment/width intact — pad with spaces to preserve box drawing).

- [ ] **Step 2: `concepts/index.mdx`** — two edits:
1. Pieces list: replace the OpenCode-only "Agents" bullet ("Agents — OpenCode, governed by the manifest's `agents:` map and implemented through `.kortix/opencode/`") with: `**Agents** — logical entries in kortix.yaml that route to an ACP harness runtime (OpenCode by default; Claude Code, Codex, and Pi selectable), governed by the manifest's agents: map.` Link "ACP harness" to `/docs/reference/harnesses`.
2. Session-start sequence step 3: replace "launches OpenCode" with "launches the agent's selected ACP harness process".
3. Extend the legacy callout that currently covers only `kortix_version: 1` to mention v2 is also legacy and v3 is current, linking to `/docs/reference/manifest#v2-v3-migration`.

- [ ] **Step 3: `concepts/projects.mdx`** — three edits:
1. "New projects get `kortix.yaml` (`kortix_version: 2`)" → `kortix_version: 3`; adjust surrounding prose so it says new projects scaffold v3 with all four runtime profiles declared.
2. The manifest-reads list item citing "`opencode.config_dir` — agent config location (default `.kortix/opencode`)" → `runtimes.<name>.config_dir — each runtime profile's harness config location (OpenCode defaults to .kortix/opencode)`.
3. Migration wording "Migrate manifest to v2" → cover v1→v2→v3, linking `/docs/reference/manifest#v2-v3-migration`.

- [ ] **Step 4: `concepts/sessions.mdx`** — three edits:
1. Every OpenCode-as-the-runtime mention ("runs OpenCode inside", "supervises OpenCode") → harness-neutral: the sandbox "runs the agent's selected ACP harness (OpenCode, Claude Code, Codex, or Pi)" and the daemon "supervises the harness process and bridges it over ACP". Link the first mention to `/docs/reference/harnesses`.
2. Add one short paragraph to the persistence section: the conversation is durably stored as an ordered log of raw ACP envelopes on the platform, so history survives sandbox replacement; transcripts are projections (link `/docs/reference/session-runtime`).
3. Where the page describes what identifies a session, add one sentence naming the three distinct identifiers (Kortix session id / runtime id / ACP session id) with a link to `/docs/reference/session-runtime`.

- [ ] **Step 5: `concepts/agents.mdx`** — one addition: after the paragraph saying the same session UI can drive the four harnesses, append: `OpenCode is the stable default; Claude Code, Codex, and Pi are experimental and gated behind the per-project experimental_harnesses feature (off by default). See [Harnesses](/docs/reference/harnesses).`

- [ ] **Step 6: Verify**

Run: `cd /Users/jay/root/kortix/suna-acp/apps/web && pnpm exec fumadocs-mdx`
Expected: exits 0.
Run: `grep -rn "agent (OpenCode)" content/docs/ ; grep -n "kortix_version: 2\`)" content/docs/concepts/projects.mdx`
Expected: no output from either.

- [ ] **Step 7: Commit**

```bash
git add apps/web/content/docs/index.mdx apps/web/content/docs/concepts
git commit -m "docs(web): make concepts pages harness-neutral and v3-aware"
```

---

### Task 6: `reference/sandbox-image.mdx` — multi-harness image

**Files:**
- Modify: `apps/web/content/docs/reference/sandbox-image.mdx`

**Interfaces:**
- Consumes: `/docs/reference/harnesses` (Task 1).

- [ ] **Step 1: Verify current image contents in code before writing**

The docs currently describe an OpenCode-only runtime layer. Before editing, confirm what the image actually installs now: `grep -rn "agentclientprotocol\|opencode-ai\|pi-acp" /Users/jay/root/kortix/suna-acp/apps/kortix-sandbox-agent-server /Users/jay/root/kortix/suna-acp/packages/sandbox* --include=Dockerfile* --include='*.ts' -l | head`, then read the Dockerfile(s) found. Document only what is actually baked (per the PR: pinned Claude/Codex adapters verified with a version/help probe, plus the pinned native OpenCode install).

- [ ] **Step 2: Apply edits**

1. Diagram line "opencode + kortix-agent + ENTRYPOINT" → name the runtime layer as "ACP harness adapters + kortix-agent + ENTRYPOINT".
2. Injection step "npm install -g opencode-ai@<pinned-version>" → a bullet list: pinned installs of the four ACP processes (`opencode-ai`, `@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`, `pi-acp`) matching whatever Step 1 found — each verified at image build with a version probe; **requests never install adapters** (no runtime `npx`).
3. "baked OpenCode tool-dependency cache" → keep, but scope it as OpenCode-specific.
4. Snapshot content-hash sentence: "opencode version + kortix-agent binary" → include the pinned adapter versions in the fingerprint wording **only if Step 1 confirms it**; otherwise describe the actual hash inputs found.
5. Add a closing sentence linking `/docs/reference/harnesses` for the adapter override env vars.

- [ ] **Step 3: Verify**

Run: `cd /Users/jay/root/kortix/suna-acp/apps/web && pnpm exec fumadocs-mdx`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/content/docs/reference/sandbox-image.mdx
git commit -m "docs(web): document multi-harness ACP adapters in sandbox image"
```

---

### Task 7: Reference residue — `reference/cli.mdx`, `reference/index.mdx`, `reference/secrets.mdx`

**Files:**
- Modify: `apps/web/content/docs/reference/cli.mdx`
- Modify: `apps/web/content/docs/reference/index.mdx`
- Modify: `apps/web/content/docs/reference/secrets.mdx`

- [ ] **Step 1: Verify CLI behavior in code first**

Read `apps/cli/src/commands/init.ts` (scaffolds from `@kortix/starter` — the v3 base template with all four runtimes; the init epilogue mentions "The default starter still includes an OpenCode harness profile at .kortix/opencode; add Claude/Codex native config as needed") and the `dev` command implementation (`grep -rn "OPENCODE_CONFIG_DIR\|dev" apps/cli/src/commands/*.ts | head`). Document only actual behavior.

- [ ] **Step 2: `reference/cli.mdx` edits**

1. `kortix init`: "scaffolds `kortix.yaml` (the v2 manifest)" → scaffolds the v3 starter manifest (all four runtime profiles declared: `.kortix/opencode`, `.claude`, `.codex`, `.pi`), matching Step 1 findings.
2. `kortix dev`: keep it accurate to Step 1 — if it still only drives OpenCode locally, keep the OpenCode description but add one sentence: "Local dev currently drives the OpenCode harness; in-sandbox sessions run whichever ACP harness the agent's runtime profile selects."
3. `kortix agents model` `[[agents]].model` reference: recheck against the actual command help; if the command now writes harness/model differently, update; otherwise mark the `[[agents]].model` phrasing as v1-legacy.

- [ ] **Step 3: `reference/index.mdx`** — manifest card copy "v2 (`kortix.yaml`) and legacy v1 (`kortix.toml`)" → "v3 (`kortix.yaml`), plus legacy v2 and v1 (`kortix.toml`)".

- [ ] **Step 4: `reference/secrets.mdx`** — rotation step "restarts the in-sandbox `opencode` process" → "restarts the in-sandbox harness process".

- [ ] **Step 5: Verify**

Run: `cd /Users/jay/root/kortix/suna-acp/apps/web && pnpm exec fumadocs-mdx`
Expected: exits 0.
Run: `grep -n "the v2 manifest" content/docs/reference/cli.mdx`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add apps/web/content/docs/reference/cli.mdx apps/web/content/docs/reference/index.mdx apps/web/content/docs/reference/secrets.mdx
git commit -m "docs(web): fix v3/harness residue in CLI, reference index, and secrets pages"
```

---

### Task 8: New SDK page — `sdk/acp.mdx`

**Files:**
- Create: `apps/web/content/docs/sdk/acp.mdx`
- Modify: `apps/web/content/docs/sdk/meta.json` (insert `acp` after `streaming`)
- Modify: `apps/web/content/docs/sdk/index.mdx` (add card)

**Interfaces:**
- Consumes: `/docs/reference/acp-bridge` (Task 2).
- Produces: page URL `/docs/sdk/acp` with anchors `#acpclient`, `#acpsession`, `#projections` — Task 9 links to them.

- [ ] **Step 1: Verify example snippets compile against the real SDK**

Read `packages/sdk/examples/09-acp-bridge.ts` and `packages/sdk/src/acp/client.ts` / `session.ts` exported types. Every snippet in Step 2 must use real names/signatures; adjust if the code differs.

- [ ] **Step 2: Create the page**

Write `apps/web/content/docs/sdk/acp.mdx` covering, in order (all facts from the Verified fact pack; snippets modeled on `examples/09-acp-bridge.ts`):

1. Intro: ACP is the canonical client protocol; most apps use `useSession` / the session facade (`send`/`abort`/`stream`) and never touch this layer; this page is the layer underneath.
2. **`AcpClient`** `[#acpclient]` — the two constructor modes with a code block each:

```ts
import { AcpClient } from '@kortix/sdk';

// Mode 1 — session-scoped API proxy (recommended):
const client = new AcpClient({ endpoint });

// Mode 2 — direct daemon bridge (self-managed sandboxes, tests):
const bridge = new AcpClient({ baseUrl, serverId: 'main', agent: 'codex', fetch: signedFetch });
```

then the method list (`initialize`, `newSession`, `loadSession`, `prompt`, `cancel`, `request`/`notify`/`respond`, `setSessionConfigOption`, `connect`, `transcript`) with one-line descriptions, and `streamTransport: 'auto' | 'sse' | 'poll'`.
3. A condensed end-to-end flow mirroring example 09: initialize → newSession → connect (SSE) → prompt → answer a `session/request_permission` via `respond` → await stop reason → cancel. Point at `packages/sdk/examples/09-acp-bridge.ts` as the runnable version.
4. **`AcpSession`** `[#acpsession]` — `createAcpSession(options)`, framework-free store: options, key methods (`connect`, `subscribe`, `getSnapshot`, `send`, `cancel`, `respondPermission`, `respondQuestion`, `rejectQuestion`, `setConfigOption`) and the snapshot fields list. Note `useSession`/`useAcpSession` are React bindings over this store.
5. **Projections** `[#projections]` — envelopes are the truth; `projectAcpChatItems` for chat UIs, `projectAcpUsage`/`projectAcpTurnState`/`projectAcpPendingPrompts`, and `acpTranscriptMarkdown`/`acpTranscriptHtml`/`acpTranscriptJsonl` for exports (JSONL = lossless).
6. `<Callout type="info" title="Deprecated: OpenCode-wire projections">` naming `formatTranscript`, `MessageWithParts`, `narrowChatEvent`, and `classifyTurn` as deprecated back-compat, superseded by this page's surface.

- [ ] **Step 3: Wire the nav** — insert `"acp"` after `"streaming"` in `sdk/meta.json`; add a card in `sdk/index.mdx` titled **ACP**, href `/docs/sdk/acp`, description "The ACP layer underneath the facade — AcpClient, the AcpSession store, and transcript projections."

- [ ] **Step 4: Verify**

Run: `cd /Users/jay/root/kortix/suna-acp/apps/web && pnpm exec fumadocs-mdx`
Expected: exits 0.
Run: `grep -c "createAcpSession\|AcpClient" content/docs/sdk/acp.mdx`
Expected: ≥ 4.

- [ ] **Step 5: Commit**

```bash
git add apps/web/content/docs/sdk/acp.mdx apps/web/content/docs/sdk/meta.json apps/web/content/docs/sdk/index.mdx
git commit -m "docs(web): add SDK ACP page (AcpClient, AcpSession, projections)"
```

---

### Task 9: SDK sweep — `streaming.mdx`, `full-example.mdx`, `turns.mdx`, `react.mdx`, `getting-started.mdx`, `the-client.mdx`, `modules.mdx`

**Files:**
- Modify: `apps/web/content/docs/sdk/streaming.mdx`
- Modify: `apps/web/content/docs/sdk/full-example.mdx`
- Modify: `apps/web/content/docs/sdk/turns.mdx`
- Modify: `apps/web/content/docs/sdk/react.mdx`
- Modify: `apps/web/content/docs/sdk/getting-started.mdx`
- Modify: `apps/web/content/docs/sdk/the-client.mdx`
- Modify: `apps/web/content/docs/sdk/modules.mdx`

**Interfaces:**
- Consumes: `/docs/sdk/acp` + anchors (Task 8).

- [ ] **Step 1: `sdk/streaming.mdx`** — reframe so the ACP path is primary:
1. Add, right after the intro, a short section "The canonical stream is ACP envelopes": the live stream is agent-originated ACP envelopes; the `AcpSession` store reduces them into `chatItems` and friends; link `/docs/sdk/acp#acpsession`.
2. Wrap the existing `narrowChatEvent` / event-union / `classifyTurn` material under a heading that marks it deprecated back-compat, opening with: "The event union below is the deprecated OpenCode-wire projection. It keeps existing consumers working; new code should consume ACP envelopes (see above)." Keep the material itself — it still documents a shipping deprecated surface.
3. Update the frontmatter description to lead with ACP (keep `narrowChatEvent` mentioned as legacy).

- [ ] **Step 2: `sdk/full-example.mdx`** — replace the streaming portion of the example: drop `narrowChatEvent` / `message.part.updated` / `session.idle` handling in favor of the session facade + ACP projections used by `react.mdx` (`s.acp.envelopes` shape on the hook, or the framework-free `createAcpSession` + `subscribe` + `projectAcpChatItems` for the no-React file). Model the replacement on the real example files in `packages/sdk/examples/` (read them first; prefer mirroring the current quickstart example there). End the page with a pointer to `packages/sdk/examples/09-acp-bridge.ts` for the raw-bridge variant.

- [ ] **Step 3: `sdk/turns.mdx`** — add immediately after the frontmatter:

```mdx
<Callout type="warn" title="Legacy projection layer">
Turn grouping and part classification operate on the deprecated OpenCode-wire
message shapes. They keep older UIs working, but the canonical chat-render
path is the ACP envelope reducer and `projectAcpChatItems` — see
[ACP](/docs/sdk/acp#projections).
</Callout>
```

(Check whether existing pages use `type="warn"` or `type="warning"`; match the codebase.) Also update the frontmatter description to append "(legacy OpenCode-wire projection)".

- [ ] **Step 4: `sdk/react.mdx`** — two small additions:
1. Where `useSession` is introduced, add: `useSession` is the batteries-included binding; the underlying pieces are exported too — `useAcpSession({ projectId, sessionId, runtimeSessionId? })` for the raw store binding, `useModelPicker({ projectId, agentName })` for the harness-aware model picker, and `usePermissionPolicy(projectId)` for the persistent, deny-by-default project permission policy.
2. Link `/docs/sdk/acp` from the section that mentions `s.acp`.

- [ ] **Step 5: `sdk/getting-started.mdx`** — next-links list: "Sessions — lifecycle, runtime health, previews, and the opencode runtime" → "…and the ACP agent transport". Check the React example against `react.mdx`'s current shape (`s.acp.envelopes` etc.); align if it uses stale `s.messages`/`s.send` shapes that no longer exist — verify against `packages/sdk/src/react/use-session.ts` return type before changing (if `s.send` still exists on `UseSessionResult`, leave it).

- [ ] **Step 6: `sdk/the-client.mdx`** — `p.setDefaultAgent` copy: "commits it as `default_agent` in the project's v2 `kortix.yaml`" → drop the version qualifier ("in the project's `kortix.yaml`").

- [ ] **Step 7: `sdk/modules.mdx`** — fix the quoted code comment "the runtime is up and OpenCode is ready" → "the runtime is up and the harness is ready" **only if the underlying SDK source comment changed** — check `grep -rn "OpenCode is ready" packages/sdk/src | head`; if the SDK comment still says OpenCode, leave the doc quote as-is and instead add "(OpenCode-era wording; applies to whichever harness the session runs)".

- [ ] **Step 8: Verify**

Run: `cd /Users/jay/root/kortix/suna-acp/apps/web && pnpm exec fumadocs-mdx`
Expected: exits 0.
Run: `grep -n "opencode runtime" content/docs/sdk/getting-started.mdx`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add apps/web/content/docs/sdk
git commit -m "docs(web): make SDK docs ACP-first, mark OpenCode-wire projections legacy"
```

---

### Task 10: Final sweep, link check, and full build

**Files:**
- Modify: any file failing the checks below.

- [ ] **Step 1: Residue grep across all docs**

Run from `apps/web/content/docs`:
```bash
grep -rn -i "opencode" . | grep -v -i "legacy\|deprecated\|v1\|harness\|\.kortix/opencode\|opencode acp\|opencode-ai\|OpenCode is the\|stable"
```
Read every hit in context; any remaining claim that OpenCode is *the* runtime (rather than one harness / the stable default / a legacy surface) gets fixed with the harness-neutral phrasing from Tasks 5–9. Trigger/change-request pages mentioning `.kortix/opencode` paths as examples are fine — they are real default paths.

- [ ] **Step 2: Internal link check**

```bash
grep -rhoE '\]\(/docs/[a-z0-9/#-]+' . | sed 's/](//;s/#.*//' | sort -u > /tmp/doc-links.txt
while read -r l; do p="${l#/docs/}"; [ -f "${p}.mdx" ] || [ -f "${p}/index.mdx" ] || echo "BROKEN: $l"; done < /tmp/doc-links.txt
```
Expected: no `BROKEN:` lines. Fix any.

- [ ] **Step 3: Full gates**

Run: `cd /Users/jay/root/kortix/suna-acp/apps/web && pnpm exec fumadocs-mdx && pnpm test`
Expected: MDX compiles; web suite passes (docs content has no unit tests, but the suite guards against accidental source changes).
Run: `cd /Users/jay/root/kortix/suna-acp/apps/web && pnpm build`
Expected: production build succeeds (this compiles every MDX page for real). If the build needs env keys unavailable in this checkout, fall back to `pnpm exec fumadocs-mdx` + `npx tsc --noEmit` and note the skipped build in the final report.

- [ ] **Step 4: Commit any sweep fixes**

```bash
git add apps/web/content/docs
git commit -m "docs(web): final ACP consistency sweep and link fixes"
```

---

## Self-review (done at plan time)

- **Spec coverage:** All 8 missing-surface items from the audit are covered — harness matrix + flags (Task 1), ACP bridge (Task 2), v3-primary manifest + migration (Task 3), envelope durability + identity (Task 4), SDK ACP primitives + example 09 (Task 8), web Runtime section + `unified_model_picker` (Task 1 "Choosing a harness"/"Model selection"), permission policy (Task 9 Step 4), and all 12 partially-stale pages are edited (Tasks 3–9).
- **Known ambiguities delegated to verify-in-code steps:** sandbox image contents (Task 6 Step 1), CLI `dev`/`init`/`agents model` exact behavior (Task 7 Step 1), v3 JSON schema URL existence (Task 3 Step 2), `useSession` return shape (Task 9 Step 5), Callout warn variant name (Task 9 Step 3).
- **Type/anchor consistency:** anchors `#v2-v3-migration` (Task 3) ← Task 5; `#acpclient`/`#acpsession`/`#projections` (Task 8) ← Tasks 8–9; `/docs/reference/harnesses` (Task 1) ← Tasks 2–7; `/docs/reference/acp-bridge` (Task 2) ← Tasks 4, 8.
