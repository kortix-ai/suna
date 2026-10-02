# Credentials & setup links

How an agent gets the credentials it needs — an API key, a connected app —
**without sending the human to go hunting in a dashboard.**

This is the canonical answer to "I need an API key / I need this app connected."

---

## The rule (do this, every time)

1. **You already HAVE the value → set it yourself, now.** The human pasted it
   in the conversation, attached it in a file, or said "use this key". Store it
   with the `set_secret` tool (or `kortix secrets set NAME=-`, value on stdin)
   in the same turn. Do not mint a link. Do not ask them to enter it a second
   time. Do not lecture them about pasting it. Never echo the value back.
2. **You do NOT have the value → mint a setup link** and surface the URL in your
   reply, in the same turn. Never tell the human to "open the dashboard →
   Customize → Connectors". Do not ASK the human to paste a key into chat — the
   link is the better channel when you have to ask.

Setting a secret needs your project's secret-write permission. A `403` from
`set_secret` / `kortix secrets set` means your agent does not have it: fall back
to a secret link (rule 2) for the same name.

When you do need a link, there are exactly two kinds, one each:

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

A value entered through a link never passes through you. For a connector, no
key ever touches chat or the repo.

---

## Setting a value you already have

```
set_secret({ values: { APOLLO_API_KEY: "<the value from the conversation>" } })
set_secret({ values: { BILLING_API_TOKEN: "<value>" }, scope: "connector" })
→ { ok: true, saved: ["APOLLO_API_KEY"], scope: "runtime" }
```

**Or from a shell** (equivalent — stdin keeps the value out of shell history):

```sh
printf '%s' "$VALUE" | kortix secrets set APOLLO_API_KEY=-
printf '%s' "$VALUE" | kortix secrets set BILLING_API_TOKEN=- --scope connector
```

- **`scope: runtime`** (default) — loaded into the sandbox env of this session
  (hot-synced, no restart) and of later sessions whose agent is granted it.
- **`scope: connector`** — kept server-side, spent only by the connector
  gateway. Use this when the key backs a connector's credential binding.
- An agent can store runtime and connector secrets only. Egress/enforced
  delivery, host lists, and LLM-gateway keys stay human-only (`403`).
- Then verify exactly as after a link (see "After you surface the link").

---

## Minting a secret link

Use this only when you do not have the value. You name the secret(s); the
platform mints a link the human opens to type the value in. **You never receive
the value** — once they submit it, a `runtime`
secret simply appears in your session env — when your agent is granted it (see
"Set, but I can't see it" below).

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

Every connect link creates an account whose **owner is set at authorization**.
Its owner can later SHARE a private account (Share in Customize, or
`kortix connectors connections share <id>`), which turns it into a shared
account — right only when it was signed in with a shared identity, never a
person's own login. A shared account never goes back to private. So decide the
owner BEFORE you mint the link:

- **`owner: "project"`** — the account is shared: every member's and every
  agent session's calls run as it. Use this for any shared company tool
  (company inbox, calendar, Linear, Docs…). **The identity that completes the
  OAuth is the identity the whole project then acts as** — so when you surface
  a shared link, say explicitly: *"authorize this signed in as the project's
  shared identity (a team or service account the project owns, not a
  person's login)."* A personal login authorized into the shared slot makes
  every agent session silently act AS that person.
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
connect({ slug: "gmail", label: "Dad's Gmail" })                   # a person's own account
connect({ slug: "gmail", owner: "project", label: "Team inbox" })  # shared: authorize as the project's own identity, not a personal login
→ { url: "https://<app>/connect/ksl_…", app: "gmail", expires_at }
```

From a shell, `kortix connectors connect <slug> [--owner project]` is NOT the
same: it returns the provider's raw authorization URL for the connector's
default account, and it cannot name a new one. Use the MCP `connect` tool to
add an account.

Then **surface the `url`**. The human clicks and authorizes the app on Composio's
hosted flow. Finalize the connection when the human returns so the account
binding is persisted server-side. Mint a fresh link when a previous request has
expired or was abandoned.

Use `kortix connectors connect-finalize <slug>` when the flow requires an
explicit completion check.

**A connector can hold more than one account. `connect` adds one.** In the
Kortix web app the link opens a dialog where the human:

- names the new account — prefilled from your `label`, so pass one that tells
  it apart from the others ("Dad's Gmail", "Support inbox"), never `me`,
  `project`, or an id;
- chooses who can use it: only them, everyone in the project, or chosen people
  or groups. `owner: "project"` only preselects "everyone"; the human decides.
  A shared account must still be authorized as the project identity (see the
  ownership rules above);
- signs in with the provider in a new window.

When it lands you are told the account's name. Pass it as `account` on every
call (`kortix connectors call <slug> <action> --account "<name>"`): a connector
with several accounts refuses an unnamed call with `account_required`. If the
human just wants to USE an account the connector already has, do not mint a
link — list them with `accounts` and pass `account` on the call.

---

## How to write the links in your reply

The web app turns every setup link into a card that already shows the app's
logo, its name, the project, and a Connect button. Give each link its own line
and let the card do the talking:

```
I need two apps connected for the report:

https://<app>/connect/ksl_…
https://<app>/connect/ksl_…
```

- **Never put setup links in a table.** An `App | Link` table repeats what the
  card already says. The web app lifts such links out of a table or list, but a
  table with extra columns stays a table and the link shrinks to an inline chip.
- One line of "what this is for" above the links is enough. Do not restate the
  app name next to each link.
- In Slack or Telegram the same lines are tappable URLs, so this format works
  everywhere.

---

## After you surface the link

The smooth flow is:

1. Mint the link and surface it, with a one-line "what this is for".
2. **End your turn** — the human can't fill it in while you hold the turn.
3. When a **secret** is submitted while your session is running, the platform
   sends you a follow-up message naming the saved keys — treat it as your cue to
   verify and continue. If your session was asleep, or the human just says
   "done", **verify and continue**:
   - **Secret:** check the variable itself in a new shell (`[ -n "$NAME" ]`) or
     run `kortix secrets ls`. A fresh `runtime` value is live in the session env
     immediately (it's hot-synced; no restart needed). Do not use
     `KORTIX_PROJECT_SECRET_NAMES` for this: it is the list from session start
     and does not change when a value is hot-synced.
   - **Connector:** check it now appears in your usable catalog —
     `kortix connectors ls` (the `connectors` MCP tool). Unconnected connectors are
     filtered out, so its presence means the credential landed.

If it isn't there yet, the human may not have finished — say so and wait.

### "Set, but I can't see it" — the secret is not granted to you

Your session receives only the secrets in **your agent's `secrets` grant**. A
value outside it is saved and never delivered — no env var, no row in
`kortix secrets ls`. Never tell the human such a secret is unset. Kortix names
this case on every surface:

- `request_secret` / `kortix secrets request` return `withheld` (names you will
  not receive) and a ready-to-relay fix when you mint the link.
- The follow-up message after submission says which saved names are withheld.
- `kortix secrets ls` shows a declared key outside your grant as
  **`not granted`**, not `missing`, and says the list is limited to your grant.

You cannot widen your own grant. Tell the human the exact fix: **Customize →
Agents → `<your agent>` → Secrets → enable the secret** (or, from their own CLI,
`kortix secrets grant <NAME> --agent <your agent>`). Kortix pushes the change
to this session when it is saved. Run `kortix secrets sync` to pull it into
this session right away, then continue.

### A person's own credential — who can use it

Every secret value has an audience, the same **Who can use it** choice as a
connector account: everyone in the project (the default), only one person, or
chosen people, groups and agents. A value shared with a person reaches them
directly or in their own **private** session; a shared session, a trigger, a
schedule, and another member's session never get it. A value shared with an
**agent** reaches every session of that agent, triggers included — the right
choice for a credential an unattended run needs.

You cannot set or change the audience (`403`); a person does. When a person
gives you a credential that acts as THEM or holds sensitive data (payroll, HR,
bank, a personal login), store it, then tell them the one-line fix:
*"It is usable by everyone in the project right now. To keep it to you, run
`kortix secrets share <NAME> --user me` or pick **Only you** in Customize →
Secrets."* Say it once; do not ask twice. When you mint a link for a personal
value, tell them the link page can keep it to them (**Only the person who
asked**). For a value only a trigger or schedule of one agent needs, suggest
`kortix secrets share <NAME> --agent <agent>`.

A session that holds a value shared only with its person cannot be shared
(`409 PERSONAL_SECRET_REQUIRES_PRIVATE_SESSION`): say so, and suggest a new
session to share.

### `credential_not_shared` — the value exists but not for this session

A connector call that returns `denied` / `credential_not_shared` found the
secret, and this session does not act for anyone in its audience. Never ask
for the value again and never tell the person it is missing. Say which case
it is: the session is shared, it is a trigger or schedule run, or the value is
shared with someone else. The fix is theirs: run in their own private
session, or share the value (`kortix secrets share <NAME> --everyone` for
something a trigger needs).

---

## Why this is safe (and why it's the only good way)

- The link is an **opaque, encrypted, single-project token** with a bounded TTL
  (default 7 days, adjust with `--expires` / `expires_in_minutes`, max 30 days).
- It is **value-only**: it can only *set* the exact key(s) you named, in *this*
  project. It can't read any existing secret and can't target another key — so a
  leaked link is low-blast-radius and expires on schedule.
- **The value skips the chat.** The human enters it directly into an
  encrypted store; for a connector, the provider authorization remains
  server-side.

This beats the alternatives you might be tempted by:

- ❌ "Paste your API key here" — when you have to ASK, ask with a link.
- ❌ "Go to the dashboard → Customize → Connectors → Connect" — the friction that
  makes the human give up. You have a one-click link; use it.
- ❌ Minting a link for a value already in the conversation — the human gave
  it to you. Store it with `set_secret`.

---

## Quick reference

| Goal | MCP tool | `kortix` CLI |
| --- | --- | --- |
| Store a secret value you already have | `set_secret` | `kortix secrets set <NAME>=- [--scope connector]` |
| Ask the human for a secret value you lack | `request_secret` | `kortix secrets request <NAME…>` |
| Get an app connected (Composio) | `connect` | `kortix connectors connect <slug> [--owner me\|project]` |
| Verify a secret arrived | — | `kortix secrets ls` (`not granted` = ask the human to enable it for your agent) |
| See who can use a value | — | `kortix secrets ls` (WHO CAN USE column; a person changes it with `kortix secrets share`) |
| Verify a connector connected | `connectors` | `kortix connectors ls` |
| Which/how many accounts are connected | `accounts` | `kortix connectors accounts <slug>` |
| Pin the default account for unnamed calls | — | `kortix connectors accounts <slug> --default <label>` |

Both surfaces hit the same endpoints and return the same kind of link — use
whichever fits your flow. The MCP tools are always loaded. The
`kortix connectors` CLI exposes the same connector gateway for shell use.
