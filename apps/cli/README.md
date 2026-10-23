# @kortix/cli

Create a new Kortix project.

```sh
kortix init my-project
```

Makes `./my-project/`, runs `git init -b main`, and writes the Kortix
project floor at the repo root (`kortix.yaml`, `README.md`, `agents/`,
`skills/`, `memory/MEMORY.md`), stages every file, and makes an initial commit.

## Usage

```sh
kortix init                  # interactive flow: pick a name and wire local coding agents
kortix init my-project       # use the given name
kortix projects create my-project # create a remote project and print its id
kortix projects use <project_id>  # select it without a local scaffold
kortix ship                  # push to linked/default project; create when neither exists
kortix self-host start       # run your own Kortix Cloud from Docker images
```

Scaffolding is explicit-only: `kortix init` is the one command that creates
a project directory. An unknown subcommand (`kortix use`, `kortix inti`, …)
errors with a suggestion — it never scaffolds. Init asks which local coding
agents to wire through `--primary` and `--agents`.

Run `kortix init --help` for the full flag list, or `kortix --help`
for the full command list (project, auth, work, and resource subcommands —
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

Claude, ChatGPT, Cursor, VS Code and Codex reach the same projects and sessions
as this CLI through one hosted MCP server. Nothing to install:

```sh
claude mcp add --transport http kortix https://api.kortix.com/v1/mcp
```

Setup for each client, sign-in and revocation (`kortix tokens apps ls|rm`):
<https://kortix.com/docs/connect/mcp>.

## What gets written

```
my-project/
├── .git/                              ← initialized on the `main` branch
├── .gitignore
├── README.md
├── kortix.yaml                        ← kortix_version 3: registries + one block per agent
├── agents/*.md                        ← agent prompts, named by `prompt_file`
├── skills/<name>/SKILL.md             ← skills, registered under `skills:`
└── memory/MEMORY.md                   ← project-wide memory for agents
```

`kortix.yaml` is `kortix_version: 3`. The project registers skills, tools,
commands and extensions; each agent block enables them by name. A v3 session
reads no `harnesses/`, `.kortix/`, `.opencode/` or `.pi/` folder. Reference:
<https://kortix.com/docs/project/manifest>.

Projects on `kortix_version` 1 or 2 keep their layout (`agents/<name>.md` with
frontmatter, `harnesses/opencode/`, `harnesses/pi/`, or `.kortix/opencode/`)
and still run. `kortix migrate` prints the v3 manifest for a v2 project, and
`kortix migrate --write` writes it.

The local coding tools you wire up (`--primary`/`--agents`, default Codex)
receive native discovery links to the canonical sources. Claude Code uses
`.claude/skills`, `.claude/agents`, and `.claude/commands`. Codex uses
`.agents/skills`. Pi uses `.pi/skills`. Codex, Pi, and Cursor also get a root
`AGENTS.md` pointer. Sessions in the cloud never read these links.

A cloud session runs pi. OpenCode is deprecated: only a session that started
on it before 2026-10-23 still runs it. The CLI talks to the same Kortix routes
on both.

Create a project with:

```sh
kortix init my-project --yes --no-git
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
or run `kortix ship` to push to the linked project or saved host default. With neither,
ship creates the cloud project and pushes in one step.

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
