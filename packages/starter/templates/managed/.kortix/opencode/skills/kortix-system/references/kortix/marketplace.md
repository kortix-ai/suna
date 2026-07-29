# Kortix Marketplace

The Kortix Marketplace is the project skill library. It lets agents and humans
discover, install, inspect, remove, and update reusable skills without copying
files by hand. In the launch scope, the visible marketplace is skills-first:
OpenCode agents, tools, plugins, and bundles may exist in the registry model,
but normal browse/install flows should treat Marketplace as the skill surface.

Use Marketplace before writing a new skill. Search first, inspect the candidate,
install it if it fits, and only author a new skill when the library does not
cover the user's need.

## Mental Model

- **Git owns the files.** A marketplace item resolves to source files from a
  registry repo or registry JSON endpoint.
- **The project owns the install.** Installing copies files into the project
  repo, usually under `.kortix/opencode/skills/<name>/`.
- **The lock is the installed-state truth.** `registry-lock.json` records every
  installed item, source, target file, and SHA-256 content hash.
- **Updates are file-hash diffs.** An update is available when fresh marketplace
  files differ from what `registry-lock.json` records: changed, added, or
  removed files. Do not infer updates from a display version alone.
- **Every mutation is a git commit.** Install, update, update-all, and remove
  commit the changed files and lock update to the project repo. There is no
  hidden runtime-only install state.
- **Existing projects stay compatible.** New installs use `registry-lock.json`.
  Older `skills-lock.json` files are read through the lock parser so projects
  can migrate without breaking installed-status and update checks.

## Consumer CLI

Use these commands from a Kortix project or session:

```sh
kortix marketplace search <query>
kortix marketplace search <query> --json
kortix marketplace list --source kortix
kortix marketplace show <name>
kortix marketplace show <id> --json
kortix marketplace install <name> --project <project-id>
kortix marketplace install <name> --project <project-id> --dry-run
kortix marketplace status --project <project-id>
kortix marketplace updates --project <project-id>
kortix marketplace update <name> --project <project-id>
kortix marketplace update --all --project <project-id>
kortix marketplace remove <name> --project <project-id>
```

Prefer `--json` when an agent needs to make a decision from command output.
Do not scrape tables.

Inside a Kortix session, the CLI is pre-authenticated for the current project.
If the command needs a project id, use `kortix projects info --json` first or
pass the id the user gave you.

## Web UI

The web equivalent is the project's Marketplace or Customize surface:

- Explore/search lists available skills from enabled marketplace sources.
- Installed/status views read the project's lock file.
- Add commits a marketplace install into the repo.
- Update all should batch outdated installed skills into a single server-side
  update commit.

If the UI status disagrees with CLI status, trust the lock-backed API and debug
the UI query/status mapping.

## Install Workflow

1. Search for a candidate:
   ```sh
   kortix marketplace search "slides" --json
   ```
2. Inspect it:
   ```sh
   kortix marketplace show presentations --json
   ```
3. Install it:
   ```sh
   kortix marketplace install presentations --project <project-id>
   ```
4. Verify installed state:
   ```sh
   kortix marketplace status --project <project-id> --json
   ```
5. In the next session, the skill is available from `.kortix/opencode/skills/`.

Install writes the item files plus `registry-lock.json`. It should be treated as
a normal project code change: review the diff when needed and revert through git
if the install was wrong.

## Update Workflow

Check for updates:

```sh
kortix marketplace updates --project <project-id> --json
```

Update one item:

```sh
kortix marketplace update presentations --project <project-id>
```

Update every outdated item in one commit:

```sh
kortix marketplace update --all --project <project-id>
```

Use `update --all` when multiple installed skills are outdated. It resolves all
changed items server-side and commits one combined file/lock change, which keeps
history cleaner and avoids half-updated skill sets.

## Default Starter Skills

New projects are scaffolded from the minimal runtime floor, then selected
starter skills are installed through the marketplace pipeline. This means the
skills show as installed because the lock records them, not because the UI keeps
a separate "starter included" flag.

Default starter skills are intentionally optional skills, not Kortix-managed
runtime floor files. The current starter selection is biased toward broadly
useful knowledge work: research, reports, document review, PDF, DOCX, XLSX,
presentations, website building, and browser automation.

## Kortix-Managed vs Starter Skills

`managedBy: "kortix"` is reserved for first-party runtime skills that Kortix
owns as platform infrastructure, such as `kortix-system`, `kortix-memory`,
`kortix-executor`, `kortix-slack`, and `kortix-computer`.

Starter skills are different. They are default suggestions installed into new
projects, but users can remove, edit, or replace them like ordinary project
source. Do not describe every default starter skill as Kortix-managed unless
the catalog marks it that way.

## Marketplace vs Registry

Use **`kortix marketplace`** for consuming items:

- search
- list
- show
- install
- status
- updates
- update
- remove

Use **`kortix registry`** only when authoring or validating a registry source:

- build
- validate
- inspect generated registry JSON

Normal project agents should not run registry build/validate/publish to install
skills. Registry commands are for developers maintaining a marketplace source.

## Sources

Marketplace data can come from:

- the embedded Kortix starter marketplace source
- default trusted external sources
- platform-configured marketplace sources
- user-added GitHub repos or `registry.json` URLs

A source can point at a GitHub repo or at a registry JSON URL. For GitHub repos,
Kortix scans for `SKILL.md` files and imports each skill. Sparse paths can limit
the scan to specific folders.

## When To Create A New Skill

Create a new skill only after these checks:

1. Search the marketplace for the task, domain, and file type.
2. Inspect likely matches with `kortix marketplace show`.
3. Prefer installing an existing skill if it covers the workflow.
4. If nothing fits, create a focused project-local skill under
   `.kortix/opencode/skills/<name>/SKILL.md`.
5. If the skill should be reused across projects, move it into a registry source
   and publish/index that source separately.

Keep project-local skills small and specific. Marketplace skills should carry
clear descriptions and only the files they need.
