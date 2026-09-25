/**
 * The seed prompt for "Migrate to v2" — a normal agent session does the
 * conversion because it's just files + git (Marko's framing). We start a
 * fresh session with this as the first message; the project's default agent
 * reads the repo, rewrites the manifest, and opens a change request for a
 * human to review. Nothing here merges anything — that's the whole point of
 * routing config changes through the same CR path as any other edit.
 *
 * Simplified by the 2026-07-05 redirect (spec docs/specs/2026-07-05-agent-
 * first-config-unification.md, "one home per concern"): v1's `.md` frontmatter
 * IS already valid v2 OpenCode behavior — a stock OpenCode agent file, no
 * Kortix-specific split. The manifest side therefore touches ONLY governance
 * (kortix.toml's `[[agents]]` → kortix.yaml's `agents:` map). The same change
 * request also moves the project to the root layout (`agents/`, `skills/`,
 * `memory/`, `harnesses/opencode/`; see `@kortix/manifest-schema/layout`):
 * each agent's `.md` moves with `git mv`, and only its old path references
 * change.
 *
 * The prompt carries the ENTIRE v1→v2 contract inline — every clean-break the
 * v2 validator enforces, a worked before/after example, and pointers to the
 * canonical JSON Schema (`kortix schema --version 2` in the sandbox, or the
 * published kortix.com/schema documents) — so the agent never has to guess at
 * the target shape and `kortix validate` passes on the first try.
 *
 * Kept as a plain exported constant (not inlined at the call site) so it's
 * independently testable and diffable — this is the load-bearing artifact of
 * the feature, not the wiring around it.
 */
export const MIGRATE_TO_V2_PROMPT = `Migrate this project's manifest from kortix_version 1 (kortix.toml) to kortix_version 2 (kortix.yaml), and move its files to the root layout. Read everything first, then make the change, then land it as a change request — do not merge it yourself.

## 1. Read before you write

- The current manifest: \`kortix.toml\` (or \`kortix.yaml\` if this project already partially moved — check \`kortix_version\` at the top either way).
- Any \`[[agents]]\` entries in the v1 manifest — these carry \`connectors\`, \`kortix_permissions\` (older manifests spell it \`kortix_cli\`), and \`env\` grants per agent name. An agent name with NO \`[[agents]]\` entry at all is today unrestricted (v1's back-compat default is "all" when a grant key is omitted).
- \`.kortix/opencode/opencode.jsonc\` — if it sets a top-level \`default_agent\`, that is the project's existing default; use it. If it doesn't, pick the agent whose \`.kortix/opencode/agents/*.md\` frontmatter has \`mode: primary\` and reads as the general/primary one (usually the first-created or the one with the broadest permissions). Record which you picked and why in the change request description — a human reviews this before it merges, so a defensible choice beats blocking on it.
- **You do NOT need to read each agent's \`.md\` frontmatter to migrate it.** v1's frontmatter (mode/model/temperature/permission/prompt/…) is ALREADY valid v2 OpenCode behavior — its content stays unchanged. Only the file moves (section 5). The manifest conversion is governance-only.
- The current layout: v1 projects keep agents in \`.kortix/opencode/agents/\`, skills in \`.kortix/opencode/skills/\`, the other OpenCode files in \`.kortix/opencode/\`, and memory in \`.kortix/memory/\`. A v1 manifest that sets \`opencode.config_dir\` uses that directory instead of \`.kortix/opencode\`.

## 2. Bring the platform baseline up to date first

A project still on a v1 manifest is usually also running stale platform skills. Refresh them BEFORE touching the manifest so the migration lands on a current baseline:

1. \`kortix marketplace updates\` — a hash-diff report of every marketplace-tracked item (the kortix-managed skills like \`kortix-system\`/\`kortix-memory\`, plus any marketplace skills the user installed).
2. If updates are listed, apply them: \`kortix marketplace update --all\`. **This commits directly to \`main\` through the platform's own hash-safe update path — it is intentionally NOT part of your change request.** It only rewrites files whose installed hash no longer matches the catalog, so untouched user files are never clobbered.
3. Sync your session branch on top of the refreshed main: \`git fetch origin && git rebase origin/main\`.
4. Items reported as \`orphaned\` (no longer in the catalog) are not updatable — leave them alone and mention them in the change request description.
5. Marketplace-tracked items are the ONLY thing you refresh this way. Do NOT hand-update anything else "to latest": agents' \`.md\` files, the memory directory, \`opencode.jsonc\`, the continuation plugin, \`tools/*.ts\`, and custom skills are user- or platform-owned files with no update tracking — leave every one of them untouched. Section 5 moves some of them and rewrites their old paths; that is the only change they get.

## 3. The authoritative schema is one command away

Whenever you are unsure about a field name, an allowed value, or whether a key survived into v2, consult the canonical JSON Schema instead of guessing:

- \`kortix schema --version 2\` — prints the exact v2 schema the validator and the CR-merge gate enforce. Works offline inside your sandbox. \`kortix schema --version 1\` prints the v1 shape you are migrating FROM.
- The same documents are published at \`https://kortix.com/schema/kortix.v2.schema.json\` (and \`kortix.v1.schema.json\`, plus the combined \`kortix.schema.json\` that dispatches on \`kortix_version\`).

The schema, this prompt, and \`kortix validate\` all enforce the same rules — if they ever appear to disagree, trust \`kortix validate\`'s output and say so in the change request description.

## 4. The v2 shape you're producing

v2's \`agents:\` map is GOVERNANCE ONLY — connectors/secrets/skills/kortix_permissions/workspace/enabled. OpenCode behavior (mode/model/temperature/permission/the prompt itself) is NOT part of the manifest at all; it lives entirely in each agent's own \`.md\` frontmatter + body, exactly as it does today. After section 5 that file is \`agents/<name>.md\`, and the agent's \`file:\` key names it.

\`\`\`yaml
kortix_version: 2
default_agent: <name>          # REQUIRED — must resolve to a declared, enabled agent below

agents:
  <name>:
    file: agents/<name>.md       # the agent's .md, repo-relative (section 5 moves it there)
    enabled: true                # optional; false = can't start sessions (default true)
    connectors: all               # connector slugs | "all" | "none"
    secrets: all                  # renamed from v1's "env" — names | "all" | "none"
    kortix_permissions: all        # project.* permission names | "all" | "none"
    skills: all                    # names of skills/* this agent may invoke | "all" | "none"
    repository_access: false       # optional — true (default) | false
\`\`\`

That's the WHOLE block. No \`description\`, no \`model\`, no \`opencode:\` sub-object, no \`mode\`/\`temperature\`/\`permission\`/\`prompt\` — every one of those is a hard schema error if authored here. They already live in the \`.md\` and are staying there.

Rules that the schema enforces (get these right or \`kortix validate\` fails):

- \`agents\` is a MAP (\`name: {...}\`), not the v1 \`[[agents]]\` array of tables.
- \`default_agent\` is required at the top level and must name a declared, enabled (\`enabled\` not \`false\`) agent.
- Any behavioral field (\`description\`, \`model\`, \`mode\`, \`temperature\`, \`top_p\`, \`steps\`, \`variant\`, \`color\`, \`hidden\`, \`permission\`, \`prompt\`, or a nested \`opencode:\` block) authored on the manifest agent block is a hard error, pointing you at the agent's own \`.md\` frontmatter instead — because that's where it already lives, untouched.
- \`disable\` is a hard error too — it's the manifest-governance \`enabled\` (inverted): write \`enabled: false\` instead. (This is unrelated to a NATIVE \`disable\` key that might already be hand-authored in an agent's own \`.md\` frontmatter — leave that alone; it's a different, runtime-level concept.)
- \`env\` is a hard error in v2 — it is renamed \`secrets\`. **v2 defaults every omitted grant (\`connectors\`/\`secrets\`/\`kortix_permissions\`/\`skills\`) to \`"none"\` (deny-by-default), unlike v1 which defaulted an omitted grant to \`"all"\`.** To avoid silently narrowing an agent's access during migration, write the EXPLICIT value that reproduces today's behavior for every agent — if a v1 agent had no \`[[agents]]\` entry, or its \`env\`/\`connectors\`/\`kortix_cli\` (or \`kortix_permissions\`) were omitted or set to \`all\`, write \`secrets: all\`, \`connectors: all\`, \`kortix_permissions: all\` explicitly in its v2 block. Only narrow a grant if the v1 manifest already narrowed it (an explicit list, or \`none\`) — carry that exact list over. \`skills\` has no v1 equivalent; default new agents to \`all\` unless you have a specific reason to narrow.
- \`channels\` is removed entirely in v2 — delete any \`[[channels]]\` block. Channel↔agent routing now lives in the dashboard (Customize → Channels), not in git. Do not try to replicate it in the manifest.
- Every other top-level section (\`project\`, \`env\` for required/optional documentation vars — NOT the per-agent grant, \`sandbox\`, \`triggers\`, \`connectors\`, \`apps\`) keeps its v1 shape unchanged — translated to YAML, not restructured. \`opencode.config_dir\` is the one exception: section 5 sets it. If \`triggers[].agent\` names an agent, make sure that name still exists in the new \`agents\` map (rename references if you renamed an agent).
- If an agent has no \`.md\` today (a bare \`[[agents]]\` entry with no matching OpenCode agent file), still declare it in \`agents:\` with its governance grants carried over — don't drop it. Omit its \`file:\` key. It has no behavior until someone adds \`agents/<name>.md\`.

## 5. Move to the root layout

v2 projects keep harness-neutral files at the repo root. Move this project in the same change request. Use \`git mv\`, so git records every move as a rename and keeps each file's history.

| From | To |
| --- | --- |
| \`.kortix/opencode/agents/<name>.md\` | \`agents/<name>.md\` |
| \`.kortix/opencode/skills/<name>/\` | \`skills/<name>/\` |
| \`.kortix/memory/\` | \`memory/\` |
| the rest of \`.kortix/opencode/\` (\`opencode.jsonc\`, \`package.json\`, \`bun.lock\`, \`plugins/\`, \`tools/\`, \`commands/\`) | \`harnesses/opencode/\` |

If the v1 manifest sets \`opencode.config_dir\`, that directory is the source instead of \`.kortix/opencode\`. Skip a row when its source does not exist.

\`\`\`
mkdir -p harnesses
git mv .kortix/opencode/agents agents
git mv .kortix/opencode/skills skills
git mv .kortix/memory memory
git mv .kortix/opencode harnesses/opencode
\`\`\`

\`git mv <dir> <target>\` moves \`<dir>\` INTO \`<target>\` when \`<target>\` already exists. Check each target with \`ls\` first. When it exists, move the entries one at a time (\`git mv .kortix/opencode/skills/<name> skills/<name>\`).

Then:

1. Set the OpenCode config dir in \`kortix.yaml\`: \`opencode:\` with \`config_dir: harnesses/opencode\`.
2. Give every agent whose \`.md\` you moved a \`file:\` key: \`file: agents/<name>.md\`.
3. Update \`.gitignore\`: rewrite each \`.kortix/opencode/<path>\` entry as \`harnesses/opencode/<path>\`, and each \`.kortix/memory/<path>\` entry as \`memory/<path>\`. Keep \`.kortix/state/\` — runtime state stays there.
4. Find every remaining reference to an old path: \`git grep -n -e '.kortix/opencode' -e '.kortix/memory'\`. Replace each one with its new path. For example, \`tools/memory.ts\` hard-codes \`.kortix/memory\`, and agent prompts often name it. Change only the path. Leave \`.kortix/state/\` and \`.kortix/link.json\` references alone.

Edge cases:

- A root \`agents/\`, \`memory/\`, or \`harnesses/\` directory that already holds files unrelated to Kortix: do not merge into it. Skip this whole section, steps 1–4 included, keep the legacy layout (Kortix still reads it), and say why in the change request description.
- A skill that already exists in \`skills/<name>/\` (the marketplace update in section 2 can install it there): keep the root copy and remove the legacy copy with \`git rm -r\`.

## 6. Legacy keys v2 refuses — drop these while you convert

v1 tolerates several retired keys with a deprecation warning; v2 makes every one of them a hard error. Remove them as part of the conversion and note each removal in the change request description:

- **Retired \`kortix_permissions\` actions** — \`project.session.exec\`, \`project.gateway.routing.edit\`, \`project.schedule.read\`, \`project.schedule.write\`, \`project.webhook.read\`, \`project.webhook.write\`, \`channel.read\`, \`channel.connect\`, \`channel.send\`, \`channel.disconnect\`. These were removed from the enforcement catalog and have been no-ops for a while — granting or omitting them never had any effect, so deleting them from a grant list changes nothing. Do NOT substitute a broader grant (e.g. \`all\`) to "cover" a deleted action.
- **\`credential = "per_user"\` on a \`[[connectors]]\` entry** — the per-user credential mode was removed; every connector is \`"shared"\` now. Delete the \`credential\` key (or write \`shared\` explicitly if the entry already spelled it out).
- **\`agent_scope\` on a \`[[connectors]]\` entry** — retired; the runtime no longer reads it. Per-agent connector access is expressed from the OTHER side now: each agent's \`connectors:\` grant in the \`agents:\` map. If a v1 connector had \`agent_scope = ["a", "b"]\`, make sure agents outside that list don't get that connector slug in their \`connectors\` grant (use an explicit slug list instead of \`all\` for the agents that should keep access), then delete the key.
- **Legacy singular \`[sandbox]\` image keys** (\`image\`, \`dockerfile\`, \`cpu\`, \`memory\`, \`disk\`, …) — already an error in v1's validator; if \`kortix validate\` flags them, move the image definition under \`[[sandbox.templates]]\` → \`sandbox.templates:\` with a named slug.

## 7. Worked example

A representative v1 \`kortix.toml\`:

\`\`\`toml
kortix_version = 1

[project]
name = "acme-ops"

[env]
required = ["DATABASE_URL"]

[[agents]]
name = "dev"
connectors = ["github", "linear"]
env = "all"
kortix_cli = ["project.file.read", "project.file.write", "project.session.exec"]

[[agents]]
name = "support"
# no grants declared — v1 treats omitted grants as "all"

[[channels]]
type = "slack"
agent = "support"

[[triggers]]
slug = "weekly-summary"
type = "cron"
cron = "0 9 * * 1"
agent = "dev"
prompt = "Post the weekly summary."

[[connectors]]
slug = "github"
provider = "github"
credential = "per_user"
agent_scope = ["dev"]
\`\`\`

becomes this v2 \`kortix.yaml\`:

\`\`\`yaml
kortix_version: 2
default_agent: dev

project:
  name: acme-ops

env:
  required:
    - DATABASE_URL

opencode:
  config_dir: harnesses/opencode

agents:
  dev:
    file: agents/dev.md
    connectors:
      - github
      - linear
    secrets: all          # v1 "env = all", renamed
    kortix_permissions:   # renamed from v1's kortix_cli; project.session.exec dropped — retired no-op action
      - project.file.read
      - project.file.write
    skills: all
  support:
    file: agents/support.md
    # v1 had no grants (implicit all) — but the github connector was
    # agent_scoped to dev only, so "all" would WIDEN support's access.
    # An explicit list preserves today's effective behavior instead.
    connectors: none
    secrets: all
    kortix_permissions: all
    skills: all

triggers:
  - slug: weekly-summary
    type: cron
    cron: "0 9 * * 1"
    agent: dev
    prompt: Post the weekly summary.

connectors:
  - slug: github
    provider: github
    # credential/agent_scope removed — connectors are shared; per-agent
    # access now lives in the agents map above.
\`\`\`

Note what happened: the \`[[channels]]\` block is gone (dashboard-owned now), each agent names its moved \`.md\` with \`file:\`, \`opencode.config_dir\` points at \`harnesses/opencode\`, \`env\` became \`secrets\`, the retired CLI action and connector keys were dropped, every omitted-in-v1 grant was written out explicitly, and the old \`agent_scope\` was honored by adjusting the AGENTS' \`connectors\` grants rather than copied over. Your project will differ — apply the rules, not this output verbatim.

## 8. Leave every agent's \`.md\` alone

Beyond the move and the path updates in section 5, do not edit or reformat any agent's \`.md\` as part of this migration. Its frontmatter (mode/model/permission/temperature/…) and body (the system prompt) are ALREADY the agent's v2 behavior — nothing else about them needs to change. This is what keeps the manifest conversion governance-only and comparatively small: you're translating one array-of-tables into one map of governance grants, full stop.

## 9. Write the file, remove the old one

- Write the fully assembled manifest to \`kortix.yaml\` at the repo root (same directory as the old \`kortix.toml\`).
- If the project has more than ~10 triggers, or long multi-line prompts, keep \`kortix.yaml\` readable: add \`imports: [triggers/]\` to the root and write the triggers into YAML files under \`triggers/\` (one file per trigger or per group; each file is a \`triggers:\` list). Every other key stays in \`kortix.yaml\`. Slugs must stay unique across all files.
- Carry over meaningful TOML comments as YAML comments next to the same keys — hand-written context in a manifest is documentation someone chose to leave; don't strip it.
- Delete the old \`kortix.toml\` in the same commit — don't leave both files (the platform always prefers \`kortix.yaml\` when both exist, but a stale v1 file next to it is confusing for the next person who edits by hand).
- You do not need to touch any project setting outside git — the platform resolves \`kortix.yaml\` automatically once it exists, regardless of the configured manifest filename.

## 10. Validate before you're done

Run \`kortix validate\` (it auto-detects \`kortix.yaml\`). Fix every error it reports — do not open the change request with a manifest that fails validation. Warnings are fine to leave if they're informational, but read them. If an error surprises you, cross-check the field against \`kortix schema --version 2\`.

## 11. Land it as a change request — never merge

First, re-sync: \`git fetch origin\` and check whether \`origin/main\` advanced while you worked (\`git log HEAD..origin/main --oneline\`) — on active projects it will (connectors added from the dashboard, other sessions merging). If it moved, rebase; if the rebase conflicts on \`kortix.toml\` (main changed the manifest you deleted), don't fight it — \`git rebase --abort\`, \`git reset --hard origin/main\`, and redo the conversion against the CURRENT manifest, then continue. Never revert main's changes to win a conflict.

Then commit, **push the branch**, and open the change request. A commit that is never pushed leaves the CR empty ("No changes detected") and un-appliable — the platform refuses such a CR outright (\`422 CR_HEAD_NOT_AHEAD\`):

\`\`\`
git add -A && git commit -m "Migrate to kortix_version 2 (kortix.yaml) and the root layout"
git push origin HEAD
kortix cr open --head <your-branch> --title "Migrate to kortix_version 2 (kortix.yaml) and the root layout" --description "<what you converted, which files you moved, which agent you picked as default_agent and why, every legacy key you removed, and any grant you had to leave narrowed>"
\`\`\`

If the push is rejected because the remote session branch moved, \`git fetch origin\` then \`git push --force-with-lease origin HEAD\` — your own session branch only, never any other branch.

Then verify the CR actually carries your diff: run \`kortix cr diff <number>\` — if it reports no changes, your push didn't land; push again and re-check (the CR updates automatically, do not open a second one).

Do **not** run \`kortix cr merge\`. This is a human-reviewed change like any other — stop once the CR is open and verified non-empty, and tell the user its number so they can review the diff and merge it themselves.`;
