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

## 2. The v2 shape you're producing

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
- Every other top-level section (\`project\`, \`env\` for required/optional documentation vars — NOT the per-agent grant, top-level \`opencode\` config-dir settings, \`sandbox\`, \`triggers\`, \`connectors\`, \`apps\`) keeps its v1 shape unchanged. If \`triggers[].agent\` names an agent, make sure that name still exists in the new \`agents\` map (rename references if you renamed an agent).
- If an agent has no \`.md\` today (a bare \`[[agents]]\` entry with no matching OpenCode agent file), still declare it in \`agents:\` with its governance grants carried over — don't drop it. It will simply have no behavior until someone adds \`.kortix/opencode/agents/<name>.md\`.

## 3. Leave every agent's \`.md\` alone

Do not open, edit, or reformat any \`.kortix/opencode/agents/*.md\` file as part of this migration. Its frontmatter (mode/model/permission/temperature/…) and body (the system prompt) are ALREADY the agent's v2 behavior — nothing about them needs to change. This is what makes this migration governance-only and comparatively small: you're translating one array-of-tables into one map of governance grants, full stop.

## 4. Write the file, remove the old one

- Write the fully assembled manifest to \`kortix.yaml\` at the repo root (same directory as the old \`kortix.toml\`).
- Delete the old \`kortix.toml\` in the same commit — don't leave both files (the platform always prefers \`kortix.yaml\` when both exist, but a stale v1 file next to it is confusing for the next person who edits by hand).
- You do not need to touch any project setting outside git — the platform resolves \`kortix.yaml\` automatically once it exists, regardless of the configured manifest filename.

## 5. Validate before you're done

Run \`kortix validate\` (it auto-detects \`kortix.yaml\`). Fix every error it reports — do not open the change request with a manifest that fails validation. Warnings are fine to leave if they're informational, but read them.

## 6. Land it as a change request — never merge

Commit the changes on your session's branch, then open a change request:

\`\`\`
kortix cr open --head <your-branch> --title "Migrate manifest to kortix_version 2 (kortix.yaml)" --description "<what you converted, which agent you picked as default_agent and why, and any grant you had to leave narrowed>"
\`\`\`

Do **not** run \`kortix cr merge\`. This is a human-reviewed change like any other — stop once the CR is open and tell the user its number so they can review the diff and merge it themselves.`;
