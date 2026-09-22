# Credentials & setup links

How an agent gets the credentials it needs — an API key, a connected app —
**without ever touching a raw secret and without sending the human to go hunting
in a dashboard.** You mint a short-lived **setup link** and surface it; the human
fills it in; you continue.

This is the canonical answer to "I need an API key / I need this app connected."

---

## The rule (do this, every time)

> **When you need a credential, mint a setup link and surface the URL in your
> reply — in the same turn. Never tell the human to "open the dashboard →
> Customize → Connectors", and never ask them to paste a raw key into chat.**

There are exactly two kinds of credential you'll ever need, and one link each:

| You need… | Mint… | The human gets… |
| --- | --- | --- |
| an **API key / token / secret value** (e.g. `APOLLO_API_KEY`) | a **secret link** | a fill-in form |
| an **app connected** via Composio (e.g. Gmail, GitHub) | a **connect link** | a 1-click authorize |

> **Slack is neither of these.** Connecting Slack is a built-in channel flow:
> run `kortix channels connect` — it prints a one-click "Add to Slack" install
> link. Do NOT mint a secret link for `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET`
> and do NOT add a managed `slack` connector (the slug is reserved).

Both links render the same way everywhere:

- **In the web app** the link opens an in-app **modal/popup** (a fill-in form, or
  the 1-click connect).
- **In Slack / Telegram** the same URL is just a **tappable link** — the human
  opens it on their phone, no login required.

You never see the value. For a connector, no key ever touches chat or the repo.

---

## Minting a secret link

You name the secret(s); the platform mints a link the human opens to type the
value in. **You never receive the value** — once they submit it, a `runtime`
secret simply appears in your session env (and in `KORTIX_PROJECT_SECRET_NAMES`).

**Preferred — the `request_secret` tool on the `kortix-connectors` MCP:**

```
request_secret({ names: ["APOLLO_API_KEY", "SMARTLEAD_API_KEY"],
                 descriptions: { APOLLO_API_KEY: "Settings → API in Apollo" } })
→ { url: "https://<app>/secret-intake/ksl_…", names: [...], expires_at }
```

**Or from a shell** (equivalent):

```sh
kortix secrets request APOLLO_API_KEY SMARTLEAD_API_KEY     # several keys, one link
kortix secrets request APOLLO_API_KEY --scope connector     # server-side only
```

Then **surface the `url`** to the human: *"Add your Apollo key here (link valid
7 days): &lt;url&gt;"*.

**Reuse a live link — never re-mint per run.** Minting is not idempotent: every
call creates a NEW link and does not invalidate the old one. If your task loops
(cron, sweep, retry), record the link + its `expires_at` the first time you
surface it, and on later runs check whether the secret is set before saying
anything. Re-mint and re-post **only** when the recorded link is expired (or
within ~1h of expiring) and the secret is still missing. Posting a fresh link
every run floods the channel with duplicate "blocked" messages and points humans
at dead links.

- **`scope: runtime`** (default) — the value is injected into your sandbox env,
  so you can read it (`process.env.APOLLO_API_KEY`) or use it from a tool. Use
  this for keys your own code/tools consume.
- **`scope: connector`** — the value is kept server-side only (never injected),
  for credentials resolved by the connector gateway. Use this when a key backs a
  connector, not your env.

One link can request several keys at once — ask for everything you need in a
single message.

## Minting a Composio connect link

For an app you connect via Composio, mint a 1-click connect link. If the
connector isn't on the project yet, **add it instantly first — no change
request**: the `add_connector` tool / `kortix connectors add <slug> --provider
composio --app <toolkit> --apply`. That commits it to
`kortix.yaml` on main and syncs the catalog server-side, exactly like the
dashboard's "Add app" — it's live this session. Then mint the connect link.

Pipedream is legacy rollback only. Never select it automatically. If Composio
cannot satisfy the request, stop and ask the human before any explicit
`allow_legacy_pipedream` / `--allow-legacy-pipedream` retry.

### Choosing `owner: project` vs `owner: me` — get this right UP FRONT

Every connect link creates an account whose **owner is fixed at
authorization** — there is no in-place re-scope later. So decide the owner
BEFORE you mint the link:

- **`owner: "project"`** — the account is shared: every member's and every
  agent session's calls run as it. Use this for any shared company tool
  (company inbox, calendar, Linear, Docs…). **The identity that completes the
  OAuth is the identity the whole project then acts as** — so when you surface
  a shared link, say explicitly: *"authorize this signed in as
  `agent@kortix.ai` (the project identity), not your personal account."* A
  personal login authorized into the shared slot makes every agent session
  silently act AS that person.
- **`owner: "me"`** (default) — the account is private to the human you're
  talking to; only their sessions can call as it. Use this for a person's own
  login.

Heuristic: shared company tool → `project`; a person's own account → `me`.
**If it's ambiguous, ask — never silently default a personal login into the
shared slot.** If you mint a shared link for a tool the team will share, make
sure the project has (or first creates) the shared identity to authorize with.

Ownership is a property of the CONNECTION (the account row), not of the
connector — the connector itself is a project-wide tool. A member-private
account is reachable only by its owner inside a private session: unattended
automations (triggers, cron, service accounts) can never run as it, which is
exactly why the shared slot must hold the project identity.

**Re-scoping a mis-owned account** (no in-place fix exists):

1. `kortix connectors connect <slug> --owner project` (or `me`) → human
   authorizes with the CORRECT identity.
2. `kortix connectors accounts <slug> --default <label>` → pin the correct
   account as the default unnamed calls use.
3. `kortix connectors connections revoke <connection-id>` → revoke the stray
   binding (`connections ls --all` to find it).

**Preferred — the `connect` tool on the `kortix-connectors` MCP:**

```
connect({ slug: "gmail", owner: "project" })   # shared — authorize as agent@kortix.ai
→ { url: "https://<app>/connect/ksl_…", app: "gmail", expires_at }
```

**Or from a shell:**

```sh
kortix connectors connect gmail --owner project   # matches the MCP `connect` tool
```

Then **surface the `url`**. The human clicks and authorizes the app on Composio's
hosted flow. Finalize the connection when the human returns so the account
binding is persisted server-side. Mint a fresh link when a previous request has
expired or was abandoned.

`kortix connectors connect` returns the durable, modal-friendly connection URL.
Use `kortix connectors connect-finalize <slug>` when the flow requires an
explicit completion check.

**A connector can hold more than one account.** `connect` doesn't replace an
existing account, it adds one — `owner: "me"` authorizes the human you're
talking to as a NEW private account beside any that already exist;
`owner: "project"` shares it with everyone (see the ownership rules above —
shared accounts must be authorized as the project identity). If the connector
already has accounts and the human just wants to USE one of them (not add
another), do not mint a new `connect` link — list them with `accounts`
instead and pass `account` on the call.

---

## After you surface the link

The smooth flow is:

1. Mint the link and surface it, with a one-line "what this is for".
2. **End your turn** — the human can't fill it in while you hold the turn.
3. When a **secret** is submitted while your session is running, the platform
   sends you a follow-up message naming the saved keys — treat it as your cue to
   verify and continue. If your session was asleep, or the human just says
   "done", **verify and continue**:
   - **Secret:** check the name is now present — `kortix secrets ls` (or look for
     it in `KORTIX_PROJECT_SECRET_NAMES`). A fresh `runtime` value is live in the
     session env immediately (it's hot-synced; no restart needed).
   - **Connector:** check it now appears in your usable catalog —
     `kortix connectors ls` (the `connectors` MCP tool). Unconnected connectors are
     filtered out, so its presence means the credential landed.

If it isn't there yet, the human may not have finished — say so and wait.

---

## Why this is safe (and why it's the only good way)

- The link is an **opaque, encrypted, single-project token** with a bounded TTL
  (default 7 days, adjust with `--expires` / `expires_in_minutes`, max 30 days).
- It is **value-only**: it can only *set* the exact key(s) you named, in *this*
  project. It can't read any existing secret and can't target another key — so a
  leaked link is low-blast-radius and expires on schedule.
- **You never handle the raw value.** The human enters it directly into an
  encrypted store; for a connector, the provider authorization remains
  server-side.

This beats the alternatives you might be tempted by:

- ❌ "Paste your API key here" — puts a raw secret in the chat transcript.
- ❌ "Go to the dashboard → Customize → Connectors → Connect" — the friction that
  makes the human give up. You have a one-click link; use it.
- ❌ `kortix secrets set NAME=<value>` — you don't *have* the value, and you
  shouldn't.

---

## Quick reference

| Goal | MCP tool | `kortix` CLI |
| --- | --- | --- |
| Ask the human for a secret value | `request_secret` | `kortix secrets request <NAME…>` |
| Get an app connected (Composio) | `connect` | `kortix connectors connect <slug> [--owner me\|project]` |
| Verify a secret arrived | — | `kortix secrets ls` |
| Verify a connector connected | `connectors` | `kortix connectors ls` |
| Which/how many accounts are connected | `accounts` | `kortix connectors accounts <slug>` |
| Pin the default account for unnamed calls | — | `kortix connectors accounts <slug> --default <label>` |

Both surfaces hit the same endpoints and return the same kind of link — use
whichever fits your flow. The MCP tools are always loaded. The
`kortix connectors` CLI exposes the same connector gateway for shell use.
