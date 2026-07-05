/**
 * The seed prompt for "Migrate to v2" — a normal agent session does the
 * conversion because it's just files + git (Marko's framing). We start a
 * fresh session with this as the first message; the project's default agent
 * reads the repo, rewrites the manifest, and opens a change request for a
 * human to review. Nothing here merges anything — that's the whole point of
 * routing config changes through the same CR path as any other edit.
 *
 * Kept as a plain exported constant (not inlined at the call site) so it's
 * independently testable and diffable — this is the load-bearing artifact of
 * the feature, not the wiring around it.
 */
export const MIGRATE_TO_V2_PROMPT = `Migrate this project's manifest from kortix_version 1 (kortix.toml) to kortix_version 2 (kortix.yaml). Read everything first, then make the change, then land it as a change request — do not merge it yourself.

## 1. Read before you write

- The current manifest: \`kortix.toml\` (or \`kortix.yaml\` if this project already partially moved — check \`kortix_version\` at the top either way).
- Every agent's frontmatter under \`.kortix/opencode/agents/*.md\` (the YAML block between the leading \`---\` fences). This is the agent's real behavior today — mode, model, permission, temperature, etc. — that v1's \`[[agents]]\` array never carries.
- \`.kortix/opencode/opencode.jsonc\` — if it sets a top-level \`default_agent\`, that is the project's existing default; use it. If it doesn't, pick the agent with \`mode: primary\` that reads as the general/primary one (usually the first-created or the one with the broadest permissions). Record which you picked and why in the change request description — a human reviews this before it merges, so a defensible choice beats blocking on it.
- Any \`[[agents]]\` entries in the v1 manifest — these carry \`connectors\`, \`kortix_cli\`, and \`env\` grants per agent name. An agent name with NO \`[[agents]]\` entry at all is today unrestricted (v1's back-compat default is "all" when a grant key is omitted).

## 2. The v2 shape you're producing

Two layers per agent, structurally distinct: the KORTIX layer (top-level —
identity + governance + model, runtime-agnostic) and the nested \`opencode:\`
layer (runtime-specific behavior — mode, sampling, prompt, permission tree).
Namespacing the behavior block by runtime is deliberate: it's what makes a
future \`runtime: codex\`/\`claude\` project a one-line addition instead of
another migration.

\`\`\`yaml
kortix_version: 2
default_agent: <name>          # REQUIRED — must resolve to a declared agent below

agents:
  <name>:
    # ---- Kortix layer: identity + governance, runtime-agnostic ----
    description: "..."          # required if opencode.mode is "subagent"
    enabled: true                # optional; false = can't start sessions (default true)
    model: anthropic/claude-sonnet-5   # optional; "provider/model" form
    connectors: all               # profile slugs | "all" | "none"
    secrets: all                  # renamed from v1's "env" — names | "all" | "none"
    kortix_cli: all                # kortix_cli leaf names | "all" | "none"
    skills: all                    # names of .kortix/opencode/skills/* this agent may invoke | "all" | "none"
    # ---- OpenCode layer: nested, runtime-specific behavior ----
    opencode:
      mode: primary               # primary | subagent | all
      variant: ...
      temperature: 0.2
      top_p: ...
      steps: 200
      color: "#7C5CFF"             # hex, or one of: primary/secondary/accent/success/warning/error/info
      hidden: false
      prompt: .kortix/opencode/agents/<name>.md   # body-only file, see step 3
      permission:                  # full recursive OpenCode PermissionConfig — bare action or glob-map per key
        edit: ask
        bash:
          "git push": deny
          "*": allow
        webfetch: allow
\`\`\`

Rules that the schema enforces (get these right or \`kortix validate\` fails):

- \`agents\` is a MAP (\`name: {...}\`), not the v1 \`[[agents]]\` array of tables.
- \`default_agent\` is required at the top level and must name a declared, enabled (\`enabled\` not \`false\`) agent.
- \`opencode.mode: subagent\` requires a non-empty top-level \`description\`.
- \`model\`, if set, should be \`provider/model\` form (warning, not a hard error, if it isn't). It stays TOP-LEVEL — never under \`opencode\` — because it's a Kortix concern (the gateway resolves it), universal across whatever runtime executes the agent.
- \`opencode.color\` must be a 6-hex-digit color (\`#RRGGBB\`) or one of the named theme colors above.
- \`opencode.steps\` must be a positive integer.
- \`opencode.permission\` is either a bare action (\`ask\`/\`allow\`/\`deny\`) or an object keyed by capability (\`read\`, \`edit\`, \`bash\`, \`task\`, \`skill\`, \`webfetch\`, \`websearch\`, \`todowrite\`, \`question\`, \`doom_loop\`, glob-map form works for everything except the action-only keys \`todowrite\`/\`question\`/\`webfetch\`/\`websearch\`/\`doom_loop\`).
- The deprecated upstream fields \`tools\` and \`maxSteps\` are hard errors in v2 (under \`opencode\`) — translate \`tools\` allowlists into the equivalent \`permission\` rules, and rename \`maxSteps\` to \`steps\`.
- Authoring \`mode\`/\`temperature\`/\`top_p\`/\`steps\`/\`variant\`/\`color\`/\`hidden\`/\`prompt\`/\`permission\` FLAT on the agent block (not nested under \`opencode\`) is a hard error — move each one under \`opencode:\`.
- \`disable\` is a hard error too — it's renamed \`enabled\` (inverted) and moved to the top-level Kortix layer: write \`enabled: false\` instead of \`disable: true\`.
- \`env\` is a hard error in v2 — it is renamed \`secrets\`. **v2 defaults every omitted grant (\`connectors\`/\`secrets\`/\`kortix_cli\`/\`skills\`) to \`"none"\` (deny-by-default), unlike v1 which defaulted an omitted grant to \`"all"\`.** To avoid silently narrowing an agent's access during migration, write the EXPLICIT value that reproduces today's behavior for every agent — if a v1 agent had no \`[[agents]]\` entry, or its \`env\`/\`connectors\`/\`kortix_cli\` were omitted or set to \`all\`, write \`secrets: all\`, \`connectors: all\`, \`kortix_cli: all\` explicitly in its v2 block. Only narrow a grant if the v1 manifest already narrowed it (an explicit list, or \`none\`) — carry that exact list over.
- \`channels\` is removed entirely in v2 — delete any \`[[channels]]\` block. Channel↔agent routing now lives in the dashboard (Customize → Channels), not in git. Do not try to replicate it in the manifest.
- Every other top-level section (\`project\`, \`env\` for required/optional documentation vars — NOT the per-agent grant, top-level \`opencode\` config-dir settings, \`sandbox\`, \`triggers\`, \`connectors\`, \`apps\`) keeps its v1 shape unchanged. If \`triggers[].agent\` names an agent, make sure that name still exists in the new \`agents\` map (rename references if you renamed an agent).

## 3. Hoist frontmatter into the manifest, then strip it

For each agent's \`.kortix/opencode/agents/<name>.md\`:

1. Copy every frontmatter key into that agent's block in \`kortix.yaml\`, exactly as written, splitting it across the two layers: \`description\` and \`model\` go top-level (Kortix layer); \`mode\`, \`permission\`, \`temperature\`, \`top_p\`, \`steps\`, \`variant\`, \`color\`, \`hidden\` go under \`opencode:\` (OpenCode layer). The manifest becomes the one source of truth for this.
2. Delete the frontmatter block (the \`---\` fences and everything between them) from the \`.md\` file, leaving ONLY the prompt body text. v2 requires body-only prompt files — a referenced \`.md\` that still carries frontmatter keys is a validation error.
3. Set \`opencode.prompt: <path to that .md>\` on the agent's manifest block so the body is picked up unchanged.

If an agent has no \`.md\`/frontmatter today (a bare \`[[agents]]\` entry with no matching OpenCode agent file), still declare it in \`agents:\` with at least \`mode\` and the governance grants carried over — don't drop it.

## 4. Write the file, remove the old one

- Write the fully assembled manifest to \`kortix.yaml\` at the repo root (same directory as the old \`kortix.toml\`).
- Delete the old \`kortix.toml\` in the same commit — don't leave both files (the platform always prefers \`kortix.yaml\` when both exist, but a stale v1 file next to it is confusing for the next person who edits by hand).
- You do not need to touch any project setting outside git — the platform resolves \`kortix.yaml\` automatically once it exists, regardless of the configured manifest filename.

## 5. Validate before you're done

Run \`kortix validate\` (it auto-detects \`kortix.yaml\`). Fix every error it reports — do not open the change request with a manifest that fails validation. Warnings are fine to leave if they're informational (e.g. a \`model\` not in \`provider/model\` form that you intentionally left as-is), but read them.

## 6. Land it as a change request — never merge

Commit the changes on your session's branch, then open a change request:

\`\`\`
kortix cr open --head <your-branch> --title "Migrate manifest to kortix_version 2 (kortix.yaml)" --description "<what you converted, which agent you picked as default_agent and why, and any grant you had to leave narrowed>"
\`\`\`

Do **not** run \`kortix cr merge\`. This is a human-reviewed change like any other — stop once the CR is open and tell the user its number so they can review the diff and merge it themselves.`;
