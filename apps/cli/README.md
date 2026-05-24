# @kortix/cli

Create a new Kortix project.

```sh
kortix my-project
```

Makes `./my-project/`, runs `git init -b main`, drops an OpenCode-native
scaffold at the repo root (`kortix.toml`, `CONTEXT.md`, `README.md`,
`.opencode/`), stages every file, and makes an initial commit. That's
the whole CLI.

## Usage

```sh
kortix                  # prompt for a project name, then create
kortix my-project       # use the given name, no prompt
kortix self-host start  # run your own Kortix Cloud from Docker images
```

### Flags

| Flag | Effect |
|---|---|
| `--no-commit` | Run `git init` but don't create the initial commit. |
| `--no-git` | Skip `git init` entirely. |
| `--help` / `-h` | Show help. |
| `--version` / `-v` | Print version. |

## What gets written

```
my-project/
├── .git/                              ← initialized on the `main` branch
├── .gitignore
├── README.md
├── kortix.toml                        ← project manifest
├── CONTEXT.md                         ← project-wide context for agents
└── .opencode/                         ← OpenCode native location, no env override
    ├── opencode.jsonc                 ← runtime config (providers, default agent, …)
    ├── agents/{default,reviewer}.md
    ├── commands/{plan,test}.md
    └── skills/git-workflow/SKILL.md
```

After the scaffold lands, one commit is made:

```
chore: init kortix project
```

Then it's yours. Add a remote, push, open in OpenCode.

## Self-host

```sh
pnpm install
./bin/kortix --help
./bin/kortix self-host init
./bin/kortix self-host start
```
