# @kortix/cli

The command line for Kortix CompanyOS, the open-source operating system for your company.

Create a workspace, the place your company works with Kortix: people,
agents, sessions, secrets, connectors and billing.

```sh
kortix workspaces create "Acme"
```

Scaffold a workspace's config repo locally:

```sh
kortix init my-workspace
```

Makes `./my-workspace/`, runs `git init -b main`, and writes the Kortix
config floor at the repo root (`kortix.yaml`, `README.md`, `agents/`,
`skills/`, `memory/MEMORY.md`), stages every file, and makes an initial commit.

## Usage

```sh
kortix init                  # interactive flow: pick a name and wire local coding agents
kortix init my-workspace     # use the given name
kortix workspaces create Acme   # create a workspace and print its id
kortix workspaces use <id>      # select it without a local scaffold
kortix ship                  # push to the linked/default workspace; create when neither exists
kortix self-host start       # run your own Kortix Cloud from Docker images
```

Scaffolding is explicit-only: `kortix init` is the one command that creates
a config repo directory. An unknown subcommand (`kortix use`, `kortix inti`, …)
errors with a suggestion — it never scaffolds. Init asks which local coding
agents to wire through `--primary` and `--agents`.

Run `kortix init --help` for the full flag list, or `kortix --help`
for the full command list (workspace, auth, work, and resource subcommands —
sessions, triggers, connectors, secrets, sandboxes, marketplace, and more).

## Log out of a custom host

`kortix logout --host <name>` clears the token and keeps the registered API URL.
The signed-out `whoami --host <name>` recovery command includes that URL explicitly.

Older installed CLIs (including v0.13.56) remove the host entry on logout.
Until you install a release with the host-retention fix, restore the registration
before signing in:

```sh
kortix hosts add custom --api http://localhost:8008
kortix hosts login custom
```

Replace `custom` and the URL with your host name and original API origin. Do not
run `hosts login custom` on an older CLI after logout without restoring the URL:
it otherwise uses the default cloud origin.

## Use Kortix from an MCP client

Claude, ChatGPT, Cursor, VS Code and Codex reach the same workspaces and sessions
as this CLI through one hosted MCP server. Nothing to install:

```sh
claude mcp add --transport http kortix https://api.kortix.com/v1/mcp
```

Setup for each client, sign-in and revocation (`kortix tokens apps ls|rm`):
<https://kortix.com/docs/connect/mcp>.

## What gets written

```
my-workspace/
├── .git/                              ← initialized on the `main` branch
├── .gitignore
├── README.md
├── kortix.yaml                        ← the manifest: registries + one block per agent
├── agents/*.md                        ← agent prompts, named by `prompt_file`
├── skills/<name>/SKILL.md             ← skills, registered under `skills:`
└── memory/MEMORY.md                   ← workspace-wide memory for agents
```

`kortix.yaml` is the only manifest. It has one format and no version key. The
workspace registers skills, tools, commands and extensions; each agent block
enables them by name. Every starter agent sets
`workspace: { project_repository: true }`, so its sessions get a checkout of
the repository. A session reads no `harnesses/`, `.kortix/`, `.opencode/` or
`.pi/` folder. Reference:
<https://kortix.com/docs/developers#kortixyaml-reference>.

`kortix validate` checks the manifest and prints one line per issue:

```
kortix.yaml:5:5  error  agents.main.toolz  unknown agent key "toolz". Did you mean "tools"?
```

An error exits `1`; warnings alone exit `0`. `kortix ship` runs the same
checks. A file with `kortix_version: 3` gets one warning: the key is obsolete
and ignored. Any other `kortix_version` value is a retired format and one
error. A running project never stops on the manifest: it applies the valid
part. With `builtin_agents.my_kortix: true`, My Kortix still runs and can fix the file.

The local coding tools you wire up (`--primary`/`--agents`, default Codex)
receive native discovery links to the canonical sources. Claude Code uses
`.claude/skills` and `.claude/agents`. Codex uses `.agents/skills`. Pi uses
`.pi/skills`. Codex, Pi, and Cursor also get a root `AGENTS.md` pointer.
Sessions in the cloud never read these links.

A cloud session runs pi.

Scaffold a config repo with:

```sh
kortix init my-workspace --yes --no-git
```

Agents can retrieve the deployed platform manual from inside a session, on either harness:

```sh
kortix system-skills
kortix system-skills get kortix-system --full
```

`kortix skills` is a permanent alias.

After the scaffold lands, one commit is made:

```
chore: init kortix project
```

Then it's yours. Add a remote, push, open in your coding agent of choice —
or run `kortix ship` to push to the linked workspace or saved host default. With neither,
ship creates the cloud workspace and pushes in one step.

`kortix projects`, `--project <id>` and `KORTIX_PROJECT_ID` are the older names
of `kortix workspaces`, `--workspace <id>` and `KORTIX_WORKSPACE_ID`. They keep
working.

## Minimum version

The API refuses a CLI older than `0.14.13`: an older CLI reads OpenCode routes the
API and the session box no longer serve. Every `/v1` request from such a CLI answers
`426`, and the CLI prints `This Kortix CLI (<version>) is older than this server
supports (minimum <version>). Update it: kortix update`. An API can raise the
minimum with `CLI_MIN_VERSION` (`major.minor.patch`); a self-host operator sets it
with `self-host env set CLI_MIN_VERSION=<version>`. A value below `0.14.13` is
ignored. Development builds (`cli/dev`) always pass.

## Self-host

One command surface manages two deployment targets. `docker` ("this machine")
is the backward-compatible default for local and smaller installations; `aws-ec2`
("AWS EC2") is the enterprise target and records only AWS coordinates and release
policy locally. Secrets for AWS deployments are written directly to the customer
account. (The AWS target was previously named `aws-vpc`; existing instance configs
that still say `aws-vpc` on disk keep working — they load as `aws-ec2`.)

### Docker

```sh
pnpm install
./bin/kortix --help
./bin/kortix self-host init --target docker
./bin/kortix self-host plan
./bin/kortix self-host start
./bin/kortix self-host configure
./bin/kortix self-host env set PUBLIC_URL=https://kortix.example.com API_PUBLIC_URL=https://api.example.com
./bin/kortix hosts ls
./bin/kortix hosts use local
./bin/kortix hosts use cloud
```

`self-host start` creates the config when needed and only asks for external
connections: GitHub and Pipedream. Run `self-host configure` later
to change those credentials.

The generated Docker distribution embeds a pinned copy of the official full
Supabase stack: PostgreSQL 17, Auth, REST, Realtime, Storage, imgproxy, Meta,
Edge Runtime, Kong, Studio, Supavisor, Logflare, and Vector. Published ports
bind to loopback by default, and all generated secret material is stored in the
owner-only instance `.env`.

Set `KORTIX_FRONTEND_MEMORY_LIMIT=1024m` through `self-host env set` to raise
only the frontend container's memory limit. The default is `512m` per replica.
The setting persists through later updates.

### Enterprise AWS EC2

```sh
export AWS_PROFILE=customer

./bin/kortix self-host init \
  --target aws-ec2 \
  --instance customer \
  --region us-west-2 \
  --channel stable \
  --yes

./bin/kortix self-host doctor --instance customer
./bin/kortix self-host plan --instance customer
./bin/kortix self-host deploy --instance customer
./bin/kortix self-host status --instance customer
./bin/kortix self-host reconcile --instance customer --channel stable
```

For AWS, the CLI is the bootstrap and operator remote control. The customer-
owned updater, scheduler, EKS controllers, and recovery automation continue
operating after the CLI exits. `start`, `stop`, and direct environment-file
editing are intentionally Docker-only.
