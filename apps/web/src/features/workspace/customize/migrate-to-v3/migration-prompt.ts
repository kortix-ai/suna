/**
 * The seed prompt for "Upgrade to v3": a normal agent session does the
 * conversion, because it is files and git. Upgrading starts a fresh session
 * with this as the first message; the project's default agent reads the repo,
 * rewrites the manifest, and opens a change request for a human to review.
 * Nothing here merges anything.
 *
 * kortix_version 3 is the one target: the project registers skills, tools,
 * commands and extensions, and each agent enables them by name. Nothing is
 * global and no harness folder is read (`harnesses/`, `.kortix/opencode/`).
 * The prompt takes a v1 (kortix.toml) or v2 (kortix.yaml) project there in one
 * change request and carries the whole contract inline: the v3 shape, the
 * agent conversion (frontmatter into the block, the body into `prompt_file`),
 * the registries, the removed folders and keys, a worked v2 → v3 example, and
 * the canonical schema (`kortix schema --version 3`, kortix.com/schema).
 *
 * Kept as a plain exported constant so it is testable and diffable on its own:
 * it is the load-bearing artifact of the feature, not the wiring around it.
 */
export const MIGRATE_TO_V3_PROMPT = `Upgrade this project's manifest to kortix_version 3 (kortix.yaml). The project is on kortix_version 1 (kortix.toml) or kortix_version 2 (kortix.yaml): check \`kortix_version\` at the top of the manifest first. Read everything first, then make the change, then land it as a change request — do not merge it yourself.

On kortix_version 2, start with \`kortix migrate\`: it prints the v3 conversion and a "Not carried over" list, and \`kortix migrate --write\` writes it. Then check its result against every section below and carry over by hand what it lists. On kortix_version 1, convert by hand.

## 1. Read before you write

- The current manifest: \`kortix.toml\` (v1) or \`kortix.yaml\` (v2), plus every file its \`imports:\` names.
- Every agent. v1: the \`[[agents]]\` entries (grants \`connectors\`, \`kortix_permissions\` — older manifests spell it \`kortix_cli\` — and \`env\`) and the agent files in \`.kortix/opencode/agents/*.md\`. v2: the \`agents:\` map and the \`.md\` each \`file:\` key names (usually \`agents/<name>.md\`). An agent \`.md\` holds the agent's behavior: frontmatter (\`description\`, \`mode\`, \`model\`, \`variant\`, \`temperature\`, \`top_p\`, \`steps\`, \`options\`, \`color\`, \`hidden\`, \`permission\`, \`tools\`, \`disable\`) and a body (the system prompt).
- The harness folders: \`.kortix/opencode/\` (v1), or the folders that \`opencode.config_dir\` and \`pi.config_dir\` name (v2, usually \`harnesses/opencode/\` and \`harnesses/pi/\`). Read \`opencode.jsonc\` (the project-wide \`permission\`, \`default_agent\`, \`mcp\` servers, other runtime settings), \`commands/*.md\`, \`plugins/\`, \`tools/\`, and pi's \`settings.json\` (\`packages\`).
- The v2 top-level \`harnesses:\` key (\`harnesses.opencode.plugins\`, \`harnesses.pi.packages\`, \`harnesses.pi.codemode\`) and each agent's \`harnesses:\` (\`exclude\`, extra \`packages\`, \`codemode\`).
- The skills: every folder that holds a \`SKILL.md\` (\`skills/<name>/\`, \`.kortix/opencode/skills/<name>/\`, or under a harness folder).
- The default agent: v2's \`default_agent\`. In v1, the \`default_agent\` in \`opencode.jsonc\`; without one, the agent whose frontmatter has \`mode: primary\` and reads as the general one. Record which you picked and why in the change request description.

## 2. Bring the platform baseline up to date first

A project on an older manifest usually also runs stale platform skills. Refresh them BEFORE touching the manifest so the upgrade lands on a current baseline:

1. \`kortix marketplace updates\` — a hash-diff report of every marketplace-tracked item (the Kortix-managed skills, plus any marketplace skills the user installed).
2. If updates are listed, apply them: \`kortix marketplace update --all\`. **This commits directly to \`main\` through the platform's own hash-safe update path — it is intentionally NOT part of your change request.** It rewrites only files whose installed hash no longer matches the catalog.
3. Sync your session branch on top of the refreshed main: \`git fetch origin && git rebase origin/main\`.
4. Items reported as \`orphaned\` (no longer in the catalog) are not updatable — leave them alone and mention them in the change request description.
5. Marketplace-tracked items are the ONLY thing you refresh this way. Do not change what any agent, skill, tool, command or plugin does. Sections 5–7 move files and rewrite their paths; that is the only change they get.

## 3. The authoritative schema is one command away

Whenever you are unsure about a field name, an allowed value, or whether a key exists in v3, consult the canonical JSON Schema instead of guessing:

- \`kortix schema --version 3\` — prints the exact v3 schema the validator and the CR-merge gate enforce. \`kortix schema --version 2\` and \`--version 1\` print the shapes you are upgrading FROM.
- The same documents are published at \`https://kortix.com/schema/kortix.v3.schema.json\` (and \`kortix.v2.schema.json\`, \`kortix.v1.schema.json\`).

The schema, this prompt and \`kortix validate\` enforce the same rules. If they ever appear to disagree, trust \`kortix validate\` and say so in the change request description.

## 4. The v3 shape you're producing

In v3 the project REGISTERS things and each agent ENABLES them by name. Nothing is global: no project-wide permission, and no command, plugin or package that applies to every agent. Everything an agent is lives in its \`agents.<name>\` block.

\`\`\`yaml
kortix_version: 3
default_agent: <name>            # REQUIRED — a declared, enabled agent with mode primary or all

skills:                          # name -> repo folder that holds SKILL.md (folder basename = name)
  <skill>: skills/<skill>
tools:                           # snake_case name -> repo .ts/.js module
  <tool_name>: tools/<tool_name>.ts
commands:                        # name -> exactly one of prompt / prompt_file
  <command>:
    description: <one line>
    prompt_file: commands/<command>.md
extensions:                      # name -> one implementation per harness
  <extension>:
    opencode: extensions/<extension>.ts       # an OpenCode plugin module
    pi: npm:<package>@<x.y.z>                 # a pi package: exact npm pin or a repo path

agents:
  <name>:
    description: <one line>
    mode: primary                # primary | subagent | all
    model: <provider/model>      # optional
    prompt_file: agents/<name>.md  # the system prompt (or \`prompt:\` inline)
    permission: allow            # tool policy; \`skill\` and \`task\` keys are errors here
    tools: all                   # all | none | [names] | { exclude: [names] }
    skills: all                  # registered + Kortix skills this agent may load
    subagents: all               # declared subagents this agent may start
    commands: all                # registered commands this agent may run
    extensions: all              # registered extensions a session of this agent loads
    connectors: all
    secrets: all
    kortix_permissions: all
\`\`\`

Rules the validator enforces:

- Registry names (skills, commands, extensions): lowercase words joined by \`-\`, at most 64 characters. Tool names: snake_case. Paths: repo-relative, no leading \`/\` or \`./\`, no \`..\`.
- **Kortix skills and Kortix tools are always registered.** Never add a \`kortix-*\` skill or a Kortix tool (\`web_search\`, \`image_search\`, \`scrape_webpage\`, \`memory\`, \`show\`, \`kortix-connectors_call\`, \`kortix-connectors_describe\`) to a registry; an agent grants them by name. The v2 \`kortix:<name>\` value form is an error in v3: delete those \`tools:\` lines. A project skill name must not start with \`kortix-\`.
- Every grant names something registered, a Kortix skill or tool, or (for \`subagents\`) a declared agent with \`mode\` \`subagent\` or \`all\`. An unknown name is an error.
- \`skills\`, \`subagents\`, \`commands\` and \`extensions\` default to \`none\` on an agent, and \`connectors\`, \`secrets\`, \`kortix_permissions\` and \`apps\` are deny-by-default too. **Write the explicit value that reproduces today's access for every agent** (section 5). Omitting a grant silently takes it away.
- A \`permission\` omitted on an agent means \`allow\` for every tool.
- Top-level \`opencode\`, \`pi\`, \`harnesses\`, \`permission\` and \`channels\` are errors. On an agent, \`file\`, \`disable\`, \`opencode\`, \`harnesses\`, \`env\`, \`kortix_cli\`, \`connectors_personal\`, \`repository_access\` and the \`{ <tool>: true|false }\` form of \`tools\` are errors. Any unknown key is an error.
- \`project\`, \`env\` (the required/optional secret names), \`sandbox\`, \`connectors\`, \`apps\`, \`triggers\`, \`policy\`/\`policies\` and \`imports\` keep their shape. \`triggers[].agent\` must name a declared agent.

## 5. Convert the agents

For every agent:

1. Move the behavior from the \`.md\` frontmatter into the agent block: \`description\`, \`mode\`, \`model\`, \`variant\`, \`temperature\`, \`top_p\`, \`steps\`, \`options\`, \`color\`, \`hidden\`, \`permission\`. \`disable: true\` becomes \`enabled: false\`.
2. The \`.md\` body is the system prompt. Write it, without the frontmatter, to \`agents/<name>.md\` and set \`prompt_file: agents/<name>.md\`. A v1 file moves with \`git mv .kortix/opencode/agents/<name>.md agents/<name>.md\` first, so git keeps its history. Change nothing in the prompt text except old paths (section 7). Delete the v2 \`file:\` key.
3. Permission: nothing is global, so copy the project-wide \`permission\` from \`opencode.jsonc\` into every agent, then apply the agent's own \`permission\` on top (the agent's rule wins per key). Move a \`skill\` rule to \`skills:\` and a \`task\` rule to \`subagents:\` (an allowlist of the names it allowed). When neither the project nor the agent sets a permission, write nothing: omitted means \`allow\`.
4. Frontmatter \`tools: { <tool>: false }\` becomes \`tools: { exclude: [<tool>] }\`; a map that only enables some tools becomes the list of those names.
5. Grants. Carry each existing grant over exactly. v1 \`env\` becomes \`secrets\`; v1 \`kortix_cli\` becomes \`kortix_permissions\`; \`connectors_personal\` becomes \`connectors_required\`; \`repository_access: false\` becomes \`workspace: { project_repository: false }\`. A v1 grant that was omitted meant \`all\`: write \`all\`. For the new v3 grants, reproduce today's behavior: \`skills: all\` unless the agent narrowed skills, \`subagents: all\` for an agent that could start subagents, \`commands: all\` for an agent a user talks to, \`extensions: all\` unless a v2 agent's \`harnesses\` \`exclude\` dropped some (then list the rest), and the agent's \`harnesses.pi.codemode\` as \`codemode\`.
6. **Only declared agents exist in v3.** v3 disables OpenCode's built-in \`build\`, \`plan\`, \`general\` and \`explore\` unless the manifest declares that name. If \`default_agent\`, a trigger, a command or a prompt uses one of them, declare it as an agent (\`mode: subagent\` for \`general\`/\`explore\`) with a \`description\` and a prompt.
7. An agent declared in the manifest with no \`.md\` keeps its grants and gets no \`prompt_file\`.

## 6. Register skills, tools, commands and extensions

- **Skills.** Each project skill folder becomes \`skills.<name>: <folder>\`, at \`skills/<name>/\`. Move a skill that lives elsewhere with \`git mv\`. Do not register \`kortix-*\` skills: they are always registered.
- **Tools.** Each project tool module becomes \`tools.<name>: <path>\`. Move modules out of a harness folder to \`tools/\` with \`git mv\`. Keep v2 path entries; delete \`kortix:<name>\` entries.
- **Commands.** Each \`commands/<name>.md\` in a harness folder becomes \`commands.<name>\`: its frontmatter \`description\` stays as \`description\`; its body goes to \`commands/<name>.md\` (body only, no frontmatter) and \`prompt_file: commands/<name>.md\`. \`$ARGUMENTS\` and \`$1\`, \`$2\`, … keep working. A command's frontmatter \`agent\`, \`model\` or \`subtask\` has no v3 key: drop it, grant the command to that agent only, and list it in the change request description.
- **Extensions.** Each OpenCode plugin (v1 \`.kortix/opencode/plugins/\`, v2 \`<config_dir>/plugins/\` and \`harnesses.opencode.plugins\`) becomes \`extensions.<name>.opencode: extensions/<name>.ts\` (or \`extensions/<name>/\` for a plugin with its own files). Move it with every file it imports and keep the relative imports working. Each pi package (\`harnesses.pi.packages\`, pi \`settings.json\` \`packages\`) becomes \`extensions.<name>.pi\` with the same value: \`npm:<package>@<x.y.z>\` (pin an exact version), a repo path, or the \`{ source, extensions, skills, prompts, themes }\` filter map. Give a plugin and a pi package one name when they do the same job. If a plugin imports an npm package listed in the harness folder's \`package.json\`, keep that \`package.json\` (and its lockfile) beside the plugin, and say so in the change request description.
- **MCP servers.** An \`mcp\` server in \`opencode.jsonc\` becomes a \`connectors:\` entry; check the fields with \`kortix schema --version 3\`.
- Any other \`opencode.jsonc\` setting (\`subagent_depth\`, \`provider\`, \`compaction\`, …) and any pi \`settings.json\` key besides \`packages\` has no v3 home. List each one in the change request description; do not invent a key for it.

## 7. Remove the harness folders

v3 reads no harness folder and no harness key: never \`harnesses/\`, \`.kortix/opencode/\`, \`opencode.config_dir\` or \`pi.config_dir\`.

1. After sections 5 and 6 moved everything out, delete what is left: \`git rm -r harnesses/\` (v2) or \`git rm -r .kortix/opencode/\` (v1). v1 also moves memory: \`git mv .kortix/memory memory\`. Keep \`.kortix/state/\` and \`.kortix/link.json\`.
2. Delete the top-level \`opencode\`, \`pi\`, \`harnesses\` and \`permission\` keys and every agent's \`harnesses\` key.
3. Update \`.gitignore\`: rewrite each \`.kortix/opencode/<path>\` or \`harnesses/<harness>/<path>\` entry to the file's new path, and each \`.kortix/memory/<path>\` entry to \`memory/<path>\`.
4. Find every remaining reference to an old path: \`git grep -n -e '.kortix/opencode' -e '.kortix/memory' -e 'harnesses/'\`. Replace each one with the new path. Agent prompts, tools and skills often name them. Change only the path.

Edge case: a root \`agents/\`, \`skills/\`, \`tools/\`, \`commands/\`, \`extensions/\` or \`memory/\` directory that already holds unrelated files. Pick a free folder for the moved files instead (for example \`kortix/agents/\`), point the manifest paths at it, and say so in the change request description.

## 8. Legacy keys v3 refuses — drop these while you convert

From a v1 manifest, also remove these. Note each removal in the change request description:

- **Retired \`kortix_permissions\` actions** — \`project.session.exec\`, \`project.gateway.routing.edit\`, \`project.schedule.read\`, \`project.schedule.write\`, \`project.webhook.read\`, \`project.webhook.write\`, \`channel.read\`, \`channel.connect\`, \`channel.send\`, \`channel.disconnect\`. They have been no-ops for a while, so deleting them changes nothing. Do NOT substitute a broader grant (e.g. \`all\`) to "cover" a deleted action.
- **\`credential = "per_user"\`** and **\`agent_scope\`** on a \`[[connectors]]\` entry. Every connector is shared now. If a connector had \`agent_scope = ["a"]\`, keep that connector out of every other agent's \`connectors\` grant (an explicit slug list instead of \`all\`), then delete the key.
- **\`[[channels]]\`** — channel routing lives in the dashboard (Customize → Channels). Delete the block.
- **Legacy singular \`[sandbox]\` image keys** (\`image\`, \`dockerfile\`, \`cpu\`, \`memory\`, \`disk\`, …) — move them under \`sandbox.templates\` with a named slug.

## 9. Worked example

A representative v2 project: \`kortix.yaml\`

\`\`\`yaml
kortix_version: 2
default_agent: dev
project:
  name: acme-ops
env:
  required: [DATABASE_URL]
opencode:
  config_dir: harnesses/opencode
harnesses:
  pi:
    packages: ["npm:pi-web-access@0.30.0"]
tools:
  memory: kortix:memory
  lookup_order: tools/lookup_order.ts
agents:
  dev:
    file: agents/dev.md
    connectors: [github]
    secrets: all
    kortix_permissions: all
    skills: all
  reviewer:
    file: agents/reviewer.md
    skills: [code-review]
\`\`\`

with \`harnesses/opencode/opencode.jsonc\` setting \`"permission": { "bash": "ask" }\`, a command \`harnesses/opencode/commands/release-notes.md\`, a plugin \`harnesses/opencode/plugins/audit.ts\`, the skill \`skills/code-review/\`, and \`agents/reviewer.md\` starting with the frontmatter \`mode: subagent\`, \`description: Reviews diffs.\` and \`permission: { edit: deny }\`,

becomes this v3 \`kortix.yaml\`:

\`\`\`yaml
kortix_version: 3
default_agent: dev
project:
  name: acme-ops
env:
  required: [DATABASE_URL]

skills:
  code-review: skills/code-review
tools:
  lookup_order: tools/lookup_order.ts     # memory is a Kortix tool: always registered
commands:
  release-notes:
    description: Draft release notes from the merged change requests.
    prompt_file: commands/release-notes.md
extensions:
  audit:
    opencode: extensions/audit.ts
  web-access:
    pi: npm:pi-web-access@0.30.0

agents:
  dev:
    mode: primary
    prompt_file: agents/dev.md
    permission:
      bash: ask                           # the project-wide rule from opencode.jsonc
    tools: all
    skills: all
    subagents: all
    commands: all
    extensions: all
    connectors: [github]
    secrets: all
    kortix_permissions: all
  reviewer:
    description: Reviews diffs.
    mode: subagent
    prompt_file: agents/reviewer.md
    permission:
      bash: ask
      edit: deny
    skills: [code-review]
    extensions: all
\`\`\`

Note what happened: the behavior moved from each \`.md\` frontmatter into its agent block, and each \`.md\` now holds only its prompt; the project-wide permission was copied into both agents; the command, the plugin and the pi package became registry entries that each agent enables by name; \`kortix:memory\` was deleted (Kortix tools are always registered); \`opencode\`, \`harnesses\` and every \`file:\` key are gone, and \`harnesses/\` was removed with \`git rm -r\`. Your project will differ — apply the rules, not this output verbatim.

## 10. Write the file, remove the old ones

- Write the assembled manifest to \`kortix.yaml\` at the repo root. Start it with \`# yaml-language-server: $schema=https://kortix.com/schema/kortix.v3.schema.json\`.
- From v1: delete \`kortix.toml\` in the same commit. Never leave two manifests.
- With many triggers or long prompts, keep \`kortix.yaml\` readable with \`imports:\` (for example \`imports: [triggers/]\`, each file a \`triggers:\` list). \`agents\`, \`skills\`, \`tools\`, \`commands\` and \`extensions\` can be imported the same way.
- Carry meaningful comments over next to the same keys. Hand-written context in a manifest is documentation someone chose to leave.

## 11. Validate before you're done

Run \`kortix validate\`. Fix every error it reports — do not open the change request with a manifest that fails validation. Read the warnings. If an error surprises you, check the field against \`kortix schema --version 3\`.

## 12. Land it as a change request — never merge

First, re-sync: \`git fetch origin\` and check whether \`origin/main\` advanced while you worked (\`git log HEAD..origin/main --oneline\`). If it moved, rebase. If the rebase conflicts on the manifest or a moved file, don't fight it — \`git rebase --abort\`, \`git reset --hard origin/main\`, and redo the conversion against the CURRENT files, then continue. Never revert main's changes to win a conflict.

Then commit, **push the branch**, and open the change request. A commit that is never pushed leaves the CR empty and un-appliable (\`422 CR_HEAD_NOT_AHEAD\`):

\`\`\`
git add -A && git commit -m "Upgrade to kortix_version 3"
git push origin HEAD
kortix cr open --head <your-branch> --title "Upgrade to kortix_version 3" --description "<the default agent and why, every file you moved or removed, each agent's grants, every key or setting you dropped and why, and any grant you left narrowed>"
\`\`\`

If the push is rejected because the remote session branch moved, \`git fetch origin\` then \`git push --force-with-lease origin HEAD\` — your own session branch only, never any other branch.

Then verify the CR carries your diff: run \`kortix cr diff <number>\`. If it reports no changes, your push did not land; push again and re-check (the CR updates automatically, do not open a second one).

Do **not** run \`kortix cr merge\`. This is a human-reviewed change like any other — stop once the CR is open and verified non-empty, and tell the user its number so they can review the diff and merge it themselves.`;
