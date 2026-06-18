# @kortix/registry

The Kortix **registry + marketplace engine** — share and 1-click install skills,
agents, commands, tools, arbitrary files/folders, or whole projects.

It is a **superset of the [shadcn registry format](https://ui.shadcn.com/docs/registry)**:

- The **format is shadcn's** (`registry.json` / `registry-item.json`, `$schema`,
  `include` composition, `registryDependencies`, namespaces). So **any GitHub
  repo with a `registry.json` is a registry** — no server, no build step — and
  shadcn tooling can read the plain-file items.
- The **installer is Kortix's**, because our install target is a repo's
  `.kortix/` that gets committed and materialized in a session — something
  `npx shadcn add` (which writes into a local Next.js app) structurally can't do.

> **Why not just shadcn?** The schema is shadcn's biggest gift; we use it
> verbatim. But "install = commit into the project's GitHub repo → live in the
> next session", plus private/company registries behind Kortix auth, require our
> own installer. Hybrid keeps the open interop *and* the Kortix-native behavior.

## The format

A registry is a `registry.json` at a repo root:

```jsonc
{
  "$schema": "https://ui.shadcn.com/schema/registry.json",
  "name": "kortix-ai/skills",
  "items": [
    {
      "name": "pdf",
      "type": "registry:skill",
      "title": "PDF",
      "description": "Create, edit, OCR, fill, convert PDFs.",
      "files": [
        { "path": ".kortix/opencode/skills/pdf/SKILL.md", "type": "registry:file", "target": "@skills/pdf/SKILL.md" }
      ]
    }
  ]
}
```

### Item types

shadcn's types (`registry:file`, `registry:component`, `registry:lib`, …) plus
Kortix-native ones:

| type | what it is |
| --- | --- |
| `registry:skill` | an OpenCode `SKILL.md` (+ its reference files/folders) |
| `registry:agent` | an agent persona `.md` |
| `registry:command` | an OpenCode slash command `.md` |
| `registry:tool` | a custom OpenCode tool (`.ts`) / plugin |
| `registry:trigger` | a `kortix.toml` `[[triggers]]` block |
| `registry:connector` | an integration definition (Pipedream/MCP/HTTP) |
| `registry:rules` | `AGENTS.md` / rules files |
| `registry:memory` | seed memory files |
| `registry:project` | a whole Kortix project scaffold |
| `registry:bundle` | a curated set of other items (a "use-case"/starter) |

Every item is ultimately **files copied to `target` paths** — the richer type
drives categorization, icons, and validation.

### Target aliases

A file's `target` says where it lands. Aliases expand against the consuming
project's layout (the OpenCode config dir comes from `[opencode] config_dir` in
`kortix.toml`, default `.kortix/opencode`):

| alias | expands to |
| --- | --- |
| `~/x` | `x` (repo root — shadcn-compatible) |
| `@opencode/x` | `<configDir>/x` |
| `@skills/x` | `<configDir>/skills/x` |
| `@agents/x` | `<configDir>/agents/x` |
| `@commands/x` | `<configDir>/commands/x` |
| `@tools/x` | `<configDir>/tools/x` |
| `@memory/x` | `.kortix/memory/x` |

## The CLI

```bash
# Author: turn this repo into a registry (scans skills/agents/commands/tools)
kortix registry build --name my-org/my-repo

# Browse a registry (GitHub repo, URL, or local path)
kortix registry list   kortix-ai/skills
kortix registry search kortix-ai/skills --query pdf
kortix registry view   kortix-ai/skills/pdf

# 1-click install an item (skill / agent / command / file / folder / bundle)
kortix add kortix-ai/skills/pdf            # GitHub registry item
kortix add github:kortix-ai/skills@v1/pdf  # pinned ref
kortix add @kortix/pdf                     # namespaced registry
kortix add ./local/registry.json#pdf       # a local registry
kortix add https://host/r/pdf.json         # a direct item URL
kortix add kortix-ai/skills/pdf --dry-run  # preview, write nothing
```

Installing writes the files into `.kortix/` and records them (with content
hashes) in `registry-lock.json`. Then `git commit && kortix ship` makes them
live — or use `--project <id>` to commit straight into a linked cloud project.

Publish *anything* (arbitrary files, whole folders, a project bundle) by
hand-writing a partial registry in `kortix.registry.json`; `kortix registry
build` merges it and expands any folder `path` into per-file entries.

## The marketplace: three scopes, one format

The same registry format at three visibility levels:

1. **Repo** — a project's own `registry.json`; install with `kortix add owner/repo/item`.
2. **Company** — an org registry repo (e.g. `kortix-ai/skills`) shown in
   **Customize → Add**, behind Kortix auth for private repos.
3. **Global** — a Kortix-hosted gallery (`/marketplace`) aggregating curated +
   community registries, with an **"Add to project"** button that commits the
   item into the chosen project's repo.

## Engine API

```ts
import {
  buildRegistry,        // repo → registry.json
  loadItem, loadRegistry, // resolve from GitHub / URL / disk (+ include)
  planInstall,          // resolve targets + transitive registryDependencies (pure)
  applyInstall,         // write files + update the lock
  validateRegistry,     // structural validation
  readLock,             // registry-lock.json (migrates legacy skills-lock.json)
} from '@kortix/registry';
```

`planInstall` is pure (no disk writes), so callers can preview (`--dry-run`) and
the **API/web can reuse it to produce files to *commit*** into a project repo
instead of writing to a working tree.

## Status

- ✅ Format + types, validation, address parsing, GitHub/URL/local fetch with
  `include`, build, install planner + lock, `kortix add` + `kortix registry`,
  unit tests, proven end-to-end on the 69-skill starter pack.
- 🚧 `kortix add --project <id>` → commit into a linked cloud project's repo
  (via a `POST /projects/:id/files/commit` endpoint reusing `commitFileToBranch`).
- 🔜 API list/install endpoints + the web `/marketplace` gallery (the 3-scope UI).
- 🔜 Make `kortix init` emit a `registry.json` so every new project ships as a
  registry out of the box.
