# `@kortix/sdk` examples

Runnable, framework-free examples for the Kortix SDK — from a one-line
`projects.list()` to a full **Kortix-as-a-Backend** wrapper that serves many of
your own end-users through one shared agent.

Each `.ts` file runs on [Bun](https://bun.sh) and imports the SDK from source
(`../src/...`), so you can read the exact code path. As an npm consumer the
imports are `@kortix/sdk`, `@kortix/sdk/server`, `@kortix/sdk/turns`, etc.
(noted in each file).

## Setup

```bash
export KORTIX_API_URL=https://api.kortix.com/v1   # your API base, incl. /v1
export KORTIX_API_KEY=kortix_pat_...              # Settings → Tokens → Create API key
export KORTIX_PROJECT_ID=...                      # the project your agent lives in
```

- The API key is a `kortix_pat_…` token. Every session it starts is recorded
  with `origin: backend`, which is what unlocks the backend-only overrides
  (`origin_ref`, `secrets`) — see the [Kortix-as-a-Backend
  guide](../../../docs/KORTIX_AS_A_BACKEND_GUIDE.md).
- Some examples read extra env vars (a session id, a connector URL); each file's
  header comment lists what it needs.

## The examples

| # | File | What it shows | Run |
|---|------|---------------|-----|
| 01 | [`01-list-projects.ts`](01-list-projects.ts) | Minimum viable client — `createKortix` + a static bearer token, list projects. | `bun run examples/01-list-projects.ts` |
| 02 | [`02-send-and-stream.ts`](02-send-and-stream.ts) | Provision a session, send a prompt, stream the text deltas — no framework. | `KORTIX_SESSION_ID=… bun run examples/02-send-and-stream.ts "hi"` |
| 03 | [`03-server-wrapper.ts`](03-server-wrapper.ts) | The multi-tenant seam: `createScopedKortix` from `@kortix/sdk/server` (per-request token, no global bleed). | `MODE=serve bun run examples/03-server-wrapper.ts` |
| 04 | [`04-render-transcript.ts`](04-render-transcript.ts) | Render a session transcript as plain text with `classifyTurn` (`@kortix/sdk/turns`). | `KORTIX_SESSION_ID=… bun run examples/04-render-transcript.ts` |
| 05 | [`05-cost-passthrough.ts`](05-cost-passthrough.ts) | A marked-up usage table — the shape a backend uses to re-bill its own users. | `KORTIX_SESSION_ID=… bun run examples/05-cost-passthrough.ts` |
| 06 | [`06-files-and-secrets.ts`](06-files-and-secrets.ts) | Session-scoped workspace files + project secrets. | `KORTIX_SESSION_ID=… bun run examples/06-files-and-secrets.ts` |
| 07 | [`07-vanilla.ts`](07-vanilla.ts) | The whole flow in one framework-free file: list → send → stream. | `bun run examples/07-vanilla.ts "hi"` |
| 08 | [`08-cdn.html`](08-cdn.html) | The SDK in a browser with **no build step** (ESM via CDN). | open in a browser |
| 09 | [`09-kaab-backend-wrapper.ts`](09-kaab-backend-wrapper.ts) | **Kortix as a Backend, end to end**: mint a connector → per-user profile → backend-origin session (`origin_ref` + `secrets` + `connector_bindings`) → **stream**. One-shot CLI **and** a multi-tenant SSE service. | `bun run examples/09-kaab-backend-wrapper.ts "Summarize my signups"` |

## Kortix as a Backend

Wrapping one shared agent as the backend for many of your users — each bringing
their connectors, model, secrets, and identity **by reference** — is examples
**03** (the multi-tenant client seam) and **09** (the complete flow). Read them
alongside:

- [`docs/KORTIX_AS_A_BACKEND_GUIDE.md`](../../../docs/KORTIX_AS_A_BACKEND_GUIDE.md) — the concepts, overrides, errors, and security model.
- [`KORTIX-AS-A-BACKEND.pdf`](KORTIX-AS-A-BACKEND.pdf) — the same, as a printable one-pager.

### `09` env knobs

| Var | Effect |
|-----|--------|
| `MODE=serve` | Run as a `POST /run {endUserId, prompt}` → SSE service instead of one-shot. |
| `KAAB_OVERRIDES=off` | Drop the backend-only fields (`origin_ref`, `secrets`) so the connector + session + streaming path still runs against a deployment that doesn't have them yet. |
| `KAAB_NO_CONNECTOR=1` | Skip the connector layer (a bare project with no `kortix.yaml`). |
| `KAAB_CONNECTOR_URL` / `KAAB_AGENT` / `KAAB_MODEL` / `KAAB_SECRET` | Point the demo at your own connector URL / agent / model / secret identifier. |

> **Streaming needs the sandbox to reach your API.** A hosted deployment works
> out of the box. Against a **local** API, a cloud sandbox can't reach
> `localhost` — front it with a public tunnel (`cloudflared tunnel --url
> http://localhost:8010`) and start the API with `KORTIX_URL` set to that URL.
