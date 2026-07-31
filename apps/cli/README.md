# @kortix/cli

Create a new Kortix project.

```sh
kortix init my-project
```

Makes `./my-project/`, runs `git init -b main`, and writes the Kortix
project floor at the repo root (`kortix.yaml`, `README.md`,
`.kortix/opencode/`, `.kortix/memory/MEMORY.md`), stages every file, and
makes an initial commit.

## Usage

```sh
kortix init                  # interactive flow: pick a name and wire local coding agents
kortix init my-project       # use the given name
kortix ship                  # create the cloud project (first run) + push your code
kortix self-host start       # run your own Kortix Cloud from Docker images
```

Scaffolding is explicit-only: `kortix init` is the one command that creates
a project directory. An unknown subcommand (`kortix use`, `kortix inti`, …)
errors with a suggestion — it never scaffolds. Init asks which local coding
agents to wire through `--primary` and `--agents`.

Run `kortix init --help` for the full flag list, or `kortix --help`
for the full command list (project, auth, work, and resource subcommands —
sessions, triggers, connectors, secrets, sandboxes, marketplace, and more).

## What gets written

```
my-project/
├── .git/                              ← initialized on the `main` branch
├── .gitignore
├── README.md
├── kortix.yaml                        ← v2 OpenCode manifest
└── .kortix/
    ├── memory/MEMORY.md               ← project-wide memory for agents
    └── opencode/                      ← OpenCode native config dir
        ├── opencode.jsonc             ← runtime config (providers, plugins, MCP servers, …)
        ├── agents/{kortix,memory-reflector}.md
        └── skills/kortix-cli/SKILL.md (+ the artifact skill floor)
```

The local coding tools you wire up (`--primary`/`--agents`, default Codex)
receive native discovery links to the canonical `.kortix/opencode` source.
OpenCode uses `.opencode`. Claude Code uses `.claude/skills`,
`.claude/agents`, and `.claude/commands`. Codex uses `.agents`. Pi uses
`.pi/skills`. Codex, Pi, and Cursor also get a root `AGENTS.md` pointer.

The public starter uses `kortix_version: 2`. Cloud sessions run OpenCode REST.

Create a project with:

```sh
kortix init my-project --yes --no-git
```

Agents can retrieve the deployed platform manual from OpenCode:

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
or run `kortix ship` to create the cloud project and push in one step.

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

`self-host start` creates the config when needed and only asks for product
integrations: GitHub and Pipedream. Run `self-host configure` later
to change those credentials.

The generated Docker distribution embeds a pinned copy of the official full
Supabase stack: PostgreSQL 17, Auth, REST, Realtime, Storage, imgproxy, Meta,
Edge Runtime, Kong, Studio, Supavisor, Logflare, and Vector. Published ports
bind to loopback by default, and all generated secret material is stored in the
owner-only instance `.env`.

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
