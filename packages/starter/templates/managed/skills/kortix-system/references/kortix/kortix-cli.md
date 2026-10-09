# Kortix CLI — full reference

The `kortix` CLI is the canonical way to drive everything the Kortix
dashboard can do — from a terminal, from a coding agent, from a session
sandbox. It is **always available** inside a Kortix session sandbox:

- the binary is on `PATH` (`/usr/local/bin/kortix`)
- `KORTIX_TOKEN` is pre-injected — the session-scoped token the CLI
  authenticates with automatically (see "Inside a sandbox" below)
- `KORTIX_API_URL` points at the platform you're running against

So you can run `kortix sessions ls` or `kortix secrets set FOO=bar`
from any shell in the sandbox with no setup.

This document lives under the `kortix-system` skill at
`references/kortix/kortix-cli.md` (relative to the skill directory)
— it travels with your repo and is loaded on-demand whenever an agent
needs CLI specifics.

## Quickstart inside a session

```sh
kortix whoami                       # confirms what project + account this token has
kortix projects info                # the project you're running inside
kortix secrets ls                   # encrypted env vars + manifest [env] spec
kortix sessions ls                  # every session, with who started each (STARTED BY)
kortix sessions ls --automated      # top-level runs a trigger/channel/API key started (also --mine, --shared)
kortix sessions ls --search deploy  # searches every session you can see, not only recent ones
kortix sessions ls --children <id>  # the sub-sessions one session spawned
kortix cr ls                        # open change requests
kortix cr open --title "..."        # propose merging your branch into main
```

The token in the sandbox is **project-scoped**: it can read + write
anything on *this* project (secrets, sessions, triggers, change
requests), but it cannot list other projects or touch
account-level resources. See "Token scope" below for the full
permission model.

## On your laptop

The local install flow is one curl + one click:

```sh
curl -fsSL https://kortix.com/install | bash
kortix login                        # opens browser, you click Authorize
```

The local CLI uses a **user-scoped** token saved at
`~/.config/kortix/config.json` (mode 0600). That token can see every
project on every account you're a member of.

## Command surface

### Machine-readable output (`--json`) — driving Kortix as an agent

Every **read/list** command accepts `--json`: it prints the raw API
payload to **stdout** (the human table is suppressed) and nothing else,
so an agent can parse it directly. All diagnostics — the `host …` banner,
update notices, errors — go to **stderr**, so `… --json 2>/dev/null | jq`
is always clean JSON. Mutations are flag-driven with no hidden prompts.

Net effect: the CLI is a **100% scriptable surface** — an agent can drive
Kortix end-to-end from the terminal, the same surface a human drives in
the dashboard (list/select/interact with sessions, read messages, browse
files & diffs, open/merge change requests, manage secrets/triggers/
connectors, …).

```sh
kortix sessions ls --json                       # what's running
kortix sessions log <id> --json                 # what an agent is doing
kortix cr ls --json                             # open change requests
kortix files cat README.md --json | jq -r .content
```

### Auth

| Command | Effect |
| --- | --- |
| `kortix login [--token <pat>] [--host <name>] [--api <url>]` | Default: opens browser → click Authorize → token written. `--token` is the headless fallback. `--host` logs into a named host slot (see Hosts). |
| `kortix logout [--host <name>]` | Remove the token for the active host (or named one). |
| `kortix whoami [--host <name>]` | Print the user + active account on the chosen host. |

### Hosts — pick which Kortix you talk to

A host is one Kortix API endpoint. You can configure several
(cloud, localhost, self-hosted) and switch between them. One is
"active" at any moment; commands operate on the active host by default.

| Command | Effect |
| --- | --- |
| `kortix hosts ls` | List configured hosts (`●` marks active). |
| `kortix hosts use [<name>]` | Switch active host. No name → arrow-key picker. |
| `kortix hosts add <name> --url <url> [--login]` | Register a new host. `--login` runs the browser flow right after. |
| `kortix hosts rm <name>` | Remove a host (confirms when it's the last one). |
| `kortix hosts info [<name>]` | Detailed view of one host. |
| `kortix hosts current` | Print the active host name (script-friendly). |

`--host <name>` on any command overrides the active host for a single
invocation: `kortix projects ls --host local`.

### Projects

| Command | Effect |
| --- | --- |
| `kortix projects ls` | Every project on the active account. |
| `kortix projects info [<id-or-slug>]` | Show one project (defaults to the linked one — see below). |
| `kortix projects link [<id>]` | Bind cwd to a remote project. Writes `.kortix/link.json` with `project_id`, `account_id`, `host`, `host_url`. No arg → arrow-key picker. |
| `kortix projects unlink` | Drop `.kortix/link.json`. |
| `kortix projects open [<id>]` | Open the dashboard URL for a project in your browser. |

#### How a command finds "the project"

In strict order:

1. `--project <id>` flag.
2. `KORTIX_PROJECT_ID` env var.
3. `.kortix/link.json` in cwd (or any ancestor — git-style).
4. Inside a session sandbox: the sandbox's own `KORTIX_PROJECT_ID`.

If none resolve, the command errors with a pointer to `projects link`.

#### How a command finds "the host"

1. `--host <name>` flag.
2. `host` field in `.kortix/link.json` (so a repo always hits its
   home Kortix instance).
3. The globally-active host.

### Apps — serverless application deployments

Apps have stable URLs and immutable deployment versions. Every App has a
`kind`, fixed at create, and lists its `capabilities`. A `web` App is static
(files that Kortix serves: no machine, nothing to start or stop) or a server
(`dockerfile`, `oci_image`, `bundle`: one machine, always on or on demand, stops
at its monthly budget; an authorized request wakes it). A `convex` App is a
self-hosted Convex backend in one always-on machine. A subcommand for a
capability the App lacks exits `1` with
`App <slug> (kind <kind>) does not support <capability>.`

Apps is internal-only: Kortix enables it per project on request, and only
Kortix can change it. When it is on, `kortix projects features` lists
`apps on kortix` and `kortix projects info --json` has `experimental.apps: true`.
When it is off, every `kortix apps` command answers `feature_disabled`
("Contact Kortix to enable it.").

| Command | Effect |
| --- | --- |
| `kortix apps ls [--json]` | List the project's Apps with their kind, state (`static` for a static App), and stable URL. |
| `kortix apps create <slug> [--name …]` | Create an App identity without deploying source. Flags: `--kind web\|convex`, `--uses <slugs>`, `--cpu`, `--memory`, `--disk`, `--idle-timeout`, `--always-on\|--on-demand`, `--budget`, `--no-wait`. A `convex` App waits until its machine runs. |
| `kortix apps deploy [path]` | Upload and deploy a directory or `.tar.gz`. Auto-detects static, bundle, or Dockerfile source; pass `--type`. Waits until ready by default. |
| `kortix apps deploy … --always-on\|--on-demand --budget <usd>` | Server Apps: set the run mode and the monthly compute budget (default: the 24/7 estimate of the machine, rounded up, when always on; 5 USD on demand). Prints the cost. Warns on stderr (`app_budget_below_always_on`) when an always-on App's budget is below its 24/7 estimate. |
| `kortix apps deploy --manifest-app <name>` | Use one v2 `kortix.yaml` `apps.<name>` block. A sole App block is selected automatically for bare `deploy`; with several, bare `deploy` deploys every App, each after the Apps it uses. |
| `kortix apps deploy <dir> --app <slug> [-- <args>]` | A `convex` App: run `convex deploy` with its credentials, then record the deployment with the git commit. |
| `kortix apps deploy --image <ref> --command <argv> --port <n>` | Deploy a public OCI image. `--command` accepts a JSON string array or shell-like string. |
| `kortix apps set <id-or-slug>` | Change an App: `--name`, `--cpu`, `--memory-gb`, `--disk-gb`, `--idle-timeout`, `--always-on\|--on-demand`, `--budget`, `--uses <slugs>`. Run mode and budget apply within 5 minutes; a web machine change applies to the next deployment; a `convex` App resizes now. |
| `kortix apps link\|unlink <id-or-slug> --uses <slugs>` | Add or remove Apps this App uses (bindings and sign-in tokens). |
| `kortix apps show <id-or-slug> [--json]` | Show an App (`kind`, `capabilities`, `uses`, `used_by`, `instance`, `hosting_type`, `always_on`, `monthly_budget_usd`, `estimated_monthly_usd`) and its deployment history. |
| `kortix apps logs <id-or-slug> [deployment-id]` | Read supervisor, Caddy, and user-process logs; a static App prints its deployment events. Supports `--after` and `--limit`. An App with the `logs` capability prints its process log (`--lines 1-1000`). |
| `kortix apps start <id-or-slug>` | Server Apps: permit traffic and start the active deployment now. A static App answers `409 static_app_no_runtime`. |
| `kortix apps stop <id-or-slug>` | Server Apps: suspend compute now. The next authorized request wakes it. A static App answers `409 static_app_no_runtime`. |
| `kortix apps rollback <id-or-slug> <deployment-id>` | Move traffic to a ready deployment. A server App starts the target first, then stops the previous runtime. |
| `kortix apps access <id-or-slug>` | Read or change access: `--mode private\|project\|restricted\|public\|password`, `--members`, `--groups`, `--password`, `--viewer off\|identity\|api`. |
| `kortix apps access-link <id-or-slug> [--json]` | Create a five-minute authenticated browser URL. Treat it as a secret. |
| `kortix apps connect <id-or-slug> [--json]` | Print how to reach the App from code. No secret. |
| `kortix apps token <id-or-slug> [--json]` | A 15-minute sign-in token for the App; in a session it names the agent. |
| `kortix apps credentials <id-or-slug> [--format shell\|dotenv\|json]` · `rotate-credentials <id-or-slug> --yes` | Capability `admin_credentials`: read (audited) or replace the admin key. |
| `kortix apps dashboard <id-or-slug> [--open]` | Capability `dashboard`: the Kortix page that opens the App's dashboard. |
| `kortix apps snapshots\|snapshot <id-or-slug>` · `delete-snapshot <id-or-slug> <id> --yes` · `restore <id-or-slug> <id> --yes` | Capabilities `snapshots` and `restore`. |
| `kortix apps delete <id-or-slug> --yes` | Delete the App, every runtime, and every deployment image. An App with `snapshots` needs `--confirm <slug>`: Kortix keeps a `final` snapshot and the stopped machine 7 days. |
| `kortix apps delete <id-or-slug> --deployment <id\|vN> --yes` | Delete one deployment. The live deployment answers `409 deployment_live`. |

Deploy options include `--type static|bundle|dockerfile`, `--root`, `--spa`,
`--output-dir`, `--install-command`, `--build-command`, `--dockerfile`,
`--command`, `--port`, `--readiness-path`, `--access`, `--members`, `--groups`,
`--password`, `--always-on`, `--on-demand`, `--budget`, and `--provider`. Omit
`--provider` for platform policy. Prefer a local build deployed with
`--type static` over `--type bundle`. Use `--no-wait` only when another process
will poll the deployment.

Directory uploads read `.gitignore`, `.dockerignore`, and `.kortixignore` from
the uploaded directory only. They always exclude `.git`, `.kortix`, `.env*`, and `node_modules`.
`--include-node-modules` only overrides the `node_modules` default.

See the `apps.md` reference for the complete manifest, runtime, secret, and
failure contract.

### Secrets

Encrypted project credentials. Delivery follows each secret's exposure and the
session's agent grant. **Environment** exposure (`runtime`) is the default: it
puts the real value in an environment variable. **Egress-enforced** exposure
(`egress`) is experimental and opt-in per project — when enabled it puts a HANDLE
in the env instead and Kortix swaps it for the real value outside the sandbox, on
the exact HTTPS hosts the policy lists.

| Command | Effect |
| --- | --- |
| `kortix secrets ls` | List secret names + manifest `[env]` spec; marks required-but-missing. In a session it lists only your agent's granted secrets; a declared key outside the grant shows `not granted` (set or not, you never receive it — ask the human to enable it under Customize → Agents → your agent → Secrets). |
| `kortix secrets set NAME=VALUE … [--scope runtime\|connector]` | Upsert one or more. `NAME=-` reads VALUE from stdin (so values never appear in shell history). **Use it whenever you HAVE the value** — including a key the human gave you in chat. `--scope connector` keeps it server-side for a connector. `403` = your agent lacks secret-write permission → use `request`. |
| `kortix secrets request NAME …` | **Mint a short-lived link for a human to ENTER value(s) you do NOT have.** Surface the URL (web: fill-in modal, Slack: tappable link). `--scope runtime\|connector` (default `connector` = server-side only; pass `--scope runtime` for a value your code reads from the env), `--expires <minutes>` (default 7 days). Warns when your agent's grant will withhold a requested name. Use this when you need a key you don't have. |
| `kortix secrets share IDENTIFIER --user <email\|id\|me> --group <id> --agent <name> \| --everyone` | Set who can use a value. A person runs it; in a session it returns `403`. A value shared with specific people reaches only them, directly or in their own private sessions — never a shared session or a trigger (see credentials-and-setup-links.md). |
| `kortix secrets unset NAME …` | Remove. |
| `kortix secrets call IDENTIFIER URL [--method METHOD] [--header NAME:VALUE] [--data BODY\|--data-file PATH]` | (Experimental network enforcement only.) Send one policy-bound HTTPS request. Kortix adds the secret server-side. Use it when a request cannot be relayed transparently. |

`$KORTIX_SECRET_CAPABILITIES` is the session's value-free machine-readable
catalog. It contains only granted capabilities. Use `kortix secrets ls --json`
for the full stored policy. By default every secret is `exposure: environment` —
a plaintext environment variable. An egress-enforced secret (experimental,
present only when the project enabled it) is a handle, and a service-spent one
has no sandbox presence at all.

> **Have the value? Set it. Lack it? Request it.** When the human already gave
> you the value, store it now: `printf '%s' "$V" | kortix secrets set NAME=-`
> — no link. When you lack it, run
> `kortix secrets request APOLLO_API_KEY`, surface the returned URL, end your turn, and when they
> say "done" confirm with `kortix secrets ls`. See the
> **credentials-and-setup-links** reference.

### Connectors — call external tools

A connector defines actions against an external system. **A connector is not
an account** — one connector (e.g. Gmail) can hold several accounts, each
SHARED with the whole project or PRIVATE to one member. Calls run
**server-side** through the connector gateway, so no third-party credential
enters the sandbox. The same gateway is available through this **CLI** and the
`@kortix/sdk` **TypeScript package**. JSON output.

| Command | Effect |
| --- | --- |
| `kortix connectors ls [--session <id>]` | List project or session-visible connectors and actions (an `ACCOUNTS` column shows how many each holds). |
| `kortix connectors discover "<intent>"` | Search actions by natural language (`--limit`). |
| `kortix connectors show <connector>.<action>` | Show one action's input schema and risk. |
| `kortix connectors accounts <slug>` | List the accounts a connector holds, default first. Use this whenever it matters which account runs, or a human asks which/how many are connected — never infer it from one call's result. |
| `kortix connectors accounts <slug> --default <label>` | Pin one account as the one an unnamed call uses. |
| `kortix connectors call <connector> <action> '<json>' [--account <label\|id\|me\|project>]` | Invoke an action, optionally naming which account. Omit `--account` for the default. The gateway resolves the account, enforces policy, and audits. Every successful result echoes `account` — say which one ran when it matters. |
| `kortix connectors call <connector> <action> '<json>' --reason "<text>"` | Describe the effect for the human approver when a policy holds the call. Pass it on every write whose args are only ids (`send_draft`, deletes, merges). The approver sees it labelled as your description, next to the arguments. |
| `kortix connectors call <connector> <action> @args.json --attach <file>` | Attach a file from `/workspace/{output,artifacts,reports,deliverables}`. The gateway writes it into the action's attachments array as the provider's item (e.g. Microsoft Graph `body.message.attachments`). `@file` / `-` read large args. |
| `kortix connectors call <connector> <action> '<json>' --out <file>` | Write the full JSON result to `<file>` (parent dirs created). Stdout gets only `saved_to`, `bytes`, and `shape` (keys, array lengths, `pageInfo`). Use it for results too large to read; query the file with `jq` or `bun`. |
| `kortix connectors types [--connector <a,b>] --out <file>` | Write TypeScript types for the callable actions (`declare module '@kortix/sdk'`). Use it before writing SDK code: `connectors.callAction(slug, action, args)` then type-checks args and `output`. Composio/Pipedream results stay `unknown`. |
| `kortix connectors upload <file> --connector <slug>` | Stage one file; prints `ref` (`{"$kortix_attachment":"<id>"}`) to place in args — an attachments[] element or a base64 field such as `contentBytes`. |
| `kortix connectors add <slug> --provider composio --app <toolkit> --apply` | Add a managed SaaS connector now, commit it to `kortix.yaml` on main, and sync it. |
| `kortix connectors rm <slug> --apply` | Remove a connector from `kortix.yaml` on main and sync it. |
| `kortix connectors connect <slug> [--owner me\|project]` | Mint the provider's raw authorization URL for the connector's default account (`me`, the default, is yours; `project` is the shared one). |
| `kortix connectors connect <slug> --label "<name>" [--owner me\|project]` | Add a NEW account (a second Gmail): mint a Kortix link where the human confirms the name and who can use it. |

> Use Composio for every new managed SaaS connector. Pipedream is retained only
> for rollback compatibility with existing declarations. Do not select it unless
> the human explicitly approves the `--allow-legacy-pipedream` fallback.

> **Choosing the account:** one account → just call. Several, and the human
> named one → `--account <label>`. Several, and it is unclear which → ASK,
> never guess. If nothing is named and nothing is pinned, a call with several
> reachable accounts is refused with reason `account_required` — pass
> `--account`, or pin a default with `kortix connectors accounts <slug>
> --default <label>`.

### Env — dotenv ↔ secrets

| Command | Effect |
| --- | --- |
| `kortix env pull [--out .env] [--force]` | Write a `.env` skeleton (names only — plaintext can't leave the cloud). |
| `kortix env push --from <path>` | Upload every `NAME=VALUE` from a dotenv file as a secret. Supports quoted values, `export NAME=…`, comment lines. |

### Sessions

Each session is an isolated sandbox VM on its own ephemeral branch.

| Command | Effect |
| --- | --- |
| `kortix sessions ls` | Every session on the project (parents and children) with STARTED BY. `--mine \| --shared \| --automated` list top-level sessions with their child count; `--search <q>` matches every session you can see; `--children <id>` lists one session's sub-sessions. `--json` for machine-readable output. |
| `kortix sessions status [--all] [--json]` | **Mission control** — every session + what each agent is doing *right now* (live: current tool / thinking / idle + last activity). Built for when many run in parallel. Aliases: `overview`, `ps`. |
| `kortix sessions info <id>` | Detail view: status, branch, base ref, agent, sandbox URL, errors. `--json`. |
| `kortix sessions log [<id>] [--limit N] [--json]` | **Read-only** peek at a session agent's recent messages — see what another agent is *doing right now* without sending it anything. Aliases: `messages`, `history`. No id → most-recent running (an interactive picker when several run on a TTY). |
| `kortix sessions chat [<id>]` | Talk to a session's agent. `--prompt "<text>"` = one-shot (prints the reply and exits); add `--json` to get that reply as JSON (a synchronous subagent call); no flag = REPL. No id → picks/asks which running session. `--new` starts a fresh one. |
| `kortix sessions new [--prompt "<text>"] [--wait] [--json]` | Start a new session. `--wait` blocks until it's running; `--json` prints the session object so you can capture `session_id` to orchestrate. `--with-file <local path>` (repeatable) uploads each file to `/workspace/incoming/<name>` **before** the prompt is delivered, and appends a manifest of the paths to the prompt. |
| `kortix sessions wait-for <id> [--timeout <s>]` | Block until the session's agent finishes its current work — never poll with sleeps. Exit `0` = done, `3` = blocked on a permission/question ask (answer via `sessions pending`), `124` = still working at the timeout (default 300s). Alias: `wait`. |
| `kortix sessions cp <src> <dst> [-r]` | Copy files between your machine/sandbox and a session's sandbox, or directly between two sessions' sandboxes. Refs are scp-style: `<session-id>:<path>` is remote, plain is local; paths resolve under `/workspace` unless absolute. Overwrites the exact destination path; `-r` for directories. Wakes stopped sandboxes on demand. |
| `kortix sessions restart <id>` | Re-provision a session in place. |
| `kortix sessions rm <id>` | Stop + delete. |
| `kortix sessions open <id>` | Open the dashboard URL for a session. |

Session ids can be abbreviated: any unambiguous prefix works (the 8-char
ids `sessions ls` prints are fine).

**Stopped ≠ failed.** A spawned session's sandbox stops automatically a
couple of minutes after its agent finishes, to save compute. Its files
and conversation are intact — `sessions cp`, `sessions chat`, and
`sessions wait-for` wake it on demand. Treat `stopped` as *parked*.

**Inside a sandbox:** `KORTIX_SESSION_ID` tells you which session
you're running in. `kortix sessions info $KORTIX_SESSION_ID` gives
you the live view of yourself.

**Watch + talk to other agents.** From any session (or your laptop) you
can see the whole project's activity and read it live — this is how an
agent checks up on every other agent that's running:

```sh
kortix sessions status                      # all agents + what each is doing now
kortix sessions status --json | jq .        # …parsed for a monitoring loop
kortix sessions log <id> --limit 20         # read one agent's recent transcript
kortix sessions chat <id> --prompt "…"      # talk to another agent
```

`log` is **read-only** — it never sends a message, so it's the safe way
to observe. To actually talk to another session, one-shot it:
`kortix sessions chat <id> --prompt "status?"` (prints the reply and
exits), or drop into a REPL with `kortix sessions chat <id>`.

**Orchestrate parallel subagents.** The whole fan-out loop is CLI-only —
spawn many sessions, watch the fleet, collect results, land work:

```sh
# spawn a subagent (optionally shipping input files) and get a ready session id
id=$(kortix sessions new --json --wait \
       --with-file input.pdf \
       --prompt "Process /workspace/incoming/input.pdf; write results to /workspace/out/" \
     | jq -r .session_id)

kortix sessions wait-for "$id" --timeout 300  # block until it finishes (exit 3 = it asked something)
kortix sessions cp "$id":out/result.pdf .     # collect the deliverable
kortix sessions log "$id" --json              # …or read progress without interrupting
kortix sessions chat "$id" --prompt "status?" --json | jq -r .text   # synchronous call

kortix cr ls --json                           # subagents land work as CRs → review/merge
kortix sessions rm "$id"                       # tear the subagent down when fully done
```

`--json --wait` is the spawn primitive (one call → a running session id you
can immediately drive); `wait-for` replaces sleep-polling; `sessions cp`
moves files in/out (also session↔session); `sessions status` is the
at-a-glance fleet view; `chat … --prompt --json` is a synchronous call;
`log` is async observation. Session sandboxes have Python (via **uv** —
`uv run` / `uvx` / `uv pip`, prefer it over bare `pip`), Node, browsers,
and document tooling preinstalled.

### Triggers

Round-trip through `kortix.yaml`'s `triggers:`. Dashboard sees
the same state.

| Command | Effect |
| --- | --- |
| `kortix triggers ls [--type cron\|webhook\|event\|monitor] [--connector <slug>] [--json]` | List triggers + runtime state (`last_fired_at`). `--type` keeps one kind; `--type event` groups the rows by app. `--connector` keeps the app events on one connector. The filters combine, and `--json` respects them. |
| `kortix triggers info <slug>` | Show one trigger in full. |
| `kortix triggers fire <slug>` | Manually fire a trigger now. |
| `kortix triggers enable <slug>` | Set `enabled = true`. |
| `kortix triggers disable <slug>` | Set `enabled = false`. |
| `kortix triggers events --apps [--json]` (all `triggers events` forms and `triggers add|set --type event` need the project flag `event_triggers`: off prints `App event triggers are off for this project. Turn them on: kortix projects features enable event_triggers`, exit 1) | List apps that can trigger events: event count and state (`connected`, `needs account`). Under each app, every connector (profile) with its shared accounts: label, `as <connected_as>`, `default`, `not connected`. Apps with no connector print as one `No connector yet` line. |
| `kortix triggers events --app <app> [--source <adapter>] [--event <TYPE>] [--json]` | List an app's events, or one event's fields, with no connector: browse before you add a connector. `--source` defaults to `composio`. |
| `kortix triggers events --connector <slug> [--json]` | List the events a connector offers: `TYPE`, `NAME`, `DELIVERY`. |
| `kortix triggers events --connector <slug> --event <TYPE> [--json]` | One event in full: config fields (type, required, default, allowed values, description) and the `{{ event.data.* }}` prompt variables. |
| `kortix triggers add <slug> --type event --connector <slug> --event <TYPE> --config <k>=<v> [--account <label>] --prompt "…" [--apply]` | Add an event trigger. `--connector` is the profile. `--account` names one shared account of it; omit it for the connector's default shared account. Without `--apply` it writes a `triggers:` block to the local `kortix.yaml` (`kortix ship` applies it). With `--apply` it creates the trigger now and prints its status and the next step. Online, the config is checked against the event catalog; every missing or invalid field is listed with its description. |
| `kortix triggers set <slug> [--event <TYPE>] [--connector <slug>] [--account <label> | --default-account] [--config <k>=<v>] [--config-json '<json>']` | Change a live event trigger. `--account` picks a shared account; `--default-account` clears it (the two are exclusive). Changing `--connector` clears the account. `--config` merges into the current config. `--config-json` replaces it. Do not pass both. |

`--config k=v` is converted to the field's type (number, boolean, comma
list) using the catalog. `--config-json` passes typed values as-is. An event
trigger takes none of `--cron`, `--run-at`, `--timezone`, `--secret-env`,
`--run`, `--mode`, `--interval`, `--expect-event-within`. `triggers ls` shows
a status word per event trigger (`live`, `pending`, `needs connection`,
`error`). `triggers info <slug>` shows the status, the error, the last event,
and a `Next` block with the exact command to run.

### Reminders

A reminder re-prompts ONE session later or on repeat. It is a trigger
scoped to that session and stored in the database — no `kortix.yaml`
edit. Inside a sandbox `--session` defaults to `$KORTIX_SESSION_ID`.
Behind the per-project `reminders` feature flag (off by default): a
project without it answers `feature_disabled`; `kortix projects features
enable reminders` turns it on (the user's decision).

| Command | What it does |
| --- | --- |
| `kortix remind "<text>" --in 24h` | Fire once, 24h from now. `--at <ISO>` for an instant. |
| `kortix remind "<text>" --in 24h --every 1h` | First fire in 24h, then hourly until removed. `--every` min `5m`. |
| `kortix reminders add "<text>" --cron "0 0 9 * * 1-5" --timezone Europe/Berlin` | Repeat on a 6-field cron. |
| `kortix reminders ls [--json]` | This session's reminders: id, state (`active`/`paused`/`done`), next fire. |
| `kortix reminders pause <id>` / `resume <id>` | Turn one off / on (resume re-arms from now). |
| `kortix reminders rm <id>` | Delete it. Do this as soon as its condition is met. |

Each fire arrives as `[REMINDER <id> — …]` followed by the text, and wakes a
parked session. A fire never starts a new session; if the session is
deleted or failed the reminder pauses itself. Max 20 active per session, 200 per project; schedules reach at most 366 days ahead.

### Channels (Slack)

The project's Slack wiring. **Connecting Slack is one command** — never a
manifest, bot token, or secret-intake link on Kortix Cloud.

| Command | Effect |
| --- | --- |
| `kortix channels connect` | **THE way to connect Slack.** Prints a one-click "Add to Slack" install link (Kortix Cloud) — surface the URL; the human picks a workspace and clicks Allow. Add `--wait` to block until the install lands. Self-host without the shared Slack app: falls back to manual token mode and says so. `--json` for machine output. |
| `kortix channels status` | Show the connected workspace (or "not connected"). `--json`. |
| `kortix channels disconnect` | Drop the project's Slack connection. |
| `kortix channels manifest` | Slack app manifest JSON — **manual/self-host setup only**. |

### Change requests (`cr`)

Kortix-native PR layer for session work landing on `main`. A change
request proposes merging one branch (`head_ref`) into another
(`base_ref`) inside a project. The CR layer is **Kortix-native** —
it works on top of any git host (GitHub, GitLab, plain
git) without a per-host adapter. A CR is the **only sanctioned
way** for an agent to land session-branch work on `main`; see
`change-requests.md` (alongside this file) for the full mandate and
lifecycle.

| Command | Effect |
| --- | --- |
| `kortix cr ls [--status open\|merged\|closed\|all] [--project <id>]` | List CRs on the project. Default: `--status open`. |
| `kortix cr show <cr> [--project <id>]` | Show one CR's metadata. Alias: `kortix cr info`. Includes the merge-preview (clean / fast-forward / conflicts) for open CRs. |
| `kortix cr diff <cr> [--no-color] [--project <id>]` | Unified diff of the CR. Three-dot diff for open / closed CRs; for merged CRs it uses the SHAs captured at merge time so the patch still renders even though `head_ref` is now reachable from `base_ref`. |
| `kortix cr open --title "<text>" [--description "<text>"] [--head <ref>] [--base <ref>] [--session <id>] [--project <id>]` | Open a new CR. Aliases: `kortix cr new`, `kortix cr create`. Inside a sandbox, `--head` defaults to `$KORTIX_BRANCH_NAME` and `--session` defaults to `$KORTIX_SESSION_ID`, so `kortix cr open --title "..."` Just Works. `--base` defaults to the project's default branch (usually `main`). `--title` is required. Alias for `--head`: `--from`. Alias for `--base`: `--into`. Alias for `--description`: `--body`. |
| `kortix cr merge <cr> [--message "<text>"] [--project <id>]` | Merge an open CR into its `base_ref`. Fast-forward when possible, three-way merge otherwise. The default commit message is `Merge CR #<n>: <title>` (override with `-m / --message`). Fails with 409 if the CR is not `open` or there are conflicts. |
| `kortix cr close <cr> [--project <id>]` | Close an open CR without merging. Cannot close a merged CR. |
| `kortix cr reopen <cr> [--project <id>]` | Reopen a closed CR (only — merged CRs are terminal). |

`<cr>` accepts either the short per-project number (`3`, `#3`) or the
full UUID `cr_id`. Numbers are unique per project, monotonically
increasing.

#### Inside a sandbox — the typical agent flow

```sh
# 1. Check the project, then commit on the session branch
kortix validate
git add .
git commit -m "Add release-notes skill"

# 2. Push the branch (KORTIX_BRANCH_NAME)
git push origin HEAD

# 3. Open the CR — head and session are auto-detected
kortix cr open \
  --title  "Add release-notes skill" \
  --description "Drafts release notes from merged commits. Tested against the last 5 tags."

# 4. Confirm it's listed
kortix cr ls

# 5. (Optional) show the diff one more time
kortix cr diff 3
```

The agent **does not merge its own CR** — that's the user's call,
either in the dashboard or via `kortix cr merge <n>`.

#### Conflicts

`kortix cr show <cr>` prints a merge preview:

- `Mergeable cleanly` — no conflicts; `kortix cr merge` will succeed.
- `Mergeable cleanly (fast-forward)` — `head_ref` is strictly ahead of
  `base_ref`; the merge will be a fast-forward.
- `Conflicts in N files:` — listed; resolve on the branch first, push,
  then re-show.

#### Output format

`kortix cr ls` prints `#NUM`, status badge (`● open` / `✔ merged` /
`× closed`), `head_ref → base_ref` (truncated UUID-style branches),
title. Sorted newest first.

#### Exit codes

| Code | Meaning |
| --- | --- |
| `0`  | Success. |
| `1`  | Operation failed (CR not found, merge failed, etc.). |
| `2`  | Bad flag / missing required arg. |

> See `change-requests.md` (alongside this file) for the full
> data model, REST API, and the "MUST open a CR" agent mandate.

### Install / update / uninstall

| Command | Effect |
| --- | --- |
| `kortix update` | Re-runs `curl -fsSL kortix.com/install | bash` to pull the latest binary. |
| `kortix uninstall` | Removes the binary, /usr/local/bin shim, and `~/.config/kortix/`. `--keep-auth` keeps the token. |
| `kortix version` | Print the CLI version. |

### Validate and ship

| Command | What it does |
| --- | --- |
| `kortix validate` | Checks `kortix.yaml` against the schema, lints sandbox Dockerfiles and agent wiring, and warns when the files in Git are large (a file of 10 MiB or more, or more than 512 MiB in total). Exit `0` with warnings, `1` on an error. `--json` prints the report. |
| `kortix ship` | Runs the `kortix validate` checks, commits, and pushes the current branch to the project repo (laptop flow). An error stops the ship; a warning never does. `--no-verify` skips the checks. |

A session builds its agent config from the whole repository, and every
session downloads every file. Above 512 MiB compressed a running session
stops picking up agent config changes from the base branch until a new
session starts, so the size warning names the largest files. Move them to object
storage (S3, R2, GCS), or mark paths no agent reads `export-ignore` in
`.gitattributes`.

### Project scaffold

| Command | Effect |
| --- | --- |
| `kortix init` | Scaffold one general-purpose v2 project with the canonical skill source and default agent. |

```sh
kortix init my-project --yes --no-git
```

### System skills

System skills are the live agent manual for the deployed Kortix host.

| Command | Effect |
| --- | --- |
| `kortix system-skills` | List system skill names and routing descriptions. |
| `kortix system-skills get <name>` | Print the current `SKILL.md`. |
| `kortix system-skills get <name> --full` | Print `SKILL.md` and every referenced file. |
| `kortix system-skills path [name]` | Print the local project path. |

`kortix skills` is a permanent alias. Optional project skills use
`kortix marketplace`, not `system-skills`.

## Token scope

There are **two** token types issued by the Kortix API. Both use the
`kortix_pat_…` prefix; they're distinguished by an internal `project_id`
column on the token row.

| Type | Scope | Issued by | Typical use |
| --- | --- | --- | --- |
| **User token** | All projects on accounts the user belongs to + account-level routes (`/v1/accounts/me`, billing, etc.) | `kortix login` browser flow → minted via `POST /v1/accounts/tokens` | The CLI on your laptop |
| **Project token** | Read + write everything on **one** project — secrets, sessions, triggers, and change requests. Cannot list other projects or hit account-level routes. | Auto-minted at session create; surfaced via `POST /v1/projects/:id/cli-token` | The CLI inside a sandbox |

Enforcement: every project route handler checks the token's
`project_id` against the URL's `:projectId` parameter. Mismatch → 403.
Account routes (`/v1/accounts/*`) reject any project-scoped token
outright.

### Inside a sandbox

The session bootstrap injects:

```
KORTIX_TOKEN=kortix_pat_…     ← the session's one Kortix credential; the CLI authenticates with it
KORTIX_API_URL=https://<host>/v1
KORTIX_PROJECT_ID=<uuid>
KORTIX_SESSION_ID=<uuid>
KORTIX_AGENT_NAME=<agent>
KORTIX_BRANCH_NAME=<session-branch>   ← only when the agent has full repository access
```

The CLI reads `KORTIX_TOKEN` and uses `KORTIX_API_URL` as the host base. No
config file, no `kortix login` needed — `kortix …` just works. The token is
bound to this session: a route that names a session accepts only
`$KORTIX_SESSION_ID`, and it holds only the agent's `kortix_permissions`.
Provider, connector, and Git credentials stay server-side.

### Rotating

```sh
# From a logged-in user CLI:
kortix projects info                    # confirm you're on the right project
kortix project token rotate             # rotates the project token
# (existing sandboxes keep their token until they restart)
```

## Common workflows

### Spin up a fresh session with custom env

```sh
kortix secrets set STRIPE_API_KEY=sk_live_… WEBHOOK_SLACK_SECRET=whsec_…
kortix sessions new --prompt "Audit the auth module and propose a fix"
```

### Inside a session: trigger another session

```sh
# I'm an agent that just finished a big migration. Spawn a verifier:
kortix sessions new --prompt "Verify migration 0048 by running pnpm test + opening a CR if anything fails"
```

### Run a trigger by hand for debugging

```sh
kortix triggers ls                      # confirm the slug + status
kortix triggers fire daily-digest       # one-shot manual fire
kortix sessions ls | head -3            # the new session that the trigger spawned
```

### Pull current secrets into a local `.env` for development

```sh
kortix env pull                         # names only, values left blank
$EDITOR .env                            # fill in values locally
# (don't push — local-only file)
```

### Bulk-upload local `.env` to the cloud project

```sh
kortix env push --from .env
kortix secrets ls                       # confirm
```

### Land session work on `main` (the CR flow)

The agent in the sandbox is responsible for opening the CR; the user
reviews + merges. **There is no other path to `main` from inside a
session.**

```sh
# inside a session sandbox, on branch session-<id>
git add .
git commit -m "Add release-notes skill"
git push origin HEAD

kortix cr open \
  --title       "Add release-notes skill" \
  --description "Drafts release notes from merged commits. Tested against the last 5 tags."

kortix cr ls                            # confirm
```

The user can then:

```sh
kortix cr show 3                        # diff + merge-preview
kortix cr diff 3
kortix cr merge 3                       # merges into base (main)
# or
kortix cr close 3                       # close without merging
```

See `change-requests.md` next to this file for the full lifecycle,
conflict story, and data model.

## Environment variables the CLI reads

| Variable | Purpose |
| --- | --- |
| `KORTIX_TOKEN` | Session-scoped PAT the CLI authenticates with (injected in sandboxes). |
| `KORTIX_SESSION_ID` | This session. `kortix reminders`, `cr open`, and `review` default `--session` to it. |
| `KORTIX_API_URL` | API base URL. In a sandbox it already includes the `/v1` mount. |
| `KORTIX_PROJECT_ID` | Override the linked project for one command. |
| `KORTIX_CONFIG_FILE` | Override `~/.config/kortix/config.json` location (useful for tests). |
| `KORTIX_DASHBOARD_URL` | Override the dashboard URL the `login` flow opens (default: derived from API URL). |

The `KORTIX_*` env-var prefix is **reserved** for platform-injected
values. Don't declare your own project secrets with that prefix —
the secrets-manager API rejects them, and the manifest validator
warns.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Operation failed (API error, missing project, etc.). Diagnostics printed to stderr. |
| `2` | Bad flag, unknown subcommand, missing required arg. |

## What the CLI is not

- **Not a self-host installer.** That legacy lives at the old
  `~/.kortix/kortix` bash script; this binary is the cloud-native
  replacement. If you self-host, `kortix login --api http://…` still
  works against your instance — just point it at your own URL.
- **Not a `git` replacement.** `kortix cr` is the change-request
  surface; it composes with `git` rather than wrapping it.
- **Not the runtime.** The harness (OpenCode or pi) executes the agent inside the sandbox. The CLI
  is the control plane for sessions, secrets, triggers, system instructions,
  and change requests.

## See also

- `SKILL.md` in the `kortix-system` skill directory — entry point for
  the kortix-system skill. Mention the CLI from there.
- `change-requests.md` (alongside this file) — full CR data model,
  lifecycle, REST API, and the "MUST open a CR" agent mandate.
- `kortix.yaml` — the manifest the dashboard + the CLI both read.
- `Dockerfile.<slug>` (e.g. `Dockerfile.ml`) — an optional custom sandbox image when `kortix.yaml` declares it.
- `.kortix/link.json` — current dir's binding to a remote project
  (project_id + host).
