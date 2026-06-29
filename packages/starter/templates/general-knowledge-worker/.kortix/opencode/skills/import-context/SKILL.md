---
name: import-context
description: "Migrate a user's local Claude Code / Codex setup into Kortix — Agent Skills, memories/rules, and MCP server connectors. Use when the user wants to bring their local Claude Code or Codex skills, CLAUDE.md / AGENTS.md preferences, or configured MCP servers over to a Kortix project, or says 'import my local skills', 'bring my Claude memories over', 'match my MCPs to Kortix connectors', 'set up what I use locally here', or 'switch from Claude Code / Codex'."
---

# Import Context

> **Marketplace skill — migrate your local Claude Code / Codex skills, memories, and MCP connectors into Kortix.**

Brings a developer's existing Claude Code / Codex setup into a Kortix project.
Three independent tracks — **Skills**, **Memories**, **Connectors** — each with
its own local source and its own Kortix target. Run any subset; if the user asks
for several at once, do them one at a time and report each separately.

The throughline: discover from the same canonical local paths Claude Code and
Codex already use, then land each thing the *Kortix* way — skill files via a
change request, memories via the `memory` tool, MCP servers as Kortix connectors.

## Getting the local files in front of you

The source files live on the user's own machine, not in this sandbox. Two modes:

- **Filesystem access** (running via the local Kortix CLI / desktop app, with the
  home directory reachable) — run the discovery snippets below directly.
- **Sandboxed** (no access to `~`) — hand the user the matching discovery one-liner,
  have them paste the output back, or have them zip the relevant directory (e.g.
  `~/.claude/skills`) and upload it into the session. Then import from the upload.

Either way, only scan the **user-level** roots below by default. Never blanket-scan
`~`. Touch a project's repo-local config only when the user names that project.

## Track A — Skills

**Local source** (Agent Skill directories, each a folder with a `SKILL.md`):

- `~/.claude/skills/` — Claude Code personal skills
- `~/.claude/plugins/marketplaces/*/plugins/*/skills/` and
  `~/.claude/plugins/marketplaces/*/external_plugins/*/skills/` — plugin-bundled
- `~/.codex/skills/` and `~/.agents/skills/` — Codex

Discover:

```sh
for root in ~/.claude/skills ~/.codex/skills ~/.agents/skills \
            ~/.claude/plugins/marketplaces/*/plugins/*/skills \
            ~/.claude/plugins/marketplaces/*/external_plugins/*/skills; do
  [ -d "$root" ] && find "$root" -maxdepth 2 -name SKILL.md -print
done
```

`~/.claude/commands/*.md` are single-file slash commands, **not** skills — skip
them. Two plugins can ship skills with the same directory leaf; they aren't
interchangeable, so show both and let the user pick which (or skip the name) —
only one name can win per project.

**Before copying, check the Kortix marketplace.** An installed skill beats a
copied one: `kortix marketplace search "<topic>" --json`, inspect with
`kortix marketplace show <name> --json`, and `install` it if it covers the
workflow. Only carry the user's own version over when nothing matches.

**Import** each approved skill into the canonical Kortix home:

```
.kortix/opencode/skills/<name>/        # the directory name MUST equal frontmatter `name`
```

Copy the whole directory (SKILL.md plus any `scripts/`, `references/`, `assets/`).
Then **validate** — this step is universal across runtimes:

```sh
agentskills validate .kortix/opencode/skills/<name>/
```

Skip any skill that fails validation and report the reason. Common breakers: a
`name` that doesn't match the directory, isn't unique among the project's skills,
or violates `^[a-z0-9]+(-[a-z0-9]+)*$`; missing `name`/`description`. (Full rules
in the `create-skill` skill.)

**Land** the imported skills with a change request — a skill on a session branch
is invisible to future sessions until the CR merges:

```sh
git add .kortix/opencode/skills
git commit -m "import: bring over local Claude Code / Codex skills"
git push origin HEAD
kortix cr open --title "Import local skills" --description "Skills migrated from ~/.claude and ~/.codex."
```

> Mapping: Claude Code/Codex skill folders → `.kortix/opencode/skills/`; the
> upload step that other tools call `save_custom_skill` is, in Kortix, just
> committing the files via a CR. For reuse across projects, publish them to a
> marketplace/registry source instead of copy-pasting.

## Track B — Memories

**Local source** (instructions, rules, auto-memory):

- `~/.claude/CLAUDE.md`, `~/.claude/rules/*.md`, `~/.claude/projects/*/memory/*.md`
- `~/.codex/AGENTS.md`, `~/.codex/AGENTS.override.md`, `~/.codex/memories/*.md`

Discover (dump each file with a header so you can attribute it):

```sh
for f in ~/.claude/CLAUDE.md ~/.claude/rules/*.md ~/.claude/projects/*/memory/*.md \
         ~/.codex/AGENTS.override.md ~/.codex/AGENTS.md ~/.codex/memories/*.md; do
  [ -f "$f" ] && { printf '\n=== %s ===\n' "$f"; head -c 40000 "$f"; }
done
```

Repo-scoped `CLAUDE.md` / `AGENTS.md` are usually project-specific — only scan
them if the user names a project.

**Filter aggressively — this is the hard part.** These files are mostly
coding-tool-specific (build commands, CLI wrappers, repo paths, linter rules) and
importing them wholesale poisons a general-purpose project brain. Keep only
**durable, agent-agnostic** entries:

- Communication style — "be concise", "lead with the answer", "no emojis".
- Working-style preferences — "surface tradeoffs", "ask before touching shared state".
- Persistent facts about the user — role, team, expertise, name.

Drop tool/build/path-specific instructions and one-off task notes. A typical
auto-memory sidecar yields one entry; a `CLAUDE.md` yields a few or zero. (Same
KEEP/DROP rubric the `kortix-memory` skill defines.)

**Write** each kept preference into the project brain via the **`memory` tool**
(not `write`/`edit`), into `.kortix/memory/` — most fit `conventions.md` or
`overview.md`; create a dedicated file only if a topic earns one, and keep
`MEMORY.md` in sync. Then land it via CR (`memory: import local preferences`).
Re-running creates duplicates — the memory layer has no dedup, so warn the user
before a second pass.

> Mapping: the per-entry upload other tools call `memory_update` is, in Kortix,
> the `memory` tool writing into `.kortix/memory/` — see the `kortix-memory` skill
> for the full protocol.

## Track C — Connectors

**Local source** (MCP server configs — names only; **no credentials are transferred**):

- `~/.claude.json` — top-level `mcpServers` (user scope; skip the nested
  `projects.<path>.mcpServers` entries unless the user names that project)
- `~/.codex/config.toml` — `[mcp_servers.<name>]` sections

Discover:

```sh
jq -r '.mcpServers // {} | keys[]' ~/.claude.json 2>/dev/null
grep -E '^\[mcp_servers\.[A-Za-z0-9_-]+\]' ~/.codex/config.toml 2>/dev/null \
  | sed -E 's/^\[mcp_servers\.//; s/\]$//'
```

**Match** each server to a Kortix connector by name. List the catalog —

```sh
kortix executor connectors          # or the `connectors` MCP tool — names + connection status
```

— and map known products (a local `notion` server → the Notion connector, etc.).
When a name is opaque or could map to more than one, suggest the likeliest and
confirm before acting. Classify each: already connected · mappable-not-connected ·
no Kortix equivalent.

**Connect** the approved, not-yet-connected matches via the credentials flow
(`kortix-system` → *Credentials & setup links*) — never paste raw keys:

```sh
kortix executor add notion --provider pipedream --app notion   # add_connector — instant, no CR
kortix executor connect notion                                 # connect — mints a 1-click link
# API-key provider instead of OAuth:
kortix secrets request SOME_API_KEY --scope connector          # request_secret — mints a secret link
```

Surface the link, end your turn, and verify it landed
(`kortix executor connectors`) when the user returns.

> This matches your local MCP servers to Kortix connectors by service name
> only — it never moves or copies credentials. Authorize each match with the
> Kortix `connect` link or `kortix secrets request`.

## Report once at the end

One short table per track you ran:

```
| Track     | Item        | Status      | Notes                                   |
| --------- | ----------- | ----------- | --------------------------------------- |
| Skill     | <name>      | Imported    | In CR #N, pending merge                 |
| Skill     | <name>      | Skipped     | Failed agentskills validate: <reason>   |
| Memory    | CLAUDE.md   | Skipped     | Coding-tool-specific — nothing portable |
| Connector | notion      | Auth pending| Connect link surfaced; awaiting user    |
```

## Gotchas

- **Nothing reaches future sessions until the CR merges.** Imported skills and
  memory edits live only on the session branch until then. Open the CR; don't
  merge your own.
- **Memory import has no dedup.** A second run re-adds everything — warn first.
- **Skip-and-report on validation failure.** A skill that fails `agentskills
  validate` doesn't get committed; surface why.
- **Confirm ambiguous connector matches.** Map by name only when it's
  unmistakable; otherwise ask. Never transfer or paste raw credentials — the
  connect/secret link flow is the only path.
- **Don't blanket-scan `~`.** Stick to the canonical roots above; reach into a
  project repo only when the user names it.

## Related skills

- **create-skill** — the SKILL.md spec and validation rules an imported skill must satisfy.
- **kortix-memory** — the project-brain rubric and the `memory` tool protocol.
- **kortix-system** — change requests, the connector catalog, and the credentials/setup-link flow.
