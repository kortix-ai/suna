---
name: kortix-connectors
description: Use Kortix connectors to reach external systems from a session, an App, a Convex backend, or an external program. Use the `kortix connectors` CLI for agent work, `@kortix/sdk` for durable TypeScript workflows and for App, backend, and script code, and the hosted Kortix MCP server (`<api>/v1/mcp`) for an MCP client outside Kortix. Load this skill to inspect, add, connect, or call external tools without exposing third-party credentials to the sandbox, an App, or a backend.
---

<skill name="kortix-connectors">

<overview>
A **connector** defines tools against an external system. A connector is
**not** an account: one connector (e.g. Gmail) can hold several **accounts** —
each one SHARED with the whole project or PRIVATE to one member. A
**connector call** invokes one tool AS one account.

Use the **`kortix connectors` CLI** for normal agent work:

- `kortix connectors ls` lists connectors and actions (an `ACCOUNTS` column
  shows how many each holds).
- `kortix connectors discover "<intent>"` searches visible actions.
- `kortix connectors show <connector>.<action>` shows one input schema and risk.
- `kortix connectors accounts <slug>` lists the accounts a connector holds,
  default first — see **Choosing the account** below before your first call
  on a connector you have not used yet.
- `kortix connectors call <connector> <action> '<json>' [--account <label>]`
  invokes one action. Every successful result echoes `account`: say which one
  ran when it matters.
- `kortix connectors call … --reason "<what this does>"` tells the human what
  the call does if a policy holds it for approval. The approver sees it next
  to the real arguments. **Always pass it on a write whose args are only ids**
  — `send_draft` (say who it goes to, the subject, and the body), a delete (say
  what gets deleted), a merge. Without it the approver sees only `draft_id`.
  A gated call returns `approval_url`: share it, then stop the turn. The human's
  decision, and any message they add to it, arrives as your next prompt — a
  deny with a message is an instruction, not a dead end. In a Slack or Teams
  session Kortix posts an approval card in the thread itself
  (`approval_instructions` says so): do not repost the link, just stop.
- `kortix connectors call … --attach <file>` attaches a file (see **Attach
  files** below). Never put base64 in args.
- `kortix connectors call … --out <file>` writes the full JSON result to
  `<file>` and prints only `saved_to`, `bytes`, and `shape` (keys, array
  lengths, `pageInfo`). Use it for list and search calls; tool output above
  ~50 KB is truncated. Then query the file with `jq` or `bun`, never `cat`.
- `kortix connectors add`, `rm`, and `connect` manage connectors and connections.

Durable TypeScript workflows use **`@kortix/sdk`** and `createKortix`. Every
call runs through the connector gateway. The
gateway resolves credentials, enforces access and policy, invokes the upstream
system, and records an audit event. The sandbox carries `KORTIX_TOKEN`; it
does not carry raw third-party credentials.
</overview>

<when-to-load>
Load this skill when the user wants to:

- Act in an external app or API.
- Inspect available connectors, actions, or connected computers.
- Add or configure a connector or connection.
- Request connector credentials without exposing the value.
- Build a repeatable workflow that calls external systems.

Do not load it for work that stays inside the local repository or sandbox.
</when-to-load>

<choosing-the-account>
**A connector is not an account.** One connector (e.g. Gmail) can hold many
accounts — shared with the whole project, or private to one member. Never
assume "one connector, one account", and never infer which accounts exist
from a `get_profile`/`whoami`-style call: that only ever answers for the ONE
account it happened to run as. If a human asks which or how many accounts are
connected, list them — do not guess from a profile call.

Procedure, every time you call a connector you have not just listed accounts for:

1. **List the accounts:** `kortix connectors accounts <slug>` (default first;
   `(pinned default)` marks the one an unnamed call uses).
2. **One account** → just call. Nothing to choose.
3. **Several accounts, and the human named one** → pass
   `--account <label|id|me|project>` (`me` = your own private default,
   `project` = the shared default).
4. **Several accounts, and it is unclear which one** → ASK the human. Do not
   guess, and do not silently use the default — several real accounts exist
   and picking wrong sends the action to the wrong mailbox/workspace. If
   nothing is named and nothing is pinned, the call is refused anyway with
   reason `account_required` rather than guessing; a human can pin one going
   forward with `kortix connectors accounts <slug> --default <label>`.

Always report which account ran when it could matter — read it off the
result's `account` field, never assume.

**Worked example.** A project has one Gmail connector (`gmail-ffiod0`) with
two accounts:

```sh
$ kortix connectors accounts gmail-ffiod0

  LABEL                 OWNER    DEFAULT  CONNECTION ID
  personal@example.com  private  no       11111111-…
  work@example.com      private  no       22222222-…

  kortix connectors call gmail-ffiod0 <action> --account "personal@example.com"
  kortix connectors call gmail-ffiod0 <action> --account "work@example.com"
  kortix connectors call gmail-ffiod0 <action> --account me
  kortix connectors call gmail-ffiod0 <action> --account project

  2 accounts
  No default pinned — unnamed calls will be refused with account_required;
  pass --account or pin one: kortix connectors accounts gmail-ffiod0 --default <label>
```

Neither account is pinned, so — asked "check my gmail" with no account named —
the right move is to ASK which mailbox, not to call `get_profile` on whichever
account resolves first and report "one account connected". If the human says
"the work one", call with `--account "work@example.com"` and report: "Checked
work@example.com — …".

**Adding another account.** When the human wants a new one ("connect my other
Gmail"), mint a link with a `--label` that tells it apart:
`kortix connectors connect <slug> --label "Personal Gmail"`. The link opens a
dialog where the human names the account and chooses who can use it; you are
then told its name. Call it with `--account "<name>"` from then on.
</choosing-the-account>

<cli-first-loop>
Use the CLI first. It is pre-authenticated in a session sandbox.

1. List visible connectors:

```sh
kortix connectors ls
```

2. Search by intent:

```sh
kortix connectors discover "send an email"
```

3. Inspect one action before an unfamiliar call:

```sh
kortix connectors show email_email_inbox_bjgk.reply_message
```

4. Call the action:

```sh
kortix connectors call email_email_inbox_bjgk reply_message \
  '{"inbox_id":"agent@kortixmail.com","thread_id":"<thread-id>","message_id":"<message-id>","text":"Reply text"}'
```

**Attach files.** Write the file under `/workspace/artifacts` (or
`output`, `reports`, `deliverables`), put the JSON args in a file, and pass
`--attach`. The CLI stages the raw bytes and the gateway builds the
provider's attachment item (Microsoft Graph, SendGrid, Postmark, Mailjet,
Resend, Brevo, and the Email channel):

```sh
cat > /tmp/mail.json <<'JSON'
{"user":"sender@example.com","body":{"message":{"subject":"Report",
 "body":{"contentType":"Text","content":"Attached."},
 "toRecipients":[{"emailAddress":{"address":"to@example.com"}}]},
 "saveToSentItems":true}}
JSON
kortix connectors call microsoft-graph sendmail @/tmp/mail.json \
  --attach /workspace/artifacts/report.pdf
```

Leave the attachments array out of the JSON; `--attach` appends to it. For a
field the CLI cannot find, run `kortix connectors upload <file> --connector
<slug>` and put the printed `ref` (`{"$kortix_attachment":"<id>"}`) where the
file belongs: in an `attachments` array, or as the value of a base64 field
such as `contentBytes`. Pass the body as a JSON object, never as a string.

For GraphQL actions, put selected fields in `args.__select`:

```sh
kortix connectors call internal_graph query.user \
  '{"id":"1","__select":"id name email"}'
```
</cli-first-loop>

<sdk-workflows>
Use `@kortix/sdk` for dependent calls, pagination, branching, retries, or
reusable scripts. Read `references/sdk.md` for the full pattern.

```ts
import { createKortix } from '@kortix/sdk';

const kortix = createKortix({
  backendUrl: process.env.KORTIX_API_URL!,
  getToken: async () => process.env.KORTIX_TOKEN ?? null,
});
const connectors = process.env.KORTIX_PROJECT_ID
  ? kortix.project(process.env.KORTIX_PROJECT_ID).connectors
  : kortix.connectors;

const matches = await connectors.search('send an email', { limit: 5 });
const action = await connectors.describe(matches[0]!.tool);
if (!action) throw new Error('Email action not found');

const result = await connectors.call('email_email_inbox_bjgk.reply_message', {
  inbox_id: 'agent@kortixmail.com',
  thread_id: '<thread-id>',
  message_id: '<message-id>',
  text: 'Reply text',
});

if (!result.ok) {
  throw new Error(`Connector call failed: ${result.reason ?? result.status ?? 'unknown'}`);
}
```

Run repository scripts with `bun run path/to/script.ts`. Keep provider
credentials out of code and repository files.
</sdk-workflows>

<from-apps-and-backends>
App, Convex backend, and external-program code calls connectors through
`@kortix/sdk` too. Never give that code a provider API key when a connector
for the provider exists: a raw key skips policy, approvals, and audit. The
Kortix credential decides which accounts a call reaches:

| Where the code runs | Credential | Reaches |
|---|---|---|
| App, browser | `backendUrl: '/_kortix/api/v1'` + `kortixAppViewerToken()` (App set to `--viewer api`) | the viewer's shared and private accounts |
| App, server | `createAppViewerKortix(request, { backendUrl })` | the same, per request |
| Convex action, App job with no viewer | a service account bearer (`kortix_sa_…`) in an env var | shared accounts nobody narrowed; never a private one |
| External program, CI | a personal access token, `kortix tokens new <name> --project <id>` | the token owner's shared and private accounts |

A service account is a human step. An agent session cannot create one. Ask
the person to run `kortix tokens service-accounts new <name>` and
`kortix access grant --service-account <id> --role member --project <id>`,
and to store the bearer (`npx convex env set KORTIX_API_KEY …` for Convex; a
project secret mapped under `apps.<slug>.secrets` for an App, with a name that
does not start with `KORTIX_`). Build the rest while you wait. Recipes and
errors: `references/sdk.md` → "Calling from an App, a backend, or a script".
</from-apps-and-backends>

<adding-connectors>
Connector definitions live in `kortix.yaml`. Connections remain server-side.

```yaml
connectors:
  - slug: stripe
    name: Stripe API
    provider: openapi
    spec: https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
    auth:
      type: bearer
```

To add an app, search the app catalogue first:

```sh
kortix connectors catalog gmail                     # every way in, one row per app
kortix connectors catalog crm --kind mcp,composio   # filter: mcp, composio, openapi, graphql, cli
kortix connectors catalog notes --one-click         # only apps the human connects by signing in
kortix connectors catalog show composio:gmail       # every way to connect it + its tools
```

Each app lists its ways to connect, best first, the first marked
`recommended`:

0. a Kortix channel (`kind: channel`: Slack, Microsoft Teams, Email,
   Telegram) — people message the agent there. It is never installed: the
   human sets it up (`kortix channels connect`, `--platform teams`,
   `kortix channels email connect`, or the web Channels page);
1. a one-click MCP server — the vendor's own server; the human only signs in;
2. Composio — a third-party partner that runs the sign-in (one click), for an
   app with no one-click MCP server (Gmail, Outlook, …);
3. an MCP server that needs the human's own OAuth app or key, then the REST
   (OpenAPI) and GraphQL APIs — they need a key or token after install.

`catalog show` prints the tools of the recommended way; `catalog tools <id>
--way <way-id>` prints another way's. Install the recommended way, or pick one,
and name the profile:

```sh
kortix connectors catalog install kortix:linear
kortix connectors catalog install composio:gmail --name "Support inbox"
kortix connectors catalog install <id> --way <way-id>
kortix connectors connect <slug>                    # the human signs in
```

Install adds a connector PROFILE (an entry in `kortix.yaml`): its accounts, who
may use them and its tool rules (`kortix connectors policy`) live on it.

Install one profile per WAY of connecting an app (Stripe over MCP and Stripe
over its REST API are two profiles: different tools, different sign-ins).
Never install a second profile of the same way only to give an agent other
rules: every profile needs its own accounts and its own sign-in. Give the
agent a policy set on the one profile instead (see **Policy sets** below).

The catalogue is large, not complete. When it has no entry for the app, search
the web for the vendor's MCP server (`<vendor> MCP server`, the vendor's
developer docs, the MCP registry at registry.modelcontextprotocol.io) or its
OpenAPI spec, then add it directly:

```sh
kortix connectors add acme --provider mcp --url https://mcp.acme.com/mcp --transport http --apply
kortix connectors add acme --provider openapi --spec https://acme.com/openapi.json --apply
```

If `catalog` answers that the catalogue is off for this project, use Composio:
`kortix connectors apps <query>`, then
`kortix connectors add <slug> --provider composio --app <slug> --apply`.

Pipedream exists only for rollback compatibility with already-declared
connectors. Never add a new Pipedream connector automatically. If Composio
and the MCP catalogue cannot satisfy the request, stop, explain the gap, and ask the human before any
explicit `--allow-legacy-pipedream` retry.

Surface the returned connection URL. For an API key you already have (the user
gave it in chat), store it now: `kortix secrets set NAME=- --scope connector`.
For one you lack, use `kortix secrets request NAME --scope connector`.

Slack uses the channel flow. Do not add a Slack connector. Run:

```sh
kortix channels connect
```
</adding-connectors>

<policy-sets>
A **policy set** is a named rule list on one connector profile
(`connectors[].policy_sets` in `kortix.yaml`). An agent gets a set with
`agents.<name>.policy_sets: { <connector slug>: <set name> }`. Its calls on
that connector then resolve in this order (first layer with a match decides):

1. project-wide `policies:` (a set never overrides them);
2. the agent's set on this connector;
3. the connector's base `policies:`;
4. `sensitive: true` → approval;
5. `policy.default_mode`.

A caller with no set (a person's token, a script, a trigger poll) gets the
base rules. A pi subagent runs under the set of the root session's agent. A
set can loosen a base rule for its agent; a rule for every caller goes in
project `policies:`.

```yaml
connectors:
  - slug: gmail
    provider: composio
    app: gmail
    policy_sets:
      read_only:
        description: Read and search, never send
        policies:
          - match: send_*
            action: block
agents:
  support:
    connectors: [gmail]
    policy_sets:
      gmail: read_only
```

Commands (each commits `kortix.yaml` on the default branch and syncs):

```sh
kortix connectors policy gmail sets                                     # sets + the agents that use each
kortix connectors policy gmail sets create read_only --description "Read and search, never send"
kortix connectors policy gmail --policy-set read_only set "send_*" block # set rules: ls, set, rm, clear
kortix connectors policy gmail sets rename read_only readonly           # rewrites agent references too
kortix connectors policy gmail sets rm readonly                         # 409 policy_set_in_use while an agent uses it
kortix agents scope support --policy-set gmail=read_only                # gmail=base removes the entry
```

- A name is `[a-z0-9][a-z0-9_-]{0,63}`; `base` is reserved. At most 32 sets
  per connector, 200 rules per set. `kortix_version` 2 or 3 only. Channel
  connectors and `computer` cannot hold sets.
- Changing any agent's `policy_sets` needs `project.agent.write` AND
  `project.connector.write`. Without `project.connector.write` in your own
  grant you cannot change any entry, your own included
  (`403 agent_grant_escalation`): ask the human.
- `list_connectors` (MCP) shows `policy_set` per connector: the set YOUR
  agent runs under, `null` for the base rules. The catalog omits actions your
  set blocks.
- `policy_block` with `policy_set` in the body: your agent's set blocked the
  call. Final. Do not retry, and do not look for another profile or account
  to get around it. Tell the human which set blocked which action.
- `policy_set_missing`: your agent names a set this connector does not
  define, so every call on the connector is blocked for you. Tell the human
  to fix `agents.<name>.policy_sets` or add the set.
</policy-sets>

<rules>
- A connector is not an account. One connector (e.g. Gmail) can hold many
  accounts (shared or private) — see **Choosing the account** above.
- If the human asks which or how many accounts are connected, ALWAYS list
  them with `kortix connectors accounts <slug>`. Never infer accounts from a
  profile/whoami call.
- Use `kortix connectors` for one-off agent actions.
- Use `@kortix/sdk` for durable or testable workflows, and for App, Convex
  backend, and external-program code (see **From apps and backends**).
- Add an app through the catalogue's recommended way: a one-click MCP server,
  else Composio, else its API. Search the web when the catalogue lacks it.
  Never select Pipedream unless the human explicitly approves the legacy
  rollback path.
- Do not use raw provider tokens from the sandbox.
- Treat `denied`, `not_shared`, `needs_auth`, `account_required`, and
  `ok: false` as real outcomes — `account_required` means several accounts
  are reachable and none was named or pinned; pass `--account` or ask the
  human, do not retry blind.
- Report which account ran when it could matter — read the result's
  `account` field, never assume.
- Confirm irreversible work before a destructive connector call.
- One profile per way of connecting an app. Different rules for different
  agents → a policy set, never a duplicate profile.
- A `policy_block` or `policy_set_missing` is final. Never route around a
  set through another profile, account, or raw key.
</rules>

</skill>
