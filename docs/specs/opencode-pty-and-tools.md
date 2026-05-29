# Spec: Bring back the OpenCode PTY plugin + built-in tools (Kortix-router-first)

Status: **implemented** · 2026-05-29

## Decisions locked
- **`instance_dispose` dropped** — the `/instance/dispose` hot-reload mechanism it
  targeted doesn't exist in the current architecture. Not ported.
- **D1 = (b): Moondream2 activated through the proxy.** Added a version-gated
  `POST /predictions` route (locked to the one Moondream2 version the tool pins) + a
  zero-cost `GET /predictions/*` poll route + a new `allowedBodyVersions` anti-abuse gate
  enforced in `handleKortixProxy`. Billing SKUs: `proxy_replicate_moondream` (0.002) and
  `proxy_replicate_poll` (0). Note: the pre-existing `/v1/models/...` nano-banana/gpt-image
  routes are placeholders that don't match what `replicate@1.x` actually emits with our
  `baseUrl` (it sends `/predictions`, not `/v1/models/...`) — left untouched, unused.
- **Dependencies pinned** (`replicate@^1.4.0`, `@tavily/core@^0.7.3`,
  `@mendable/firecrawl-js@^4.25.1`), committed `bun.lock`, and Bun cache pre-warmed in both
  the layered build (`dockerfile-layer.ts`) and `apps/sandbox/Dockerfile`. No `bun-pty` —
  the PTY plugin uses OpenCode's native `/pty` backend.
- **Tracked source of truth = the starter template** (`packages/starter/templates/base/
  .kortix/opencode/`). The suna-root `.kortix/opencode/` is gitignored (local dogfood copy)
  and was updated too for local testing.



## Goal

Port two things from the legacy OG config at `core/kortix-master/opencode` (main branch) into
the current `.kortix/opencode` runtime config:

1. **The OpenCode PTY plugin** — `pty_spawn` / `pty_write` / `pty_read` / `pty_list` / `pty_kill`
   (long-running + interactive terminal sessions the agent can drive).
2. **The built-in web tools** — `web_search` (Tavily), `image_search` (Serper + Replicate),
   `scrape_webpage` (Firecrawl), and `instance_dispose` (nuclear config-reload).

Every external-API tool must default to the **Kortix router**: authenticate with `KORTIX_TOKEN`
against our proxy, and only fall back to a user-supplied raw provider key when the router is not
configured. The legacy code already implements exactly this pattern — the job is mostly porting +
wiring, not new design.

> `show.ts` is **already present** in the current config and byte-for-byte identical to the OG
> copy. Nothing to do there.

---

## Key finding: the server side already exists

The hard part is already shipped. We do **not** need to build a proxy.

- **Router/proxy:** `apps/api/src/router/routes/proxy.ts` + `apps/api/src/router/config/proxy-services.ts`.
  Services registered today: `tavily`, `serper`, `firecrawl`, `replicate`, `context7`, plus LLM
  providers. Three auth modes: (1) `KORTIX_TOKEN` → inject Kortix's real key, bill at markup;
  (2) user key + `X-Kortix-Token` → passthrough at platform fee; (3) pure passthrough.
- **Env injection:** `apps/api/src/platform/providers/local-docker.ts` already syncs these into
  every sandbox via the s6 env dir (`/run/s6/container_environment/`, hot, no restart):
  - `KORTIX_TOKEN`, `KORTIX_API_URL`
  - `TAVILY_API_URL`, `SERPER_API_URL`, `FIRECRAWL_API_URL`, `REPLICATE_API_URL` → all point at
    `${routerBase}/<service>`.
- **The legacy `lib/get-env.ts` resolution order already matches our runtime:**
  s6 env dir → `process.env` → nearest `.env`. Port it verbatim.

**Consequence:** in production the `*_API_URL` overrides are always set, so every tool routes
through the proxy with `KORTIX_TOKEN` automatically. The per-provider raw-key path
(`TAVILY_API_KEY` etc.) only kicks in for self-hosters who haven't pointed at a router.

### The router-first pattern (already in the legacy tools — keep verbatim)

```ts
const apiBaseURL = getEnv("TAVILY_API_URL");        // set ⇒ proxy is configured
const apiKey = apiBaseURL
  ? getEnv("KORTIX_TOKEN")                            // route through Kortix
  : getEnv("TAVILY_API_KEY");                         // else hit provider directly
const client = tavily({ apiKey, ...(apiBaseURL ? { apiBaseURL } : {}) });
```

Same shape for Serper (`SERPER_API_URL`), Firecrawl (`FIRECRAWL_API_URL`), Replicate
(`REPLICATE_API_URL`). No changes needed to the tool logic — it was written for this proxy.

---

## How OpenCode loads tools & plugins (verified)

- Config dir is resolved per-project: `<workspace>/.kortix/opencode` (else
  `/ephemeral/kortix-master/opencode`), passed to the process as `OPENCODE_CONFIG_DIR`
  (`apps/kortix-sandbox-agent-server/src/opencode.ts`).
- **Tools:** every `*.ts` in `<config>/tools/` is auto-loaded. (That's how `show.ts` works today.)
- **Plugins:** every `*.ts` in `<config>/plugins/` is auto-loaded, **and** any path listed in the
  `"plugin": [...]` array of `opencode.jsonc` is loaded. Both coexist.
- **Dependencies:** if a `package.json` exists in the config dir, OpenCode runs `bun install` at
  startup; tools/plugins can then import those packages. `@opencode-ai/plugin` is always available
  (ships with the globally-installed `opencode-ai@1.14.28`).
- **PTY backend:** OpenCode's own server exposes `/pty`, `/pty/{id}`, `/pty/{id}/connect`
  (confirmed in the `@opencode-ai/sdk`). The legacy PTY manager uses these HTTP+WS endpoints as its
  **primary** path, with a `bun-pty` native-module fallback only if `/pty` is unreachable.
  → **We can rely on the native `/pty` path and skip `bun-pty` entirely** (no native addon, no
  per-arch compile). Keep the fallback file but don't ship the `bun-pty` dependency unless a probe
  shows `/pty` missing on 1.14.28.

---

## Implementation plan

All paths relative to a config root `.kortix/opencode/`. Apply to **both** runtime configs:
- `suna/.kortix/opencode/` (this repo, dogfood)
- `packages/starter/templates/base/.kortix/opencode/` (shipped to every new project)
- (and `…/templates/general-knowledge-worker/.kortix/opencode/` if it carries its own tools)

### 1. Tools (`tools/`)

Copy verbatim from `core/kortix-master/opencode/tools/`:
- `tools/lib/get-env.ts` — shared env resolver (s6 → process.env → .env).
- `tools/web_search.ts` — Tavily, `@tavily/core`.
- `tools/image_search.ts` — Serper + Replicate/Moondream, `replicate`. **See Decision D1.**
- `tools/scrape_webpage.ts` — Firecrawl, `@mendable/firecrawl-js`.
- `tools/instance_dispose.ts` — no external deps. **See Decision D3.**
- `tools/show.ts` — already present, leave as-is.

### 2. PTY plugin (`plugins/` + a non-scanned subtree)

The legacy entry `pty-tools.ts` is a self-contained Plugin that returns the 5 PTY tools + a
`session.deleted` event handler, importing an implementation tree under `pty/opencode-pty/src/**`.

To avoid any ambiguity about recursive plugin auto-discovery (which would wrongly load the nested
`types.ts`/`manager.ts`/… as plugins), **declare the entry explicitly** and house the tree under a
folder that is **not** named `plugins/`:

```
.kortix/opencode/
  pty/
    pty-tools.ts                     # the Plugin entry (was plugin/kortix-system/pty-tools.ts)
    opencode-pty/                    # impl tree, copied verbatim
      src/...                        # buffer, manager, session-lifecycle, tools/*, formatters…
```

…and in `opencode.jsonc`:

```jsonc
{
  "plugin": ["./pty/pty-tools.ts"]
}
```

This mirrors the proven OG layout (explicit `plugin` array + a non-auto-scanned `plugin/` dir) and
leaves the auto-discovered `plugins/` dir (memory plugin) untouched.

Fix the one relative import in `pty-tools.ts` so it points at `./opencode-pty/src/...` under the
new location.

### 3. Dependencies (`package.json`)

Add `.kortix/opencode/package.json`:

```json
{
  "dependencies": {
    "@tavily/core": "<pin>",
    "replicate": "<pin>",
    "@mendable/firecrawl-js": "<pin>"
  }
}
```

Pin firecrawl to a version whose endpoints (`/v1/*` or `/v2/*`) are in the proxy allowlist
(`proxy-services.ts` already lists both). No `bun-pty` (see PTY backend note).

**Boot-latency mitigation (required — see the boot-latency memory):** a cold `bun install` on every
sandbox boot is unacceptable. Pre-warm Bun's global cache in the snapshot so the boot-time install
is offline and ~instant: in `apps/sandbox/Dockerfile`, after the opencode install, run
`bun install` of the same three packages into a throwaway dir (populates `~/.cache`/bun store baked
into the image). Validate actual added boot time with `apps/api/scripts/bench-boot.ts` before/after.

---

## Decisions / open questions

- **D1 — Replicate/Moondream enrichment is blocked by the proxy allowlist.**
  `image_search.ts` enriches results with the Moondream2 model via `replicate.run(...)`, which hits
  `/v1/models/lucataco/moondream2/...` (or `/v1/predictions`). The proxy `replicate` service only
  allows `google/nano-banana` and `openai/gpt-image-1.5`. Through the router, enrichment will 403.
  Options:
  - **(a) Ship image_search with enrichment OFF by default** (return Serper results only; enrich
    only when a raw `REPLICATE_API_TOKEN` is set). Simplest, no server change.
  - **(b) Add Moondream2 to the proxy allowlist** in `proxy-services.ts` (+ billing entry). Keeps
    enrichment working through Kortix. Small server change.
  - **(c) Switch enrichment to an already-allowed vision model.** Behavior change.
  Recommendation: **(b)** if we want parity with the OG behavior, else **(a)**. Pick before porting.

- **D2 — Auth header contract.** The proxy detects the Kortix token across `Authorization: Bearer`,
  `X-API-Key`, `x-api-key`, and the `api_key` JSON body field, and injects the real provider key
  per `proxy-services.ts` (`tavily`→body `api_key`, `serper`→`X-API-KEY`, `firecrawl`/`replicate`→
  `Authorization`). The SDKs send the token in their own native header; the proxy was built for
  exactly these tools. Verify end-to-end once per provider after porting (a 401 vs 403 will tell us
  whether it's a token-detection vs an allowlist issue).

- **D3 — Is `instance_dispose` still wanted?** It POSTs `/instance/dispose` to force a full config
  rescan. Useful when the agent edits its own `.kortix/opencode` config and wants changes live, but
  it's server-wide and nuclear. Include it (it has no deps and is opt-in by the model), or drop it
  if the current hot-reload story already covers config edits. Low stakes either way.

- **D4 — Skill/prompt surfacing.** The OG `kortix-system.md` documents these tools to the model.
  Decide whether to add short usage notes to the current agent prompt / a skill so the model knows
  `web_search`, `image_search`, `scrape_webpage`, and the `pty_*` tools exist. (Auto-discovery makes
  them callable; prompting makes them *used*.)

---

## Verification plan

1. **Local:** `bun install` resolves the three packages; `opencode serve` loads tools (`show`,
   `web_search`, `image_search`, `scrape_webpage`, `instance_dispose`) and the 5 `pty_*` tools with
   no load errors in stdout (`[pty-tools] plugin init`).
2. **PTY:** `pty_spawn` a long-running command (e.g. `bash -c 'for i in …; do echo $i; sleep 1;
   done'`), `pty_read` with pagination, `pty_write` input to an interactive REPL, `pty_kill`.
   Confirm it uses the native `/pty` backend (no `bun-pty` load-error log).
3. **Router (the important one):** in a real sandbox (where `*_API_URL` + `KORTIX_TOKEN` are
   injected) run `web_search`, `scrape_webpage`, `image_search` and confirm 200s through the proxy
   and a billing event per call (`proxy_tavily` / `proxy_firecrawl` / `proxy_serper`). Then unset
   the `*_API_URL` and confirm the raw-key fallback path still works for self-host.
4. **Boot latency:** `apps/api/scripts/bench-boot.ts` before/after the dependency change; the
   pre-warmed cache should keep added boot time negligible.

## File-change summary

| Area | Change |
|---|---|
| `tools/` (both configs) | + `lib/get-env.ts`, `web_search.ts`, `image_search.ts`, `scrape_webpage.ts`, `instance_dispose.ts` |
| `pty/` (both configs) | + `pty-tools.ts` + `opencode-pty/src/**` (verbatim, fix one import path) |
| `opencode.jsonc` (both configs) | + `"plugin": ["./pty/pty-tools.ts"]` |
| `package.json` (both configs) | + 3 deps (`@tavily/core`, `replicate`, `@mendable/firecrawl-js`) |
| `apps/sandbox/Dockerfile` | pre-warm Bun cache for the 3 deps |
| `apps/api/.../proxy-services.ts` | **only if D1=(b):** add Moondream2 to `replicate` allowlist |
```