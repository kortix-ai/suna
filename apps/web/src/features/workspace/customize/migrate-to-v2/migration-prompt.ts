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
 * Kortix-specific split. Migration therefore touches ONLY governance
 * (kortix.toml's `[[agents]]` → kortix.yaml's `agents:` map); every agent's
 * `.md` is left byte-for-byte untouched.
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
export const MIGRATE_TO_V2_PROMPT = `Migrate this project's manifest from kortix_version 1 (kortix.toml) to kortix_version 2 (kortix.yaml). Read everything first, then make the change, then land it as a change request — do not merge it yourself.

## 1. Read before you write

- The current manifest: \`kortix.toml\` (or \`kortix.yaml\` if this project already partially moved — check \`kortix_version\` at the top either way).
- Any \`[[agents]]\` entries in the v1 manifest — these carry \`connectors\`, \`kortix_cli\`, and \`env\` grants per agent name. An agent name with NO \`[[agents]]\` entry at all is today unrestricted (v1's back-compat default is "all" when a grant key is omitted).
- \`.kortix/opencode/opencode.jsonc\` — if it sets a top-level \`default_agent\`, that is the project's existing default; use it. If it doesn't, pick the agent whose \`.kortix/opencode/agents/*.md\` frontmatter has \`mode: primary\` and reads as the general/primary one (usually the first-created or the one with the broadest permissions). Record which you picked and why in the change request description — a human reviews this before it merges, so a defensible choice beats blocking on it.
- **You do NOT need to read each agent's \`.md\` frontmatter to migrate it.** v1's frontmatter (mode/model/temperature/permission/prompt/…) is ALREADY valid v2 OpenCode behavior — it stays exactly where it is, unchanged. This migration is governance-only.

## 2. The authoritative schema is one command away

Whenever you are unsure about a field name, an allowed value, or whether a key survived into v2, consult the canonical JSON Schema instead of guessing:

- \`kortix schema --version 2\` — prints the exact v2 schema the validator and the CR-merge gate enforce. Works offline inside your sandbox. \`kortix schema --version 1\` prints the v1 shape you are migrating FROM.
- The same documents are published at \`https://kortix.com/schema/kortix.v2.schema.json\` (and \`kortix.v1.schema.json\`, plus the combined \`kortix.schema.json\` that dispatches on \`kortix_version\`).

The schema, this prompt, and \`kortix validate\` all enforce the same rules — if they ever appear to disagree, trust \`kortix validate\`'s output and say so in the change request description.

## 3. The v2 shape you're producing

v2's \`agents:\` map is GOVERNANCE ONLY — connectors/secrets/skills/kortix_cli/workspace/enabled. OpenCode behavior (mode/model/temperature/permission/the prompt itself) is NOT part of the manifest at all; it lives entirely in each agent's own native \`.kortix/opencode/agents/<name>.md\` frontmatter + body, exactly as it does today. The agent's NAME is the join between this map's keys and that \`.md\`'s filename.

\`\`\`yaml
kortix_version: 2
default_agent: <name>          # REQUIRED — must resolve to a declared, enabled agent below

agents:
  <name>:
    enabled: true                # optional; false = can't start sessions (default true)
    connectors: all               # profile slugs | "all" | "none"
    secrets: all                  # renamed from v1's "env" — names | "all" | "none"
    kortix_cli: all                # kortix_cli leaf names | "all" | "none"
    skills: all                    # names of .kortix/opencode/skills/* this agent may invoke | "all" | "none"
    workspace: runtime             # optional — runtime | read | branch
\`\`\`

That's the WHOLE block. No \`description\`, no \`model\`, no \`opencode:\` sub-object, no \`mode\`/\`temperature\`/\`permission\`/\`prompt\` — every one of those is a hard schema error if authored here. They already live in the \`.md\` and are staying there.

Rules that the schema enforces (get these right or \`kortix validate\` fails):

- \`agents\` is a MAP (\`name: {...}\`), not the v1 \`[[agents]]\` array of tables.
- \`default_agent\` is required at the top level and must name a declared, enabled (\`enabled\` not \`false\`) agent.
- Any behavioral field (\`description\`, \`model\`, \`mode\`, \`temperature\`, \`top_p\`, \`steps\`, \`variant\`, \`color\`, \`hidden\`, \`permission\`, \`prompt\`, or a nested \`opencode:\` block) authored on the manifest agent block is a hard error, pointing you at the agent's own \`.md\` frontmatter instead — because that's where it already lives, untouched.
- \`disable\` is a hard error too — it's the manifest-governance \`enabled\` (inverted): write \`enabled: false\` instead. (This is unrelated to a NATIVE \`disable\` key that might already be hand-authored in an agent's own \`.md\` frontmatter — leave that alone; it's a different, runtime-level concept.)
- \`env\` is a hard error in v2 — it is renamed \`secrets\`. **v2 defaults every omitted grant (\`connectors\`/\`secrets\`/\`kortix_cli\`/\`skills\`) to \`"none"\` (deny-by-default), unlike v1 which defaulted an omitted grant to \`"all"\`.** To avoid silently narrowing an agent's access during migration, write the EXPLICIT value that reproduces today's behavior for every agent — if a v1 agent had no \`[[agents]]\` entry, or its \`env\`/\`connectors\`/\`kortix_cli\` were omitted or set to \`all\`, write \`secrets: all\`, \`connectors: all\`, \`kortix_cli: all\` explicitly in its v2 block. Only narrow a grant if the v1 manifest already narrowed it (an explicit list, or \`none\`) — carry that exact list over. \`skills\` has no v1 equivalent; default new agents to \`all\` unless you have a specific reason to narrow.
- \`channels\` is removed entirely in v2 — delete any \`[[channels]]\` block. Channel↔agent routing now lives in the dashboard (Customize → Channels), not in git. Do not try to replicate it in the manifest.
- Every other top-level section (\`project\`, \`env\` for required/optional documentation vars — NOT the per-agent grant, top-level \`opencode\` config-dir settings, \`sandbox\`, \`triggers\`, \`connectors\`, \`apps\`) keeps its v1 shape unchanged — translated to YAML, not restructured. If \`triggers[].agent\` names an agent, make sure that name still exists in the new \`agents\` map (rename references if you renamed an agent).
- If an agent has no \`.md\` today (a bare \`[[agents]]\` entry with no matching OpenCode agent file), still declare it in \`agents:\` with its governance grants carried over — don't drop it. It will simply have no behavior until someone adds \`.kortix/opencode/agents/<name>.md\`.

## 4. Legacy keys v2 refuses — drop these while you convert

v1 tolerates several retired keys with a deprecation warning; v2 makes every one of them a hard error. Remove them as part of the conversion and note each removal in the change request description:

- **Retired \`kortix_cli\` actions** — \`project.session.exec\`, \`project.gateway.routing.edit\`, \`project.schedule.read\`, \`project.schedule.write\`, \`project.webhook.read\`, \`project.webhook.write\`, \`channel.read\`, \`channel.connect\`, \`channel.send\`, \`channel.disconnect\`. These were removed from the enforcement catalog and have been no-ops for a while — granting or omitting them never had any effect, so deleting them from a grant list changes nothing. Do NOT substitute a broader grant (e.g. \`all\`) to "cover" a deleted action.
- **\`credential = "per_user"\` on a \`[[connectors]]\` entry** — the per-user credential mode was removed; every connector is \`"shared"\` now. Delete the \`credential\` key (or write \`shared\` explicitly if the entry already spelled it out).
- **\`agent_scope\` on a \`[[connectors]]\` entry** — retired; the runtime no longer reads it. Per-agent connector access is expressed from the OTHER side now: each agent's \`connectors:\` grant in the \`agents:\` map. If a v1 connector had \`agent_scope = ["a", "b"]\`, make sure agents outside that list don't get that connector slug in their \`connectors\` grant (use an explicit slug list instead of \`all\` for the agents that should keep access), then delete the key.
- **Legacy singular \`[sandbox]\` image keys** (\`image\`, \`dockerfile\`, \`cpu\`, \`memory\`, \`disk\`, …) — already an error in v1's validator; if \`kortix validate\` flags them, move the image definition under \`[[sandbox.templates]]\` → \`sandbox.templates:\` with a named slug.

## 5. Worked example

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

agents:
  dev:
    connectors:
      - github
      - linear
    secrets: all          # v1 "env = all", renamed
    kortix_cli:           # project.session.exec dropped — retired no-op action
      - project.file.read
      - project.file.write
    skills: all
  support:
    # v1 had no grants (implicit all) — but the github connector was
    # agent_scoped to dev only, so "all" would WIDEN support's access.
    # An explicit list preserves today's effective behavior instead.
    connectors: none
    secrets: all
    kortix_cli: all
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

Note what happened: the \`[[channels]]\` block is gone (dashboard-owned now), \`env\` became \`secrets\`, the retired CLI action and connector keys were dropped, every omitted-in-v1 grant was written out explicitly, and the old \`agent_scope\` was honored by adjusting the AGENTS' \`connectors\` grants rather than copied over. Your project will differ — apply the rules, not this output verbatim.

## 6. Leave every agent's \`.md\` alone

Do not open, edit, or reformat any \`.kortix/opencode/agents/*.md\` file as part of this migration. Its frontmatter (mode/model/permission/temperature/…) and body (the system prompt) are ALREADY the agent's v2 behavior — nothing about them needs to change. This is what makes this migration governance-only and comparatively small: you're translating one array-of-tables into one map of governance grants, full stop.

## 7. Write the file, remove the old one

- Write the fully assembled manifest to \`kortix.yaml\` at the repo root (same directory as the old \`kortix.toml\`).
- Carry over meaningful TOML comments as YAML comments next to the same keys — hand-written context in a manifest is documentation someone chose to leave; don't strip it.
- Delete the old \`kortix.toml\` in the same commit — don't leave both files (the platform always prefers \`kortix.yaml\` when both exist, but a stale v1 file next to it is confusing for the next person who edits by hand).
- You do not need to touch any project setting outside git — the platform resolves \`kortix.yaml\` automatically once it exists, regardless of the configured manifest filename.

## 8. Validate before you're done

Run \`kortix validate\` (it auto-detects \`kortix.yaml\`). Fix every error it reports — do not open the change request with a manifest that fails validation. Warnings are fine to leave if they're informational, but read them. If an error surprises you, cross-check the field against \`kortix schema --version 2\`.

## 9. Land it as a change request — never merge

Commit on your session's branch, **push the branch, then** open the change request. A commit that is never pushed leaves the CR empty ("No changes detected") and un-appliable — the push is not optional:

\`\`\`
git add -A && git commit -m "Migrate manifest to kortix_version 2 (kortix.yaml)"
git push origin HEAD
kortix cr open --head <your-branch> --title "Migrate manifest to kortix_version 2 (kortix.yaml)" --description "<what you converted, which agent you picked as default_agent and why, every legacy key you removed, and any grant you had to leave narrowed>"
\`\`\`

Then verify the CR actually carries your diff: run \`kortix cr diff <number>\` — if it reports no changes, your push didn't land; push again and re-check (the CR updates automatically, do not open a second one).

Do **not** run \`kortix cr merge\`. This is a human-reviewed change like any other — stop once the CR is open and verified non-empty, and tell the user its number so they can review the diff and merge it themselves.`;
