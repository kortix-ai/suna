# Testing Kortix-as-a-Backend by hand

> **Runtime scope.** The OpenCode message and model steps below test the v2 REST
> compatibility path. A v3 project selects OpenCode, Claude Code, Codex, or Pi
> through its logical agent. Use
> `tests/e2e/scripts/acp-multi-harness-smoke.ts` for v3 harness acceptance.

A sit-down testing script. Every capability KaaB ships today, as a numbered
recipe: the exact command, and the exact result that means it worked.

Two vantage points, and the difference matters:

- **The Lumen demo UI** (`apps/whitelabel-demo`) — what a wrapper's *end-user*
  sees. Lumen holds ONE Kortix credential and fronts many users.
- **curl against the API** — what the *operator* sees. This is the only place
  you can look across end-users, because Lumen deliberately narrows every
  read to the signed-in one.

Several capabilities have **no UI at all** (the per-session `secrets` allowlist
is the big one). Those recipes are curl-only, and say so.

Reference docs, not this file, for the contract itself:
[`KORTIX_AS_A_BACKEND_GUIDE.md`](KORTIX_AS_A_BACKEND_GUIDE.md).

> **Which Lumen this describes.** Every UI claim below was read off committed
> code. A new-session dialog that chooses agent + secrets + per-connector
> bindings up front is **in flight in the working tree** (`new-session-dialog.tsx`,
> `connector-bindings.tsx`, `lib/session-overrides.ts`, `lib/session-scope.ts`).
> When that lands, the curl-only recipes in C and the "hardcoded to gmail" caveat
> in F stop being true — the platform behaviour they exercise does not change,
> only where you click. The curl recipes stay valid either way; run them if a
> UI result surprises you.

---

## Newly reachable from the UI (added after this guide's first draft)

Three surfaces moved out of curl-only and into the app. Each is listed again in
its own section below; this is the short index.

| Capability | Where | Note |
| --- | --- | --- |
| Secret lifecycle — create with a distinct `identifier`, rotate, delete | Settings → Secrets | The identifier/KEY distinction is now visible, and colliding KEYs are flagged BEFORE a create that would 409 |
| Connector-scoped secrets | Settings → Secrets | Marked, and excluded from the session allowlist — offering one causes `404 SECRET_IDENTIFIER_NOT_FOUND` at create |
| Spend by end-user | Usage | **Gated.** See the operator note below |
| Your own spend | Usage | Always visible to the signed-in user |
| Idempotency replay | Usage | Re-sends the same key and shows replay vs `409 IDEMPOTENCY_*_CONFLICT` |
| Cap behaviour | Usage | Surfaces `per_origin_session_limit` / `per_end_user_spend_limit` with their real codes |
| Approvals (`require_approval`) | Session workbench | Approve/deny; `403 APPROVAL_REQUIRES_HUMAN` renders its actual meaning |
| End-user isolation | Session workbench + `/projects/{id}/sessions` | Shows which end-user this browser acts as |

### The one switch you need for the usage breakdown

The per-end-user breakdown names other end-users and prices them, so returning it
to any signed-in user would let one customer read every other customer's id and
spend. It is **default-deny**: with nothing configured you see only your own
spend, and the breakdown panel stays empty.

To see it while testing, opt yourself in:

```bash
echo 'LUMEN_USAGE_SHOW_ACCOUNT_BREAKDOWN=1' >> apps/whitelabel-demo/.env.local
```

This is a **deployment** switch, not a per-user permission — deliberately. The
first version allowlisted operator emails, which reads like authorization and
is not: this demo's login accepts any email with any password, so the "operator
identity" is a string the visitor typed. Anyone wanting the breakdown could just
sign in as an allowlisted address. A deployment flag states the real condition
("this instance is a single-tenant demo") and cannot be bypassed by choosing a
different email.

Restart after changing it (`pnpm dev` picks up `.env.local` on boot, not per
request).

---

## A. Setup — Lumen in wrapper mode against dev

### A1. Get an ACCOUNT-scoped API key

Dashboard → **Settings → Tokens → Create API key**. Do **not** use a
project-scoped token.

Verify before you go further:

```bash
export KORTIX_API_KEY=kortix_pat_...
curl -s -o /dev/null -w '%{http_code}\n' \
  https://dev-api.kortix.com/v1/projects \
  -H "Authorization: Bearer $KORTIX_API_KEY"
```

- `200` → account-scoped. Good.
- `403` → project-scoped. The body reads
  `{"message":"Project-scoped token cannot list projects"}`
  (`apps/api/src/middleware/auth.ts:737`).

**Why this one matters more than it looks.** Lumen's home page lists projects
through `GET /projects`. With a project-scoped key that call 403s, and the UI
renders *"Couldn't load projects — try signing in again"*
(`apps/whitelabel-demo/src/app/page.tsx:126`). Signing in again cannot possibly
fix it. If the project list is broken, check the key's scope first.

### A2. Write `.env.local`

`apps/whitelabel-demo/.env.local`:

```dotenv
KORTIX_API_KEY=kortix_pat_...
KORTIX_UPSTREAM=https://dev-api.kortix.com/v1
KORTIX_API_URL=https://dev-api.kortix.com/v1
SESSION_SECRET=any-long-random-string
# optional
# DEMO_PASSWORD=
COST_MARKUP=1.2
```

**Set BOTH upstream variables to the same value.** They are not aliases:

| Route | Reads |
|---|---|
| `/api/kortix/*` (the BFF proxy), `/api/usage`, `/api/preview-url` | `KORTIX_UPSTREAM` |
| `/api/connections` (the connector picker), `/api/session-model` | `KORTIX_API_URL` |

`/api/connections` and `/api/session-model` fall back to
`https://api.kortix.com/v1` — **production** — when `KORTIX_API_URL` is unset
(`src/app/api/connections/route.ts:36`, `src/app/api/session-model/route.ts:23`).
Set only `KORTIX_UPSTREAM` and the connector picker and the model switcher
silently talk to the wrong deployment while everything else talks to dev.

### A3. Build and start

```bash
cd apps/whitelabel-demo
lsof -ti :3010 | xargs -r kill      # gotcha 1, below
rm -rf .next                         # gotcha 2, below
pnpm build
WHITELABEL_PORT=3010 pnpm start
```

**Gotcha 1 — a stale process on the port keeps answering.** `next start` fails
with `EADDRINUSE` when 3010 is taken, and if you miss that line in the scroll,
every curl you run afterwards hits the *old* server and you will spend an hour
testing code you did not build. Kill the port first, every time.

**Gotcha 2 — the e2e harness skips the build when `.next/BUILD_ID` exists.**
So does your muscle memory. After any source change, `rm -rf .next`. This has
already burned us once.

### A4. Verify wrapper mode is on

```bash
curl -s localhost:3010/api/mode
```

Expected, exactly:

```json
{"wrapperMode":true}
```

`{"wrapperMode":false}` means `KORTIX_API_KEY` was not visible to the server
process — Lumen is in direct mode and none of the rest of this guide applies.

### A5. Log in

Open <http://localhost:3010> and sign in with **any email-shaped string and any
non-empty password**. There is no user directory; the email *is* the user id
(`src/server/auth.ts#checkDemoCredentials`). Set `DEMO_PASSWORD` in `.env.local`
to require one specific password instead.

For curl, mint a token the same way the browser does:

```bash
export LUMEN=http://localhost:3010
export TOKEN_A=$(curl -s -X POST $LUMEN/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"x"}' | jq -r .token)

curl -s $LUMEN/api/auth/me -H "Authorization: Bearer $TOKEN_A"
```

Expected: `{"userId":"alice@example.com"}`. Note the email is **lowercased** —
that lowercased string is the `end_user_ref` for everything that follows.

### A6. Create a project, and know where ownership lives

Click **New project** in the UI (this hits `POST /projects/provision`).

Lumen's whole isolation model is a JSON file: `.lumen-data/users.json` under the
app's cwd, mapping login email → the project ids that user provisioned
(`src/server/users.ts`). A user who does not own a project id gets `403` from
the proxy for every route under it.

That file is also your test rig. To put **two** logins on the **same** project
(needed for the connector and isolation recipes), stop the server and edit it:

```json
{
  "alice@example.com": ["<project-uuid>"],
  "bob@example.com":   ["<project-uuid>"]
}
```

Restart. This is a demo store, not a security boundary — it is meant to be
edited by hand.

Export the ids you will reuse:

```bash
export API=https://dev-api.kortix.com/v1
export PROJECT_ID=<project-uuid>
```

---

## B. The usage label (`end_user_ref`)

### B1. What it is, and why the browser cannot set it

In wrapper mode every upstream call carries **one** credential — Lumen's
`KORTIX_API_KEY`. Upstream therefore cannot tell Lumen's users apart on its own.
`end_user_ref` is how Lumen tells it, and it drives per-end-user usage
attribution, idempotency-replay protection, the per-end-user session filter, and
the optional caps in section H.

Lumen injects it **server-side** in the BFF proxy, from the verified session
token (`src/server/end-user.ts`). The browser cannot supply it. A client that
could set it could:

- **bill another user** — every usage row for the session is attributed to the
  string it sent; and
- **replay another user's session** — session create is idempotent on
  `Idempotency-Key`, so a shared key under a *different* end-user would hand the
  original session back to the wrong person. (Upstream refuses that pairing with
  `409 IDEMPOTENCY_ORIGIN_CONFLICT`, but the wrapper must not be the thing
  offering the attempt.)

A browser that *names somebody else* is rejected rather than silently corrected,
so the attempt surfaces instead of looking like it worked:

```bash
curl -s -X POST "$LUMEN/api/kortix/projects/$PROJECT_ID/sessions" \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"end_user_ref":"bob@example.com"}'
```

Expected: HTTP `403`, body
`{"error":"end_user_ref must not be set by the client — it is derived from your session"}`.

Echoing your *own* id is fine (it agrees) and passes through.

### B2. Produce spend under two labels

Sign in as `alice@example.com` in one browser profile and `bob@example.com` in
another (or just use two `TOKEN_*` values plus the UI once each). Start a
session as each and run **one real turn** — a turn, not just a session create;
usage rows come from model calls.

### B3. Read the spend back, grouped

```bash
curl -s "$API/usage?group_by=end_user_ref" \
  -H "Authorization: Bearer $KORTIX_API_KEY" | jq .
```

Expected: `data` (account totals) plus a `breakdown` array with one entry per
end-user. Each entry carries **both** spellings with the same value:

```json
{
  "end_user_ref": "alice@example.com",
  "origin_ref":   "alice@example.com",
  "input_tokens": 1234, "output_tokens": 567, "cost": 0.0181, "count": 2
}
```

Rows with no `end_user_ref` (ordinary dashboard sessions) are excluded from this
grouping — that is deliberate, not a gap.

### B4. Narrow to one end-user

```bash
curl -s "$API/usage?end_user_ref=alice@example.com" \
  -H "Authorization: Bearer $KORTIX_API_KEY" | jq .data
```

Expected: `data` shows **Alice's** totals, not the account's. The filter applies
to the totals, not just the breakdown — a wrapper asking for one user's spend
never gets account-wide numbers back (`router/routes/usage.ts`).

### B5. List one end-user's sessions

```bash
curl -s "$API/projects/$PROJECT_ID/sessions?end_user_ref=alice@example.com" \
  -H "Authorization: Bearer $KORTIX_API_KEY" | jq '.[] | {session_id, end_user_ref, agent_name, status}'
```

Expected: only Alice's sessions. The filter is applied **in the SQL**, not after
— you are not pulling the whole project and filtering client-side.

### B6. The deprecated spelling, and the 400

`origin_ref` still works everywhere `end_user_ref` does, and is echoed back with
the same value:

```bash
curl -s "$API/usage?group_by=origin_ref" -H "Authorization: Bearer $KORTIX_API_KEY" | jq '.breakdown[0]'
```

Sending **both with different values** is a `400`, on session create, on the
session list, and on usage:

```bash
curl -s "$API/usage?end_user_ref=alice@example.com&origin_ref=bob@example.com" \
  -H "Authorization: Bearer $KORTIX_API_KEY"
```

Expected: HTTP `400`, message
`end_user_ref and its deprecated alias origin_ref disagree — send only end_user_ref`.
On session create/list the same conflict comes back as
`{"code":"END_USER_REF_CONFLICT"}`. Picking a winner would misattribute every
usage row for that session, so nothing picks one.

### B7. What Lumen's own `/usage` page shows

`http://localhost:3010/usage` shows **your own line only**. `/api/usage`
narrows the rollup to the caller (`endUserRef: session.userId`) on purpose: the
account-wide rollup would otherwise let any signed-in Lumen user read every
other end-user's id and spend from the main nav. A real operator dashboard would
gate the unnarrowed view behind an operator role; the demo has no such role.

**So: cross-user comparison is a curl-with-the-API-key exercise (B3), not a UI
one.** That is the correct product behaviour, not a missing feature.

---

## C. Secrets — the per-session allowlist

**No UI exists for the allowlist** in committed code — secrets CRUD has one,
narrowing a session to a subset of them does not, so recipes C3 onward are curl.
(A new-session dialog that offers the allowlist is in flight; see the note at the
top. The curl recipes exercise the same create body either way.)

### C1. Add two secrets

Project → **Settings → Secrets**. Add:

| Name | Value |
|---|---|
| `ALPHA_KEY` | `alpha-value` |
| `BETA_KEY` | `beta-value` |

The name is uppercased and must be a valid env var name. `KORTIX_*` is reserved
(`400`). The **identifier** — the handle a grant and an allowlist reference —
defaults to the name.

### C2. Confirm they exist

```bash
curl -s "$API/projects/$PROJECT_ID/secrets" \
  -H "Authorization: Bearer $KORTIX_API_KEY" | jq '.items[] | {identifier, name, configured}'
```

Values are never returned. Expected: `ALPHA_KEY` and `BETA_KEY`.

### C3. Start a session narrowed to a subset

Through Lumen's proxy, so `end_user_ref` is stamped for you:

```bash
curl -s -X POST "$LUMEN/api/kortix/projects/$PROJECT_ID/sessions" \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"secrets":["ALPHA_KEY"]}' | jq '{session_id, end_user_ref, secrets_allowlist}'
```

Expected:

```json
{
  "session_id": "…",
  "end_user_ref": "alice@example.com",
  "secrets_allowlist": ["ALPHA_KEY"]
}
```

`secrets_allowlist` echoing back is the proof it was accepted. If it is `null`,
the field did not take.

It is a **pure narrowing**: the sandbox receives *(the agent's `secrets` grant)
∩ (your allowlist)*. It can never widen. `[]` means zero project secrets. Omit
the field entirely and the agent's normal set applies.

> `secrets` is backend-only. Sending it from a non-backend caller (a human web
> session, an in-sandbox agent token) is `403 origin_override_forbidden`. It
> works here because Lumen forwards under an API key, which resolves to
> `origin: backend`.

### C4. Prove it inside the sandbox

```bash
export SESSION_ID=<from C3>
curl -s -X POST "$LUMEN/api/kortix/projects/$PROJECT_ID/sessions/$SESSION_ID/start" \
  -H "Authorization: Bearer $TOKEN_A" | jq '{stage, agent_name, retriable}'
```

Poll it until `stage` reports the runtime is up — a cold sandbox takes tens of
seconds. `retriable: false` means it is terminal and polling will not help.

Then open the session in the UI and ask the agent, in chat:

> Run `echo "$KORTIX_PROJECT_SECRET_NAMES"` and `env | cut -d= -f1 | sort` and
> paste the output. Do not print any values.

Expected: `KORTIX_PROJECT_SECRET_NAMES` contains `ALPHA_KEY` and **not**
`BETA_KEY`, and the env-name list agrees. Ask for names only — the values are
genuinely there (see the last section), and there is no reason to put them in a
transcript.

Repeat C3 with `"secrets":[]` and the same probe: expected, neither name is
present.

### C5. The two create-time validations

```bash
# unknown identifier
curl -s -X POST "$LUMEN/api/kortix/projects/$PROJECT_ID/sessions" \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"secrets":["NOPE_KEY"]}'
```

Expected: HTTP `404`, `{"code":"SECRET_IDENTIFIER_NOT_FOUND", …}` naming the
missing identifier. A typo fails fast rather than silently injecting nothing.

If two allowlisted identifiers resolve to the **same env KEY**, create fails
`409 SECRET_IDENTIFIER_KEY_COLLISION`. This is checked at create precisely
*because* the allowlist is immutable — an ambiguous grant would throw at boot
and leave the session permanently unbootable with no way to fix it.

### C6. Re-scope it mid-session

`PUT /v1/projects/{projectId}/sessions/{sessionId}/scope` — **SET semantics**.
What you send replaces the current list, from the next prompt.

```bash
curl -sS -X PUT "$KORTIX_API_URL/projects/$PROJECT_ID/sessions/$SESSION_ID/scope" \
  -H "Authorization: Bearer $KORTIX_API_KEY" -H 'Content-Type: application/json' \
  -d '{"secrets":["TEST_KEY_2"]}'
```

Start the session with `["TEST_KEY_1","TEST_KEY_2"]`, run the `env | grep` check
from C5, send the call above, prompt again, and re-run the check: `TEST_KEY_1`
is gone from a **newly spawned** shell.

**Read the response before you believe it revoked anything.** It carries
`retroactive`, and for a dropped secret that is `false`:

- Forward it is exact — the next prompt's push carries only the new set, and the
  daemon clears the names it previously knew.
- Backward it promises nothing — the value the agent already read is still in its
  context, and in any shell it started *before* the call. `env` in a shell that
  was already open will still show it.

**If you need real revocation, rotate the secret.** Re-scoping stops delivery; it
does not unsay a value. A UI that reported this as "revoked" would be false
assurance, which is why Lumen shows the `detail` string instead.

`[]` and `null` are opposite: `[]` is "no project secrets at all", `null` is
"stop narrowing, fall back to the agent's grant". Omit the key to leave secrets
untouched.

The agent's manifest grant is still the ceiling — `403 NOT_IN_AGENT_GRANT` if you
name something outside it. Narrowing is not a ratchet: you can restore anything
inside the grant.

**In Lumen:** session workbench → the scope bar under the composer → **Secrets**.
It is editable now, and the `</> The API call` disclosure beside it shows the
exact request.

### C7. Re-scope the connectors the same way

```bash
curl -sS -X PUT "$KORTIX_API_URL/projects/$PROJECT_ID/sessions/$SESSION_ID/scope" \
  -H "Authorization: Bearer $KORTIX_API_KEY" -H 'Content-Type: application/json' \
  -d '{"connector_bindings":{"gmail":{"profile_id":"'"$PROFILE_ID"'"}}}'
```

Same set semantics — an alias you omit is unbound and falls back to the project
default. Unlike secrets this **is** fully retroactive: a binding is resolved
server-side on each tool call, so the next call already uses the new one.

Binding authorization is the same as at create: `403` for a profile you may not
use, including another end-user's. That is deliberate — re-scoping must not be a
weaker second door to the same table.

---

## D. Agent — switching per message

### D1. Prerequisite: a manifest where the switch means something

**Do this first or the whole recipe is a no-op.** If both agents have the same
grants, every switch is legal and proves nothing. Commit a `kortix.yaml` on the
project's default branch with two agents whose grants genuinely differ:

```yaml
kortix_version: 2
default_agent: kortix

agents:
  kortix:
    connectors: all
    secrets: all
    kortix_cli: all
    skills: all

  # Same SECRETS as narrow-b, different CONNECTORS → switching is ALLOWED
  # and re-mints the token onto this agent's connector/CLI grant.
  narrow-a:
    secrets: [ALPHA_KEY]
    connectors: [github]

  # Different SECRETS from narrow-a → switching is REFUSED.
  narrow-b:
    secrets: [BETA_KEY]
    connectors: [github]
```

Each agent also needs its behaviour file at
`.kortix/opencode/agents/<name>.md` — the manifest map is governance only.
Grants are read from the **default branch**, so this must be merged, not just
pushed to a side branch.

v2 is deny-by-default: an agent declared without a `secrets:` key gets none.
Note also that `secrets: all` and *no `secrets:` key at all* are the **same**
authority downstream and compare equal — so a switch between two agents that
both omit `secrets:` is a free switch, not a mismatch.

### D2. The allowed switch (same secrets, different connectors)

Start a session on `narrow-a`:

```bash
curl -s -X POST "$LUMEN/api/kortix/projects/$PROJECT_ID/sessions" \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"agent_name":"narrow-a"}' | jq '{session_id, agent_name}'
```

Open it in the UI, then use the **agent picker in the composer** to pick an
agent with the *same* `secrets:` list but a different `connectors:` list, and
send a message.

Expected: the message runs. Behind it, the session's executor token is
**re-minted** onto the new agent's connector and CLI grant. That re-mint is the
point — without it the new agent would run against the *old* agent's connector
grant, calling integrations its own manifest denies it.

If the re-mint itself fails you get `503 AGENT_SWITCH_GRANT_UNAPPLIED`. That one
**is** retryable: the sandbox is fine, only the re-scope failed, and forwarding
the prompt anyway is exactly the escalation the re-mint closes.

### D3. The refused switch (different secrets)

Same session (`narrow-a`), now switch to `narrow-b` and send.

Expected: the turn is refused with HTTP `409`:

```json
{
  "error": "agent switch requires a new session",
  "code": "AGENT_SWITCH_REQUIRES_NEW_SESSION",
  "expected_agent": "narrow-a",
  "requested_agent": "narrow-b"
}
```

**Retrying cannot succeed.** Retrying with the same agent will 409 identically,
forever. The only resolution is a new session started on `narrow-b`. Secrets are
disclosed by the time a switch is observed, so re-scoping now cannot un-read
them — which is why this refuses where connectors merely re-mint.

### D4. Reading the code in the UI

Lumen classifies this correctly in `src/lib/mid-session-change.ts`
(`classifyAgentSwitch` → `needs_new_session`, "offer a new session, not a
retry"), but that helper **is not wired into any component today**. What you will
actually see in the workbench is the generic send-failure banner — *"The agent
could not run that"* — with the server's message underneath.

So read the exact code from **DevTools → Network**, or reproduce it against the
SDK. Do not conclude from the banner alone that it was a different failure.

### D5. The `default` sentinel is non-binding, both ways

A session stored as `default`, or a prompt naming `default`, never counts as a
switch. The client resolves "the default" to a concrete name for display and
echoes it back on later turns; comparing that echo against the stored sentinel
used to 409 the most ordinary flow there is. If you see a switch refusal on a
session you never switched, check whether the session's `agent_name` is
`default`.

---

## E. Model — changing it mid-session

### E1. In the UI

Open a session; the **model switcher** sits in the session header. Change it.
The runtime restarts, which ends the in-flight turn — expected, not a bug.

### E2. Through Lumen's route

Lumen's `/api/session-model` is the provider-neutral seam: the browser speaks
`{ model }` and the runtime's field name stays server-side.

```bash
curl -s -X PUT \
  "$LUMEN/api/session-model?projectId=$PROJECT_ID&sessionId=$SESSION_ID" \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' \
  -d '{"model":"kortix/claude-opus-4-8"}'
```

Expected: `{"model":"kortix/claude-opus-4-8","appliedLive":true}` on a live
session.

### E3. Directly upstream

```bash
curl -s -X PUT "$API/projects/$PROJECT_ID/sessions/$SESSION_ID/model" \
  -H "Authorization: Bearer $KORTIX_API_KEY" -H 'Content-Type: application/json' \
  -d '{"opencode_model":"kortix/claude-opus-4-8"}' | jq .
```

Expected: `{"opencode_model": "...", "applied_live": true|false, "detail": "..."}`.

### E4. Read `applied_live` — it is the whole point of the endpoint

`applied_live: false` means **stored, but the running box did not take it — it
applies at the next start.** These are genuinely different outcomes and the
caller cannot otherwise tell them apart, which is why `detail` says which:

| `applied_live` | `detail` | What it means |
|---|---|---|
| `true` | *(absent)* | The live sandbox took it now. |
| `false` | `already set to this model` | No change was needed. |
| `false` | `stored — applies when the sandbox next starts` | The session has no live box (not started yet, or stopped). |
| `false` | `stored, but not pushed: <reason>` | There was a live box and the push failed. |

Any UI showing this must **say** "applies at next start" for the false cases.
Reporting a bare success is a lie the user discovers one turn later.

### E5. The two refusals

- Terminal session → `409 SESSION_NOT_RUNNING`. Nothing would consume the value.
- Model not servable for the account (retired, not entitled, typo) →
  `400 INVALID_SESSION_MODEL`. Validated against the same resolver session
  create uses, so a bad model fails here rather than as a dead turn later.

Use `kortix/<id>` for managed models; `<provider>/<id>` for bring-your-own-key.

---

## F. Connectors — binding a session to a specific connection

### F1. See what exists

```bash
curl -s "$API/projects/$PROJECT_ID/connector-profiles" \
  -H "Authorization: Bearer $KORTIX_API_KEY" \
  | jq '.profiles[] | {label, connector_alias, owner_type, status, is_default, profile_id}'
```

`owner_type` is the field that decides everything below:

- `project` → **team-shared**. A wrapper may bind it.
- `member` → somebody's **private** connection. A wrapper may not.
- `external` → owned by *your app's* end-user, minted by your backend.

Lumen's picker shows only `owner_type: "project"` **and** `status: "active"`,
default first (`src/server/bindable-connections.ts`). Offering anything else
would produce a session-create failure the end-user cannot act on.

### F2. Nobody has connected gmail yet

Open a project page in Lumen. The connection picker offers only **Default** —
Lumen queried `/api/connections?connector=gmail` and got nothing bindable.

Now try to make the wrapper connect on the user's behalf. It cannot, and the
refusal is explicit:

```bash
curl -s -X POST "$API/projects/$PROJECT_ID/sessions" \
  -H "Authorization: Bearer $KORTIX_API_KEY" -H 'Content-Type: application/json' \
  -d '{"require_connectors":["gmail"]}'
```

Expected: HTTP `403`

```json
{
  "error": "require_connectors is interactive-only — a backend/service-account session has no single current user; use connector_bindings instead",
  "code": "REQUIRE_CONNECTORS_INTERACTIVE_ONLY"
}
```

**A wrapper credential acts for no single person.** `require_connectors` means
"resolve *the current user's own* connection", and there is no current user
behind an API key fronting a thousand of them. Lumen never sends this field; the
curl above is how you see the platform enforce it.

### F3. A team connection exists — now it is bindable

`owner_type` is chosen when the profile is **created** and there is no
convert-a-private-one-to-team flip. A private connection stays private:
`POST …/connector-profiles/me` always mints `owner_type: "member"`. A **team**
connection is a separate profile created through the manager-gated route:

```bash
# 1. mint the TEAM profile (no owner_id — it belongs to the whole project)
curl -s -X POST "$API/projects/$PROJECT_ID/connector-profiles" \
  -H "Authorization: Bearer $KORTIX_API_KEY" -H 'Content-Type: application/json' \
  -d '{"connector_alias":"gmail","owner_type":"project","label":"Support inbox"}' | jq .
```

Then a human authorizes it once. For an OAuth connector like Gmail
(`provider: pipedream`) that is `…/connect` → consent in the browser →
`…/connect/finalize`; for a static-credential connector it is
`…/credential` → `…/activate`. Both flows, with runnable SDK snippets, are in
[`KORTIX_AS_A_BACKEND_GUIDE.md` §3](KORTIX_AS_A_BACKEND_GUIDE.md).

> Creating and authorizing profiles needs `project.connector_profiles.manage`,
> which is **manager-only**. As an editor, `reconcile` 403s and
> `credential`/`activate` return `404` — deliberately indistinguishable from
> "no such profile". If you are chasing a phantom missing-id bug here, check the
> role first.

Re-run F1. Expected: the profile reads `owner_type: "project"`,
`status: "active"`.

Reload the Lumen project page. Expected: the connection now appears in the
picker by label, with the project default pre-selected. Pick it and start a
session.

Lumen sends (`src/app/projects/[id]/page.tsx`):

```json
{ "connector_bindings": { "gmail": { "profile_id": "<the id you picked>" } } }
```

Expected: the session runs **as that connection**. The credential is resolved
server-side by the broker at tool-call time and never enters the sandbox env.

Two things to know before you read too much into a green run:

- **The alias is hardcoded to `gmail`** in the demo's project page, and this
  path only runs for the **first** session started from the project page. Every
  other session Lumen creates (`src/components/project-shell.tsx`) sends only
  `{ session_id }` — no agent, no bindings, no secrets. So a second session
  started from the sidebar silently loses the binding you picked. (Both are what
  the in-flight new-session dialog exists to fix — see the note at the top. Until
  it lands, bind by curl if you need it on a later session.)
- **All-or-nothing binding.** If a session binds *any* alias, every *unbound*
  alias resolves to null for that session. Pass `inherit_unbound: true` to keep
  the project-default fallback for the rest. It can only ever inherit the
  project default, never another owner's profile, so it is safe for any caller.

### F4. The error table — and what to actually do

| Status | Code | What happened | What to do |
|---|---|---|---|
| `403` | `CONNECTOR_NOT_ASSIGNED` | The session's **agent** is not granted the alias you bound. The first error most wrappers hit. | Add the alias under that agent's `connectors:` in `kortix.yaml` on the default branch. In a v2 manifest an agent with no `connectors:` key gets **none**. |
| `409` | `CONNECTOR_CONNECTION_REQUIRED` | Interactive path: the acting user has not connected their own account for a required connector. The body names the `connector` so you can prompt for exactly that one. | Prompt *that* user to connect. A wrapper cannot do it for them — see F2. Lumen surfaces this as the "Connect *X* to continue" prompt. |
| `403` | `REQUIRE_CONNECTORS_INTERACTIVE_ONLY` | A backend caller used `require_connectors`. | Bind an explicit `profile_id` with `connector_bindings` instead. |
| `404` | `CONNECTOR_PROFILE_NOT_FOUND` | The `profile_id` does not exist **or** it is somebody's `member`-private connection, which your credential may not bind. Deliberately indistinguishable, so an id cannot be used to probe who connected what. | Re-list profiles (F1) and bind one with `owner_type: "project"` or `"external"`. If a backend needs a particular mailbox, add it as a **team** connection. Also check your role: profile management is manager-only. |
| `409` | `CONNECTOR_PROFILE_INACTIVE` | The bound connection is revoked or errored. | Reconnect it. A revoked profile fails **closed** — it never silently falls back to a shared default, mid-session included. |

---

## G. Isolation between end-users

### G1. In the browser

Sign in as `alice@example.com` in one browser profile and `bob@example.com` in
another (a private window is enough). Start a session as each.

Expected: each sees only their own sessions in the project's session list, even
though both are the same Kortix project under the same Kortix credential.

### G2. Prove the filter is server-side, not client-side

The session list is scoped in the BFF proxy, not in the browser
(`src/server/end-user.ts#scopeSessionListToEndUser`). Upstream would happily
list every session in the project — it sees one wrapper credential and cannot
tell Lumen's users apart — so passing the browser's query string through
unchanged would show everyone everything.

Ask, as Alice, for Bob's sessions:

```bash
curl -s "$LUMEN/api/kortix/projects/$PROJECT_ID/sessions?end_user_ref=bob@example.com" \
  -H "Authorization: Bearer $TOKEN_A"
```

Expected: HTTP `403`,
`{"error":"end_user_ref must not be set by the client — it is derived from your session"}`.
Rejected rather than quietly corrected, so the attempt surfaces instead of
looking like it worked.

Now ask for nothing at all:

```bash
curl -s "$LUMEN/api/kortix/projects/$PROJECT_ID/sessions" \
  -H "Authorization: Bearer $TOKEN_A" | jq '[.[] | .end_user_ref] | unique'
```

Expected: `["alice@example.com"]`. The proxy stamped the filter for you.

### G3. The operator vantage

The same list with the account API key shows **both**, which is correct — the
operator owns the account:

```bash
curl -s "$API/projects/$PROJECT_ID/sessions" \
  -H "Authorization: Bearer $KORTIX_API_KEY" | jq '[.[] | .end_user_ref] | unique'
```

Expected: `["alice@example.com","bob@example.com"]`.

### G4. Project-level isolation is separate

Section B/G isolation is per-**end-user within a project**. Lumen *also* isolates
per-**project**: a user only sees projects they provisioned through the wrapper
(`.lumen-data/users.json`, A6). Sign in as a third email and the project list is
empty — a `403` from the policy table, not a filtered view.

---

## H. Caps

Both caps are **off by default** and are set on the **API deployment**, not in
Lumen. Exact spellings from `apps/api/src/config.ts:573-577`:

| Variable | Default | Effect |
|---|---|---|
| `KORTIX_BACKEND_PER_ORIGIN_SESSION_LIMIT` | `0` (off) | Max **live** sessions one end-user may hold. |
| `KORTIX_BACKEND_PER_END_USER_SPEND_LIMIT_USD` | `0` (off) | Spend ceiling per end-user, in USD, over a rolling window. |
| `KORTIX_BACKEND_PER_END_USER_SPEND_WINDOW_DAYS` | `30` | The window the ceiling is measured over. |

Note the window variable is `…_SPEND_WINDOW_DAYS`, not `…_SPEND_LIMIT_WINDOW_DAYS`.

### H1. Trip the concurrency cap

Set `KORTIX_BACKEND_PER_ORIGIN_SESSION_LIMIT=1` on the API and restart it. As
Alice, start one session, leave it running, and start a second:

```bash
curl -si -X POST "$LUMEN/api/kortix/projects/$PROJECT_ID/sessions" \
  -H "Authorization: Bearer $TOKEN_A" -H 'Content-Type: application/json' -d '{}'
```

Use `-i`: the interesting part is in the headers, and the proxy passes upstream
response headers straight through. Expected: HTTP `429`, headers
`X-RateLimit-Limit: 1` and `X-RateLimit-Remaining: 0`, body:

```json
{
  "error": "This end-user already has 1 active session (limit 1). Finish or stop one before starting another.",
  "message": "…",
  "code": "per_origin_session_limit",
  "limit": 1,
  "active_sessions": 1
}
```

In Lumen this surfaces as **"Too many sessions at once"**, marked *retryable* —
correctly, since stopping a session clears it
(`src/lib/session-create-failure.ts`).

### H2. Trip the spend cap

Set `KORTIX_BACKEND_PER_END_USER_SPEND_LIMIT_USD` to just under what Alice has
already spent in the window (read it from B4), restart the API, and create a
session as Alice.

Expected: HTTP `429`, body:

```json
{
  "error": "This end-user has spent $12.50 in the last 30 days (limit $10.00). Raise the limit or wait for the window to roll.",
  "code": "per_end_user_spend_limit",
  "limit_usd": 10, "spent_usd": 12.5, "window_days": 30
}
```

The comparison is `spent >= limit`, so an end-user exactly at the ceiling is
refused rather than allowed-then-exceeded. Lumen shows **"Spending limit
reached"**, marked *not* retryable, and passes the server's own numbers through
rather than inventing a vaguer message.

Sessions with **no** `end_user_ref` (ordinary dashboard sessions) are exempt from
both caps — there is nobody to charge, and applying the account's total spend to
them would refuse normal work.

### H3. The honest caveat — read this before building on either

Both are **check-then-act guardrails measured at session CREATE**, not hard
quotas:

- **Racy.** N parallel creates for one end-user can each observe the same
  under-limit state and all pass. Treat them as protection against a runaway
  loop, not as a billing boundary.
- **Create-time only.** A session already running is not killed mid-turn when it
  crosses the line. The *next* create is what gets refused.

The code says this about itself, in both files, on purpose: "a wrapper that
believes this is a hard quota will build the wrong thing on top of it."

---

## What you cannot test yet

### Secret DELIVERY strategy (the env-var refactor) is not wired

Designed, with a pure policy layer merged — and **not connected to anything**.
Today every granted secret still enters the sandbox environment exactly as it
always has: readable by any command the agent runs, present in the box's env
file and in every shell the agent spawned, and re-pushed on every prompt.

The LLM gateway's deny-list narrows what **OpenCode** sees, to protect gateway
routing (spend, budgets, logs) — not what the **box** holds.

So there is no per-secret delivery mode to test, and no test that would
distinguish "delivered as env" from anything else, because env is the only
delivery there is. The measured baseline, anchored line-by-line to code on
`main`, is [`ENV_SECRET_EXPOSURE_BASELINE.md`](ENV_SECRET_EXPOSURE_BASELINE.md);
the design is [`SECRET_DELIVERY_STRATEGY_PLAN.md`](SECRET_DELIVERY_STRATEGY_PLAN.md).

What you *can* test today is which secrets are **present** (section C) — the
narrowing works and is enforced at both boot and hot-push. What you cannot test
is how they are handed over.

### Lumen's e2e suite proves Lumen, not the platform

```bash
cd apps/whitelabel-demo && pnpm test
```

runs the SDK boundary lint plus the bun tests in `tests/e2e`, which boot a real
`next start` against a **mock upstream** (`tests/e2e/mock-upstream.ts`).

That proves the demo **sends the right calls and handles the responses
correctly**. It does **not** prove the platform enforces anything — the mock
returns whatever the test tells it to. Green there and a green run of the
recipes above are two different claims. Only the recipes touch real enforcement.

(The harness skips the build when `.next/BUILD_ID` exists — `rm -rf .next` after
changing source, or you will test stale output.)

### Not covered here

- **Turn delivery by curl.** Prompts go through the sandbox proxy transport, not
  a plain REST route. Drive turns from the UI, or from the SDK — the runnable
  end-to-end wrapper is `packages/sdk/examples/09-kaab-backend-wrapper.ts`.
- **`AGENT_SWITCH_REQUIRES_NEW_SESSION` as UI copy.** The classifier exists and
  is tested; no component renders it yet (D4).
