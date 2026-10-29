---
name: kortix-connectors
description: Use Kortix connectors to reach external systems from a session, an App, a Convex backend, or an external program. Use the `kortix connectors` CLI for agent work, `@kortix/sdk` for durable TypeScript workflows and for App, backend, and script code, and the hosted Kortix MCP server (`<api>/v1/mcp`) for an MCP client outside Kortix. Load this skill to inspect, add, connect, or call external tools without exposing third-party credentials to the sandbox, an App, or a backend.
---

<skill name="kortix-connectors">

<model>
Three things, one per question:

- **Profile** (a connector): ONE way to reach an app, such as Linear over MCP.
  Its slug is what `kortix connectors call <slug> <action>` takes. An app is
  installed once per way.
- **Account**: WHO a call runs as. A sign-in on the profile, shared with the
  project or private to one member. One profile holds several.
- **Rule set** (a policy set): WHAT one agent may do on the profile. Named
  tool rules, given to an agent in `agents.<name>.policy_sets`.

Every call is decided in this order. The first layer with a matching rule
decides:

1. project `policies:` (nothing overrides them);
2. the calling agent's rule set on this profile;
3. the profile's base `policies:`;
4. `sensitive: true` → approval;
5. `policy.default_mode`.

The gateway holds every credential, applies these rules, runs the call, and
audits it. The sandbox carries only `KORTIX_TOKEN`.
</model>

<fast-path>
1. **See what exists.** `kortix connectors ls`: slugs, status, and an
   `ACCOUNTS` column.
2. **Add an app the project lacks**, then hand the human the link:
   ```sh
   kortix connectors catalog <name>          # `installed as <slug>` = it is already here
   kortix connectors catalog install <id>    # e.g. kortix:linear, composio:gmail; live at once
   kortix connectors connect <slug>          # prints the sign-in link for the human
   ```
   Install prints the next step. `Ready` means no sign-in is needed: call it.
   Exit 3 means the app is already installed: use that slug. When the human
   finishes signing in, Kortix tells you; do not mint a second link.
3. **Pick the account** (see `<accounts>`). With 2 or more accounts, pass
   `--account "<label>"`.
4. **Read the action before calling it.** `kortix connectors show <slug>.<action>`
   prints its input schema. The description says which filters run on the
   server.
5. **Call it. Send list-shaped results to a file.**
   ```sh
   kortix connectors call <slug> <action> '<json>' --account "<label>" --out /tmp/<name>.json
   ```
   The file holds `{ ok, account, data: { result: … } }`. `--out` prints the
   shape; read it before you write a query. Filter on the server with the
   action's own filters or the provider's search/query action. Do not
   download everything to filter it. Paging, attachments and GraphQL field
   selection: `references/calling.md`.
6. **Analyze in a script.** One `jq` expression for a lookup. For grouping,
   date windows or several metrics, write one `bun -e` or `python3` script.

Other reads: `kortix connectors discover "<intent>"` searches actions;
`kortix connectors policy <slug> effective` shows what each tool does for you
and which layer decided.
</fast-path>

<accounts>
Never assume one profile means one account. Never infer accounts from a
`get_profile`/`whoami` call: it answers only for the account it ran as.

Every time you call a profile you have not listed accounts for:

1. `kortix connectors accounts <slug>` lists them, default first.
2. One account: call.
3. Several, and the human named one: pass `--account <label|id|me|project>`
   (`me` = your own private default, `project` = the shared default).
4. Several, and it is unclear which one: ASK. With nothing named and nothing
   pinned the call is refused (`account_required`). A human pins a default
   with `kortix connectors accounts <slug> --default <label>`.

Report which account ran when it could matter: read the result's `account`.

```sh
$ kortix connectors accounts gmail
  LABEL                 OWNER    DEFAULT  CONNECTION ID
  personal@example.com  private  no       11111111-…
  work@example.com      private  no       22222222-…
```

Asked "check my gmail" here, ask which mailbox. Told "the work one", call
with `--account "work@example.com"` and say "Checked work@example.com — …".

**Another account** ("connect my other Gmail"): mint a link with a label,
`kortix connectors connect <slug> --label "Personal Gmail"`. The human names
the account and chooses who can use it; you are told its name. Never install
a second profile to get a second account.

**Email** inboxes are accounts of `kortix_email`. Kortix fills in `inbox_id`:
```sh
kortix connectors accounts kortix_email
kortix connectors call kortix_email reply_message \
  '{"thread_id":"<thread-id>","message_id":"<message-id>","text":"Reply text"}' \
  --account "<inbox address>"
```
</accounts>

<approvals>
A rule may hold a call for a human. Pass `--reason "<what this does>"` on
every write whose args are only ids (`send_draft`: who it goes to, the
subject, the body; a delete: what goes). The approver sees it next to the
args.

A held call returns `approval_url`: share it, then stop the turn. The
decision, and any message with it, arrives as your next prompt. A deny with
a message is an instruction. In a Slack or Teams session Kortix posts the
approval card in the thread (`approval_instructions` says so): do not repost
the link.
</approvals>

<adding-connectors>
Search the catalog first:

```sh
kortix connectors catalog gmail                     # one row per app
kortix connectors catalog crm --kind mcp,composio   # kortix, mcp, composio, openapi, graphql
kortix connectors catalog notes --one-click         # apps the human connects by signing in
kortix connectors catalog show composio:gmail       # every way to connect it + its tools
```

Ways to connect, best first (the first is marked `recommended`):

0. built by Kortix (`kind: kortix`): the channels Slack, Microsoft Teams,
   Email and Telegram, and Computer. They are never installed. The human
   sets them up: `kortix channels connect` (Slack; `--platform teams`),
   `kortix channels email inboxes add`, Telegram on its web page, Computer
   with `npx --yes @kortix/agent-tunnel@latest connect` on that machine or
   the desktop app;
1. a one-click MCP server: the vendor's own; the human only signs in;
2. Composio: a third-party partner that runs the sign-in (one click);
3. an MCP server that needs the human's own OAuth app or key, then the REST
   (OpenAPI) and GraphQL APIs: they need a key or token after install.

```sh
kortix connectors catalog install kortix:linear
kortix connectors catalog install composio:gmail --name "Support inbox"
kortix connectors catalog install <id> --way <way-id>
```

Install is idempotent: the same app the same way exits 3 and names the slug
it already has. `--new-profile` makes a second profile; use it only for a
human who asks for one. Another way of connecting (Stripe over MCP and over
REST) is its own profile: different tools, different sign-in.

The catalog is large, not complete. When it lacks the app, search the web for
the vendor's MCP server (its developer docs, registry.modelcontextprotocol.io)
or OpenAPI spec, then add it:

```sh
kortix connectors add acme --provider mcp --url https://mcp.acme.com/mcp --transport http --apply
kortix connectors add acme --provider openapi --spec https://acme.com/openapi.json --apply
```

Without `--apply`, `add` edits only this session branch's `kortix.yaml`. In a
governed agent, a URL that is not in the catalog returns
`custom_connector_needs_human` with a `setup_url`: hand it to the human.

Credentials:
- an API key the human gave you: `kortix secrets set NAME=- --scope connector`,
  then `kortix connectors secret <slug> NAME`;
- a key you lack: `kortix secrets request NAME --scope connector`;
- OAuth2 client credentials (an OpenAPI or HTTP API with a client id and
  secret): `kortix connectors credential <slug> --oauth2-client-credentials
  --token-url <url> --client-id <id> --client-secret-from - [--scope "<a b>"]`,
  secret on stdin. Kortix fetches and refreshes the tokens.

Pipedream exists only for rollback compatibility with already-declared
connectors. Never add one. If the
catalog and the web have nothing, stop, explain the gap, and ask the human.
</adding-connectors>

<policy-sets>
A rule set is a named rule list on one profile (`connectors[].policy_sets`).
Give an agent one with `agents.<name>.policy_sets: { <slug>: <set> }`. A
caller with no set (a person's token, a script, a trigger poll) gets the base
rules. A pi subagent runs under the root session agent's set.

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

Each command commits `kortix.yaml` on the default branch and syncs:

```sh
kortix connectors policy-sets gmail ls                                  # sets + the agents that use each
kortix connectors policy-sets gmail create read_only --template read-only   # or ask-before-writes
kortix connectors policy gmail --policy-set read_only set "send_*" block   # ls, set, rm, clear
kortix connectors policy gmail effective --policy-set read_only         # what each tool does now
kortix connectors policy-sets gmail rename read_only readonly           # agents move with it
kortix connectors policy-sets gmail rm readonly                         # refused while an agent uses it
kortix agents scope support --policy-set gmail=read_only                # gmail=base removes the entry
kortix connectors agents gmail                                          # who calls gmail, with which set
kortix connectors rules                                                 # every agent × every profile
```

- `--template read-only` blocks every tool that is not a read;
  `ask-before-writes` asks for them. Unknown-risk tools count as writes.
  Check the result with `policy <slug> effective`.
- A name is `[a-z0-9][a-z0-9_-]{0,63}`; `base` is reserved. Channel profiles
  and `computer` hold no sets.
- Changing any agent's `policy_sets` needs `project.agent.write` AND
  `project.connector.write`. Without both in your own grant you cannot change
  any entry, your own included (`403 agent_grant_escalation`): ask the human.
- `list_connectors` (MCP) shows `policy_set` per profile: the set YOUR agent
  runs under, `null` for base rules.
</policy-sets>

<sdk-workflows>
Use `@kortix/sdk` for dependent calls, pagination, branching, retries, or
reusable scripts. `references/sdk.md` has the full pattern.

```ts
import { createKortix } from '@kortix/sdk';

const kortix = createKortix({
  backendUrl: process.env.KORTIX_API_URL!,
  getToken: async () => process.env.KORTIX_TOKEN ?? null,
});
const connectors = process.env.KORTIX_PROJECT_ID
  ? kortix.project(process.env.KORTIX_PROJECT_ID).connectors
  : kortix.connectors;

const result = await connectors.call(
  'kortix_email.reply_message',
  { thread_id: '<thread-id>', message_id: '<message-id>', text: 'Reply text' },
  { account: '<inbox address>' },
);
if (!result.ok) throw new Error(`Call failed: ${result.reason ?? result.status ?? 'unknown'}`);
```

Run scripts with `bun run path/to/script.ts`. Keep provider credentials out
of code and repository files.
</sdk-workflows>

<from-apps-and-backends>
App, Convex backend and external-program code calls connectors through
`@kortix/sdk` too. Never give that code a provider key when a connector
exists: a raw key skips rules, approvals and audit. The Kortix credential
decides which accounts a call reaches:

| Where the code runs | Credential | Reaches |
|---|---|---|
| App, browser | `backendUrl: '/_kortix/api/v1'` + `kortixAppViewerToken()` (App set to `--viewer api`) | the viewer's shared and private accounts |
| App, server | `createAppViewerKortix(request, { backendUrl })` | the same, per request |
| Convex action, App job with no viewer | a service account bearer (`kortix_sa_…`) in an env var | shared accounts nobody narrowed; never a private one |
| External program, CI | a personal access token, `kortix tokens new <name> --project <id>` | the token owner's shared and private accounts |

A service account is a human step: ask the person to run
`kortix tokens service-accounts new <name>` and
`kortix access grant --service-account <id> --role member --project <id>`,
and to store the bearer (`npx convex env set KORTIX_API_KEY …` for Convex; a
project secret under `apps.<slug>.secrets` for an App, not named `KORTIX_*`).
Build the rest while you wait. Recipes: `references/sdk.md`.
</from-apps-and-backends>

<rules>
- Decision order: project rules → your rule set → base rules → sensitive →
  default mode. A `policy_block` (with `policy_set` when your set decided)
  or `policy_set_missing` is final: tell the human which set blocked which
  action. Never route around it through another profile, account, or raw key.
- A profile is not an account. Asked which or how many accounts exist, list
  them with `kortix connectors accounts <slug>`.
- Install an app once per way. Another account → `connect --label`. Other
  rules for one agent → a rule set. Never a duplicate profile.
- Treat `denied`, `not_shared`, `needs_auth`, `account_required`,
  `tool_error` and `ok: false` as real outcomes. `call` exits 1 on them. Do
  not retry blind.
- Use the CLI for one-off actions; `@kortix/sdk` for durable workflows and
  for App, backend and program code. Never use raw provider tokens.
- Confirm irreversible work before a destructive call.
</rules>

</skill>
