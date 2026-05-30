---
name: kortix-executor
description: How to reach third-party systems from a Kortix session via the Executor — one interface to every configured integration (Pipedream, MCP, OpenAPI, GraphQL, HTTP), exposed as the `kortix-executor` MCP server's tools (connectors, discover, describe, call). Load whenever the user asks the agent to DO something in an external app/API (send an email, create a Stripe charge, post to Slack, query an internal API, call any SaaS), asks "what integrations/connectors/tools do I have", asks to add/configure a connector, or asks about `[[connectors]]` in kortix.toml. The agent must use the Executor's MCP tools rather than hand-rolling API calls with raw tokens.
---

<skill name="kortix-executor">

<overview>
The **Executor** is the one way an agent reaches outside systems. Instead of
juggling per-app SDKs and raw tokens, you use the **`kortix-executor` MCP
server**, auto-loaded into every session. It talks to the Kortix **Executor
Gateway**, which holds the credentials, checks what you're allowed to use, runs
the call, and audits it.

It exposes a small, stable set of MCP tools — not one tool per integration — so
you **progressively discover** what you need instead of drowning in a giant
catalog:

- **`connectors`** — what this session can use (provider, status, tool count)
- **`discover`** — intent search across every usable tool
- **`describe`** — one tool's full input schema + risk
- **`call`** — run a tool

**You never see a third-party secret.** The gateway resolves it server-side from
the project's secrets and attaches it. The sandbox only carries
`$KORTIX_EXECUTOR_TOKEN`, which makes every call act **as the user who launched
the session** — so you can only use connectors that user has been granted.

A **connector** is one named integration. They're declared in `kortix.toml` as
`[[connectors]]` (provider = pipedream | mcp | openapi | graphql | http) and the
secret value / Pipedream 1-click connection + who-can-use-it are set in the
Kortix dashboard. Each connector exposes **tools** (actions) with a connector-
namespaced path like `stripe.charges.create`.
</overview>

<when-to-load>
Load this skill when the user wants to:
- Act in an external app/API — "send an email", "create a charge", "post to
  Slack", "create a GitHub issue", "query our internal API".
- See what's available — "what integrations / connectors / tools do I have?"
- Add or configure a connector, or asks about `[[connectors]]` in `kortix.toml`.

If the task is purely local (editing files, running tests) you don't need this.
</when-to-load>

<usage>
Use the `kortix-executor` MCP tools. They appear in your tool list once the
session has the Executor wired (it always does in a Kortix sandbox). All return
JSON.

**Loop: `discover` → `describe` → `call`.** Always `describe` an unfamiliar tool
to learn its input schema before you `call` it.

1. **See what this session can use** — call `connectors` (no args). Returns each
   connector's slug, provider, status, and tool count.
2. **Find a tool by intent** — call `discover` with
   `{ "query": "send a slack message" }` (optionally `"limit"`). Returns the
   best-matching tool paths with their risk + description.
3. **Inspect a tool before calling it** — call `describe` with
   `{ "tool": "stripe.charges.create" }`. Returns the full input JSON schema.
4. **Run it** — call `call` with
   `{ "connector": "stripe", "action": "charges.create", "args": { "amount": 999, "currency": "usd" } }`.
   The gateway attaches the credential, enforces sharing + policy, runs it, and
   audits it.

**GraphQL tools:** pass selected fields via `__select` inside `args`, e.g.
`{ "connector": "internal-graph", "action": "query.user", "args": { "id": "1", "__select": "id name email" } }`.

**The full API of any connector — the `request` tool.** Every connector exposes
a curated set of named actions, but you are NOT limited to them. Each
**Pipedream** connector also has a generic **`request`** tool that proxies to
*any* endpoint of that app's API (the Connect Proxy — the credential is injected
server-side, you never see it). This is the "complete API access" path: when no
named action fits, find the endpoint in the app's API docs and call it directly.

```jsonc
// Post a PR comment on GitHub — no named action needed, just the endpoint:
{ "connector": "github", "action": "request", "args": {
    "method": "POST",
    "url": "https://api.github.com/repos/kortix-ai/suna/issues/1234/comments",
    "body": { "body": "Thermo review: …" } } }
```

`request` args: `method` (GET/POST/PUT/PATCH/DELETE), `url` (the absolute app
API URL), optional `body` (JSON) and `headers`. The upstream status + JSON come
back verbatim. Reach for a named action when one fits (typed inputs); reach for
`request` for everything else. (`openapi`/`http`/`graphql` connectors already
expose the whole spec as named tools, so they don't need `request`.)
</usage>

<rules>
- **Use the Executor's MCP tools — do not hand-roll** HTTP calls to third-party
  APIs with raw tokens. There are no raw third-party tokens in the sandbox by
  design.
- If `connectors` is empty or a tool is missing, the connector isn't configured
  or isn't **shared with this user**. Tell the user to add/share it in the Kortix
  dashboard (Customize → Connectors); don't try to work around it.
- A `call` result of `ok: false` with `denied` (`not_shared` / `needs_auth`)
  means exactly that — surface it; the fix is in the dashboard, not the sandbox.
- Tools carry a **risk** (read / write / destructive). Be deliberate with
  `write`/`destructive` calls; confirm intent with the user for irreversible ones.
- To add a connector to the repo, edit `kortix.toml` `[[connectors]]` (see the
  `kortix-system` skill for the manifest); the secret value + sharing are then
  set in the dashboard.
- An `executor` CLI exists on `$PATH` as a fallback (same gateway, same auth),
  but the MCP tools are the primary path — prefer them.
</rules>

<adding-connectors>
Connectors are defined in `kortix.toml` (committed). Example:

```toml
[[connectors]]
slug     = "stripe"
name     = "Stripe API"
provider = "openapi"
spec     = "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json"
  [connectors.auth]
  type   = "bearer"
  secret = "STRIPE_API_KEY"   # the VALUE is set in the dashboard, never in git
```

Providers: `pipedream` (`app` + 1-click OAuth — gives the whole app API via the
`request` proxy tool), `openapi`/`graphql`/`http` (a `spec`/`endpoint`/`base_url`
+ `[connectors.auth]`), `mcp` (`url` + `transport`). After editing the manifest,
the platform materializes the catalog.

**One-click auth from the CLI (no dashboard needed).** For a Pipedream connector
you can authenticate entirely from your terminal — the CLI hands you the link:

```sh
kortix connectors add github --provider pipedream --app github   # edit kortix.toml
kortix ship                                                       # apply to the project
kortix connectors connect github   # prints a one-click OAuth URL — open it, authorize
kortix connectors finalize github  # confirm the connection; now the agent can use it
```

That's the whole setup for a new integration: add → ship → connect (click the
link) → finalize. The connected app's full API is then reachable via the
`request` tool. Sharing is `project` by default; scope it with
`kortix connectors share`.
</adding-connectors>

</skill>
