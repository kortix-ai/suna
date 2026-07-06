# @kortix/cli

Create a new Kortix project.

```sh
kortix my-project
```

Makes `./my-project/`, runs `git init -b main`, drops the full OpenCode
runtime scaffold at the repo root (`kortix.yaml`, `README.md`,
`.kortix/opencode/`, `.kortix/memory/MEMORY.md`), stages every file, and
makes an initial commit.

## Usage

```sh
kortix                       # prompt for a project name, then create
kortix my-project            # use the given name, no prompt
kortix init                  # fuller interactive flow: pick a template,
                              # wire up coding agents, install marketplace skills
kortix ship                  # create the cloud project (first run) + push your code
kortix self-host start       # run your own Kortix Cloud from Docker images
```

`kortix <project-name>` is the fast path (like `create-next-app`): name it
and go. `kortix init` is the same scaffold with more choices up front —
which coding agent(s) to wire (`--primary`, `--agents`), which starter
template (`--template minimal|general-knowledge-worker`), and which
marketplace skills to install (`--marketplace`).

### Flags (`kortix <project-name>`)

| Flag | Effect |
|---|---|
| `--no-commit` | Run `git init` but don't create the initial commit. |
| `--no-git` | Skip `git init` entirely. |
| `--help` / `-h` | Show help. |
| `--version` / `-v` | Print version. |

Run `kortix init --help` for the fuller flow's flags, or `kortix --help`
for the full command list (project, auth, work, and resource subcommands —
sessions, triggers, connectors, secrets, sandboxes, marketplace, and more).

## What gets written

```
my-project/
├── .git/                              ← initialized on the `main` branch
├── .gitignore
├── README.md
├── kortix.yaml                        ← project manifest (agents: map, triggers, sandbox, apps)
└── .kortix/
    ├── memory/MEMORY.md               ← project-wide memory for agents
    └── opencode/                      ← OpenCode native config dir
        ├── opencode.jsonc             ← runtime config (providers, plugins, MCP servers, …)
        ├── agents/{kortix,memory-reflector}.md
        └── skills/kortix-system/SKILL.md (+ other bundled skills)
```

The coding agent(s) you wire up (`--primary`/`--agents`, default OpenCode)
each get their native discovery directory symlinked straight at
`.kortix/opencode/` — `.opencode` for OpenCode, `.claude` for Claude Code,
`.agents` for Codex — so skills and agents stay shared from one source
of truth. Codex and Cursor also get a root `AGENTS.md` pointer.

After the scaffold lands, one commit is made:

```
chore: init kortix project
```

Then it's yours. Add a remote, push, open in your coding agent of choice —
or run `kortix ship` to create the cloud project and push in one step.

## Self-host

```sh
pnpm install
./bin/kortix --help
./bin/kortix self-host start
./bin/kortix self-host configure
./bin/kortix self-host env set PUBLIC_URL=https://kortix.example.com API_PUBLIC_URL=https://api.example.com
./bin/kortix hosts ls
./bin/kortix hosts use local
./bin/kortix hosts use cloud
```

`self-host start` creates the config when needed and only asks for product
integrations: Freestyle, GitHub, and Pipedream. Run `self-host configure` later
to change those credentials.
