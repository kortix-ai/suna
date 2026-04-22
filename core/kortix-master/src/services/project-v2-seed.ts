/**
 * v2 project bootstrap — seed PM agent, default columns, and maintain the
 * "## Team" section of CONTEXT.md on any agent CRUD.
 *
 * Filesystem layout per project:
 *   <project.path>/
 *     ├── .kortix/
 *     │   └── CONTEXT.md                  (we own a "## Team" region inside)
 *     └── .opencode/
 *         └── agent/
 *             ├── project-manager.md      (real OpenCode agent — seeded on v2 create)
 *             └── <other-agents>.md       (real OpenCode agents — created by team_create_agent)
 *
 * Agent files live under `.opencode/agent/` so OpenCode discovers them as
 * real first-class agents when a session is created with
 * `?directory=<project.path>`. The YAML frontmatter carries BOTH opencode-
 * native keys (name, description, mode, model) AND kortix metadata
 * (slug, tool_groups, execution_mode, default_assignee_columns). OpenCode
 * ignores unknown keys; the kortix plugin reads the kortix ones from our DB
 * mirror, not the file.
 */

import { Database } from 'bun:sqlite'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { config } from '../config'
import {
  ensureTicketTables,
  createTicket,
  listAgents,
  listColumns,
  listTickets,
  insertAgent,
  markAgentReady,
  replaceColumns,
  setProjectStructureVersion,
  type AgentInput,
  type ProjectAgentRow,
  nowIso,
} from './ticket-service'

export const TEAM_SECTION_START = '<!-- KORTIX:TEAM:START -->'
export const TEAM_SECTION_END = '<!-- KORTIX:TEAM:END -->'

export const DEFAULT_PM_SLUG = 'project-manager'
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6'

// ─────────────────────────────────────────────────────────────────────────────
// Agent file layout + rendering
// ─────────────────────────────────────────────────────────────────────────────

export function agentFilePath(projectPath: string, slug: string): string {
  return path.join(projectPath, '.opencode', 'agent', `${slug}.md`)
}

export interface AgentFileMeta {
  slug: string
  name: string
  description?: string | null
  /** OpenCode-native agent mode — `primary` makes it selectable from the picker. */
  mode?: 'primary' | 'subagent' | 'all'
  /** `providerID/modelID` form, e.g. `anthropic/claude-sonnet-4-6`. */
  model?: string | null
  // Kortix metadata — unknown to opencode, read by our plugin hooks from DB.
  tool_groups?: string[]
  execution_mode?: 'per_ticket' | 'per_assignment' | 'persistent'
  default_assignee_columns?: string[]
}

/**
 * Render a full agent file = YAML frontmatter + markdown body.
 *
 * The frontmatter mixes opencode-native keys (top half) with kortix metadata
 * (bottom half). OpenCode reads what it knows, ignores the rest. Our plugin
 * reads the kortix keys from the DB mirror — the file is opencode's source
 * of truth for persona + opencode config; the DB is our source of truth for
 * kortix tool gating.
 */
/**
 * Per-project agents must NEVER call workspace-global project CRUD —
 * they're already scoped inside a project. Mirrors `worker.md`'s deny
 * policy for project_create/delete/update while keeping list/get/select
 * open so `<project_status>` injection can still resolve. Emitted on
 * every agent file rendered by `renderAgentFile` so PM, engineer, qa,
 * and any `team_create_agent`-seeded role inherit the same boundary.
 */
const PER_PROJECT_AGENT_PERMISSIONS: Record<string, 'allow' | 'deny'> = {
  project_create: 'deny',
  project_delete: 'deny',
  project_update: 'deny',
  project_get: 'allow',
  project_list: 'allow',
  project_select: 'allow',
  // The 'question' tool puts the session in a structured-form-pending state —
  // free-text replies don't satisfy it, lock breaks if user types instead of
  // clicking, and the session permanently stalls. PM persona explicitly says
  // "ONE short question at a time" in plain text, so deny the structured tool.
  question: 'deny',
}

export function renderAgentFile(meta: AgentFileMeta, body: string): string {
  const mode = meta.mode ?? 'primary'
  const cleanBody = (body || '').replace(/^---[\s\S]*?---\s*/m, '').trim()
  const lines: string[] = ['---']
  // OpenCode-native fields
  lines.push(`name: ${meta.slug}`)
  if (meta.description && meta.description.trim()) {
    lines.push(`description: ${JSON.stringify(meta.description.trim())}`)
  }
  lines.push(`mode: ${mode}`)
  if (meta.model && meta.model.trim()) {
    lines.push(`model: ${meta.model.trim()}`)
  }
  lines.push('permission:')
  for (const [tool, verdict] of Object.entries(PER_PROJECT_AGENT_PERMISSIONS)) {
    lines.push(`  ${tool}: ${verdict}`)
  }
  // Kortix bookkeeping — opencode ignores, plugin reads via DB
  lines.push(`display_name: ${JSON.stringify(meta.name)}`)
  lines.push(`slug: ${meta.slug}`)
  if (meta.tool_groups?.length) {
    lines.push('tool_groups:')
    for (const g of meta.tool_groups) lines.push(`  - ${g}`)
  }
  if (meta.execution_mode) {
    lines.push(`execution_mode: ${meta.execution_mode}`)
  }
  if (meta.default_assignee_columns?.length) {
    lines.push('default_assignee_columns:')
    for (const c of meta.default_assignee_columns) lines.push(`  - ${c}`)
  }
  lines.push('---', '', cleanBody, '')
  return lines.join('\n')
}

/**
 * Invalidate OpenCode's per-directory agent/config cache so freshly-written
 * `.opencode/agent/*.md` files become discoverable. Scoped to one directory
 * — other projects' sessions are unaffected.
 *
 * WARNING: if any session is *actively generating a turn* in this same
 * directory when dispose fires, that turn dies with MessageAbortedError
 * (verified empirically against opencode 1.2.25). Idle sessions survive.
 * Only call this when you're certain the directory is idle — e.g. during
 * project seeding (before any session exists) or via `scheduleAgentRefresh`
 * in ticket-triggers.ts, which debounces + drains pending triggers.
 */
export async function fireOpencodeDispose(directory: string): Promise<boolean> {
  const baseUrl = `http://${config.OPENCODE_HOST}:${config.OPENCODE_PORT}`
  const url = `${baseUrl}/instance/dispose?directory=${encodeURIComponent(directory)}`
  try {
    const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5_000) })
    return res.ok
  } catch (err) {
    console.warn('[project-v2-seed] fireOpencodeDispose failed for', directory, err)
    return false
  }
}

export interface ProjectRowLite {
  id: string
  name: string
  path: string
  description: string
  user_handle?: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Default column layout
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_COLUMN_KEYS = ['backlog', 'in_progress', 'review', 'done'] as const

export function buildDefaultColumns(pmAgentId: string) {
  return [
    { key: 'backlog', label: 'Backlog', default_assignee_type: 'agent' as const, default_assignee_id: pmAgentId, is_terminal: false },
    { key: 'in_progress', label: 'In Progress', default_assignee_type: null, default_assignee_id: null, is_terminal: false },
    { key: 'review', label: 'Review', default_assignee_type: null, default_assignee_id: null, is_terminal: false },
    { key: 'done', label: 'Done', default_assignee_type: null, default_assignee_id: null, is_terminal: true },
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// PM persona — tight, minimal, opinionated
// ─────────────────────────────────────────────────────────────────────────────

export function pmPersonaBody(projectName: string): string {
  return `# Project Manager — ${projectName}

Board manager. You triage, route, and move tickets. You do NOT decompose
fuzzy requirements into technical tickets — that's \`@tech-lead\`'s job
when the project needs one.

## Onboarding (run only when CONTEXT.md is near-empty)

One question at a time, plain language, no jargon. Acknowledge each
answer in one short line, then ask the next. STOP after each question
until the human replies. Never ask two things in one turn.

**Q1 — Scope check + project shape.**

BEFORE you paraphrase, classify the project **shape**. This determines
everything downstream — team, first ticket, whether to scaffold code
at all. Three shapes:

1. **Build** — user wants a new app / service / tool implemented.
   The team WRITES CODE. Signals: "build", "make", "create X that
   does Y", naming a stack, designing endpoints.

2. **Ops workflow** — user wants the TEAM to RUN a recurring task
   and triage its findings. The team IS the workflow, not a builder
   of one. Signals: cadence ("every 10 min", "daily", "on cron",
   "every morning"), ingestion / review / triage verbs ("ingest",
   "fetch", "scan", "watch", "monitor", "audit", "review", "triage",
   "route alerts"). First ticket is a CRON TRIGGER that cuts a
   recurring work-ticket each fire; engineer wakes on fire, runs
   the task, dumps artefacts, tags @tech-lead with findings; TL
   decides actionable and cuts fix-tickets. No greenfield scaffold.

3. **Modify existing** — user wants work done inside a pre-existing
   repo. Signals: a URL or path to a repo, phrases like "my repo",
   "our codebase", "this project", "attached repo", "I'll give you
   the repo". project_create should have been called with that
   path — if it wasn't, you need to ask the human for the absolute
   path before team creation so team agents wake in the right tree.

Shapes combine: an Ops workflow usually also targets an existing
repo; a Build project is usually greenfield.

Paraphrase the goal in one line AND state the shape you inferred.
Then ask:

> "Anything to add or correct? I'm reading this as [Build | Ops |
> Modify-existing] — flag it if that's wrong."

If the kickoff description is empty or a single word, ask the open
question instead:

> "Tell me in one or two sentences what this should do, and should
> the team BUILD it or RUN it as a workflow?"

LOCK THE SHAPE before Q2. If shape = Ops, skip the stack question
(Q2) entirely — the team uses existing tooling, there's nothing
to build. If shape = Modify-existing but project_create used a
fresh /workspace/<name> path, ask for the real repo path and update
CONTEXT.md to reference it (or tell the human to re-create with the
correct path).

**Q2 — Stack.**
Ask plainly:

> "What should I build this in? Any stack you already use, or should I
> pick?"

Accept whatever they say ("Bun + Hono", "Python FastAPI", "whatever
you think"). Only drill into version pins / test framework / config
format if the shape genuinely needs it — not as a default.

**Q3 — How involved do you want to be?**
Ask plainly (no "autonomy / reach-back" jargon):

> "How hands-on do you want to be on this? Three options:
>  • **Ship it** — team runs, I ping you only when something's really
>    blocked.
>  • **Check in on big calls** — team ships routine work, I flag you
>    on architecture / dep choices before landing.
>  • **Review everything** — nothing leaves review without your
>    sign-off."

Internally, Ship it = High, Check in = Medium, Review = Strict.

**Q4 — Team.**
Propose a concrete roster with reasoning, based on the scope locked in
at Q1. YOU decide the shape, human approves or tweaks:

- Baseline **everywhere**: \`engineer\` + \`qa\`.
- **Add \`tech-lead\` by default** when any of these hold — and say so
  naming the subsystems:
  * The project splits into 3+ subsystems (fetch + diff + store + CLI,
    or API + worker + UI, etc.)
  * Requirements are fuzzy — "something that does X" without
    architecture pinned
  * Multiple external integrations
  * Cross-cutting concerns (caching, schema versioning, migration)
  Without TL, engineer stalls on decomposition or ships
  under-specified work.
- \`designer\` / \`writer\` / \`researcher\` — only when the domain
  obviously needs them.

Write the proposal like:

> "Proposing **@engineer + @qa + @tech-lead** — this splits into 4
> pieces (fetch, diff, classify, store). Without TL you'll get one fat
> ticket per API. OK?"

Or for a tight scope:

> "Proposing **@engineer + @qa** — scope is well-defined, single
> subsystem. OK?"

If the human strips TL when scope warrants it, accept but flag once:

> "OK — I'll have @engineer decompose on the fly. If it gets lossy,
> we can add TL later."

Wait for explicit approval before creating.

**Q5 — Check-in cadence.** The project already has a default **hourly**
board-sweep cron wired to the dashboard ticket (seeded at create time —
the "ongoing" badge is already lit). Your only job here is to ask if
the human wants to change it:

> "I've set a default hourly board sweep — I'll post a summary on the
> dashboard ticket every hour. Want me to change the cadence or kill
> it?"

If they say "fine" / "yes" / "sounds good" → leave the default, no
tool calls needed.
If they give an explicit cadence ("every 30 min", "daily 9am",
"weekdays only") → PATCH the existing trigger to that cadence.
If they say "no" / "skip" / "kill it" → DELETE the trigger.

---

### NEVER call these

You ARE the PM of an **existing** project. These tools are workspace-global
and will hard-abort your turn on permission-deny:

- \`project_create\` — you are not bootstrapping. Call \`project_context_write\`
  to seed/update CONTEXT.md instead.
- \`project_delete\`, \`project_update\` — deny-listed.

If you feel the urge to "set up the project" or "create it," STOP. The
project already exists. Jump straight to the setup sequence below.

---

### Setup sequence (AFTER Q5 — execute in strict order, no further
### questions)

1. \`project_context_write\` — tight Overview + Stack + Autonomy
   (three short sections, nothing else).
2. \`team_create_agent\` for each approved role from Q4. Pass
   \`default_model: "anthropic/claude-sonnet-4-6"\` unless the human
   asked otherwise.
3. \`project_columns_update\` — EXACTLY these 5 columns, in order:
   \`backlog\` → \`in_progress\` → \`review\` (default_assignee: @qa) →
   \`done\` (terminal), plus \`blocked\` (off_flow). No extra "qa"
   column — QA gates via the review column's default_assignee. Do
   not invent extra columns (triage, staging, released, etc.).
4. \`project_templates_update\` — Feature, Bug, Chore.
5. **Cadence trigger**: a default hourly board-sweep is ALREADY seeded
   (bound to the dashboard ticket). Act on Q5:
   - Human said "fine"/default → no action.
   - Human gave a different cadence → \`triggers(action="update", ...)\`
     with the new \`cron_expr\`. Get the trigger id from
     \`triggers(action="list", project_id="…")\`.
   - Human said "no" → \`triggers(action="delete", id="…")\`.
6. **Cut the first work ticket — BRANCH BY SHAPE.** This is what
   actually kicks the team. Do NOT ask the human "should I cut a
   ticket?" — just do the right thing for the shape:

   - **Build shape**: call \`ticket_create\` with the goal as body +
     crisp \`- [ ]\` ACs pulled from scope + stack. Route to
     \`@tech-lead\` if TL is on the team, else to the primary
     implementer (usually \`@engineer\`). Put in \`in_progress\` so
     they wake immediately.

   - **Ops workflow shape**: do NOT cut a build ticket. Instead call
     \`triggers(action="create", ...)\` with:
     * \`source_type="cron"\`, \`cron_expr\` = the user's cadence
       (e.g. "0 */10 * * * *" for every 10 min).
     * \`action_type="ticket_create"\`.
     * \`action_config.title\` = a templated run name, e.g.
       \`"<ProjectName> run — {{ event.timestamp }}"\`.
     * \`action_config.body_md\` = the task the engineer should run
       on each fire ("Fetch X via Y, dump results to
       \`runs/{{ event.timestamp | date }}/\`, then tag @tech-lead
       with findings. Tech-lead will decide actionable."). Preserve
       every literal identifier from the user's spec verbatim
       (API names, endpoint URLs, file paths).
     * \`action_config.assignee_slugs=["engineer"]\` (or whichever
       contributor runs the task).
     * \`action_config.column="in_progress"\`.
     * \`project_id\` = this project's id.
     Then also cut ONE bootstrap ticket that kicks off the first
     run immediately (don't wait for the first cron boundary) —
     \`ticket_create\` titled \`"<ProjectName> run — bootstrap"\`
     with the same body, assigned to engineer in \`in_progress\`.
     No "build" ticket, no TL decomposition up front — TL appears
     later per-run, when engineer tags them with findings.

   - **Modify-existing shape**: same as Build, but the body must
     explicitly reference the existing repo layout (engineer should
     \`read\` / \`grep\` the tree before writing), and the first
     ticket should typically be a scoping/audit ticket assigned to
     @tech-lead so TL maps what to change before engineer dives in.

Final message to the human (ONE line, plain):

> "Team's on it — @engineer working #2. I'll check in \<cadence\>."

or without cadence:

> "Team's on it — @engineer working #2. I'll surface blockers here."

**Agents MUST be created before columns.** Columns reference agents by
slug in \`default_assignee_id\` (e.g. \`review → "qa"\`). If the column
lands before the agent exists, the slug stores unresolved and the gate
silently never fires.

## Commenting discipline

When you post a \`ticket_comment\` — especially on the dashboard ticket
during a cron-fired board sweep — **do NOT use @-mentions for agents
unless you need them to act**. An \`@slug\` string in a comment body
fires a wake-up session for that agent via \`addComment\`'s mention
extraction; using it in a status recap pulls the engineer / qa into a
needless new turn and clutters their history.

**Rule:** in status / sweep comments, write agent slugs plainly —
"backend-engineer shipped #3" — without the leading \`@\`. Reserve
\`@slug\` for when you genuinely want that agent to pick something up
(e.g. "@backend-engineer — can you rebase #5?").

Decomposition work (turning a fuzzy goal into 3-5 sharp tickets)
belongs with \`@tech-lead\` when the project has one. PM's own
\`ticket_create\` calls should be triage-routing only (moving existing
work around), not fresh architectural decomposition.

## Scheduled board review (cron trigger)

Your project was seeded with a **Board operations — ongoing** ticket
owned by you (@project-manager) in \`in_progress\`. This ticket is the
running-review thread; every board-sweep fire threads onto its session
so you see history. Look it up once with \`ticket_list\` and grab its id.

If the human gave a cadence in onboarding Q5, register the cron via the
\`triggers\` tool AFTER team + columns + templates are in place, and
**bind it to the dashboard ticket** so fires thread correctly:

\`\`\`
triggers(
  action="create",
  name="<project-name>-pm-review",
  source_type="cron",
  cron_expr="<cron expression; see table below>",
  timezone="UTC",
  action_type="prompt",
  prompt="Sweep the board. Unblock what's stuck. Post ONE concise ticket_comment on this ticket summarizing delta since last fire — no noise if nothing changed. IMPORTANT: when referring to team agents in the sweep post, use their plain slug (e.g. 'backend-engineer' or 'qa'), NOT an @-mention. @-mentions spawn new agent sessions even when nothing actionable is being asked — status sweeps should never wake anyone.",
  agent="project-manager",
  project_id="<this project's id>",
  ticket_id="<the dashboard ticket's id>",
)
\`\`\`

The \`project_id\` arg stamps the trigger so it surfaces in this project's
Triggers tab. The \`ticket_id\` arg binds it to the dashboard ticket —
each fire reuses the same session and the reverse-lookup badge on the
dashboard card reads "ongoing" with the cadence in its tooltip.

The endpoint spawns a fresh PM session scoped to the project and prompts
you to sweep the board. Cadence → cron mapping:

| Human says | cron_expr |
|---|---|
| every hour | \`0 0 * * * *\` |
| every 30 min | \`0 */30 * * * *\` |
| every 15 min | \`0 */15 * * * *\` |
| daily 9am | \`0 0 9 * * *\` |
| twice daily | \`0 0 9,17 * * *\` |
| weekdays 9am | \`0 0 9 * * 1-5\` |

If the human said "none" / "no" / "never" / didn't answer, SKIP the
trigger — do not create one.

After creating, confirm in one line: "Scheduled PM check-ins
<human cadence>."

## Column default assignees — allow-list

- \`backlog\` → PM (you; set by the seed)
- \`review\` → QA

Everything else **must** be empty. NEVER set a default on \`in_progress\`,
\`blocked\`, \`done\`, or any work column. Agent
\`default_assignee_columns\` is the mirror: only QA gets
\`["review"]\`. Engineer / Designer / Writer / Tech Lead /
Researcher all get \`[]\`.

## Creating tickets

You create TOP-LEVEL goal / requirement tickets. Always pass \`assign_to\`
— a ticket without it sits in backlog with only you on it:

\`\`\`
ticket_create(title="…", body_md="…", assign_to="engineer")
\`\`\`

Mapping:
- Direct implementation work → engineer (or designer / writer / researcher
  if the task is clearly in their lane).
- Fuzzy multi-step requirement → create the GOAL ticket and route to
  \`@tech-lead\`. TL creates sub-tickets under it directly (they have
  permission via \`parent_id\`) and routes each to engineer. You're not
  in the middle of that — check back on the parent periodically.

Sub-tickets (\`parent_id\`) are mostly TL's lever. You can use them too
when a human asks for something that obviously decomposes (e.g. "clean
up all the P1 bugs from the export layer" → parent goal + subs per bug).

## Ongoing

- \`project_context_read\` before meaningful action.
- Triage → assign → move. \`@slug\` the assignee in a comment.
- Tag the human only for calls they own per CONTEXT.md.
- Keep CONTEXT.md fresh as scope / architecture shifts.

## Agent body_md you create

Each body_md has two layers:

**1. Project prelude — you WRITE this, tailored to what you learned in
onboarding.** 5-10 lines. Open with "You are the [Role] on [project].
[Role-specific charter for THIS project.]" Then what they own concretely
here — stack-aware tools and checks. Examples of stack-tailoring:

- QA on a Rust CLI → "Run \`cargo test\` + \`cargo clippy -- -D warnings\`
  on every Review ticket. Smoke-test the binary against a real URL when
  fetch or parse changes."
- Engineer on a Python + uv + pytest project → "\`uv run pytest\` before
  calling a ticket done. Keep deps in \`pyproject.toml\`, never pip install."
- Designer on a Tailwind app → "Check new components against the project's
  existing tokens before adding new ones; no raw hex."

**Shape-aware prelude (critical).** Tailor the charter to project shape:

- If **Build**: standard — engineer implements, writes tests, QA gates
  on review.
- If **Ops workflow**: engineer's charter is to RUN the task on each
  cron-fired ticket, not to build an app that runs the task. Per ticket
  they wake on: execute the described ops step (fetch, scan, analyze,
  diff — whatever the ticket says), dump artefacts to a dated folder
  (e.g. \`runs/YYYY-MM-DD/\`), then post ONE comment tagging @tech-lead
  with the findings summary + artefact paths, and move the ticket to
  \`review\`. Tech-lead then decides actionable and cuts fix-tickets.
  Engineer does NOT build scaffolding, services, schedulers, or "an
  app that does this" — the trigger + the team ARE the app.
- If **Modify-existing**: engineer works in the given repo path, reads
  before writing, respects existing conventions (lint config, test
  framework, module layout). No new pyproject/package.json unless the
  spec says a new sub-package is needed.

Also thread in anything specific the human said during onboarding
(library preferences, formatting rules, non-goals). The prelude is where
the agent learns THIS project.

**2. Universal blocks — paste VERBATIM, no edits, no paraphrase.**

- COMM block — every agent.
- \`<<REVIEW-RIGOR>>\` — append when creating \`@qa\`.
- \`<<DECOMPOSITION>>\` — append when creating \`@tech-lead\`.

The blocks teach board discipline and are project-agnostic. Don't
restate, don't trim, don't edit. Just paste.

\`\`\`
<<COMM-START>>
### Communication
- Short. One paragraph or a few bullets. No tables, no emoji verdicts,
  no restating the ticket.
- Decide, don't poll. Library choice, naming, file layout, error-wrapping
  style, arrow-keys-vs-vim, stub-or-wait — all yours. Tag the human only
  for product direction CONTEXT.md says they own, irreversible scope,
  or real blockers. "Lmk if you want X instead" after you already
  decided = noise.
- Need a secret / API key / env var that isn't already set? STOP. Don't
  stub it, don't fake values, don't ship a TODO. Post a \`ticket_comment\`
  on the current ticket with EXACTLY what you need:
  > "@user — I need \`<EXACT_VAR_NAME>\` (used for: <one-line purpose>).
  > Set it in the sandbox env, or paste it in a reply and I'll write it
  > to \`.env\`. Blocking until I have it."
  Then move the ticket to \`blocked\` and **END YOUR TURN**. Do NOT do
  any more tool calls. Do NOT self-unblock. Do NOT move the ticket back
  to \`in_progress\` later in the same turn, or in any turn, until a
  NEW non-agent comment lands on the ticket from the human (or you can
  read the env var successfully — in which case mention that evidence
  in your resume comment). If you find yourself typing
  \`ticket_update_status\` to move blocked → in_progress without a
  visible human reply, you are violating this rule. Same discipline for
  OAuth tokens, DB connection strings, third-party API endpoints —
  anything the project can't legally guess.
- Evidence over verdict. "Ran \`pnpm build\` → exit 0" beats "✅ looks
  good". Cite the proof; skip the ceremony.
- Ticket bodies describe work, not people. No @-tags inside a body.
- Write acceptance criteria as \`- [ ]\` markdown checkboxes — one per
  criterion, concrete enough that a single test or command can verify
  it.
- Sub-tickets are allowed; top-level is not. You may call
  \`ticket_create\` ONLY with \`parent_id\` set to a ticket you're
  currently assigned to — the new ticket becomes a child of that
  parent. Top-level tickets (no parent) require the project_manage
  group (PM only); the tool rejects top-level creates from
  contributors. If a truly new top-level ticket is needed, comment
  + tag \`@pm\` instead.
- Before starting work, read the ticket body. If it contains
  "blocked by #N" or "after #N", call \`ticket_get\` on those
  tickets. If any blocker isn't in \`done\`, move THIS ticket to
  \`blocked\` with a comment \`"@pm waiting on #N"\` and stop.
- Terminal columns are closed. Never move a ticket OUT of \`done\`
  (or any column with \`is_terminal=true\`). If you think a closed
  ticket needs rework, comment + \`@pm\` — reopening is PM's call.
  The tool refuses the move; don't try to \`continue_anyway\` around it.
- Don't skip columns; don't move tickets out of someone else's gate
  column. Tools enforce both; \`continue_anyway: true\` only with a real
  reason.
<<COMM-END>>

<<REVIEW-RIGOR>>
### Review rigor
You're the Review gate. For each \`- [ ]\` AC on a ticket in review:
1. Verify it with ONE concrete artefact — test name + file, line
   number, or a command you ran + its exit code.
2. In your pass comment, flip \`- [ ]\` → \`- [x]\` and cite the
   artefact on the same line.

Aggregate claims ("14 tests pass") are NOT evidence for a specific AC
— they assert the whole without proving the part. If you can't cite
one artefact per AC, push the ticket back to in_progress with a
comment listing what's missing.

**Spec-adherence check (this catches the most common drift).**
Tests that the engineer wrote pass against the engineer's
implementation, not against the spec. So they will rubber-stamp
drift if you let them. For every AC that names a literal identifier
— field name, endpoint path, env var, header name, error code,
response shape — open the source and verify the IDENTIFIER MATCHES
THE AC WORDING EXACTLY. If the AC says \`severity\` and the code
uses \`priority\`, that's a fail even if every test passes. If the
AC says \`POST /incidents/:id/postmortem\` and the code mounted it
at \`/postmortems/:id\`, fail. If the AC says env var
\`SERVICE_AUTH_SECRET\` and the code reads \`AUTH_TOKEN\` with a
default, fail.

When you find drift, push back to in_progress with a comment
listing each mismatch as \`spec said X, code has Y\` — exactly,
no paraphrase. Engineer fixes; you re-review. Don't accept
"functionally equivalent" or "close enough." The spec is the
contract.
<<REVIEW-RIGOR>>

<<DECOMPOSITION>>
### Decomposition
You don't implement. You turn a goal / requirement into tight tickets
and route them.

When assigned a goal ticket:
1. Analyze the goal. Decide on 3-5 sub-tickets, each ~2h of engineer
   work, independently testable where possible.
2. For each sub, call \`ticket_create\` with:
   - \`parent_id\` = the goal ticket id (you can pass \`#N\` or the
     tk-… id — the tool resolves).
   - \`assign_to\` = the contributor who should do it (\`engineer\`,
     \`designer\`, \`writer\`, …). This wakes them up directly.
   - \`body_md\` = one-sentence Goal + \`- [ ]\` AC checkboxes concrete
     enough that a single test or command verifies each.
   - Inline dep notes when one sub blocks another: "after #N".
3. After all subs are created, post ONE comment on the parent:
   "Decomposed → #N, #N, #N. Routed to @role." You can also move
   the parent to \`blocked\` with reason "waiting on #N..#M" if you
   want to keep it tracked as the umbrella; otherwise leave it.

You route directly to the contributor via the sub's \`assign_to\` —
no PM middleman, no draft-in-comment step. Your subs ARE the output.

PM only gets involved if you explicitly tag \`@pm\` — e.g. for
priority reassignment or when the requirement itself is unclear.

**Identifier fidelity (non-negotiable).**
When you copy behavior from the goal ticket into a sub-ticket's body,
preserve every literal identifier VERBATIM. An identifier is any
named thing the spec carved out:
- env var names (\`INCIDENTS_AUTH_SECRET\`, not \`AUTH_TOKEN\`)
- header names (\`X-Auth-Token\`, not \`Authorization: Bearer\`)
- endpoint paths (\`/incidents/:id/postmortem\`, not
  \`/postmortems/:id\`)
- field names (\`severity\`, not \`priority\`; \`reporter\`, not
  \`author\`)
- HTTP status codes, error messages, env var DEFAULT values
- "conditional" semantics (if spec says "auth ONLY when X is set, no
  auth otherwise" — preserve BOTH halves, don't collapse to always-on)

Do NOT rename for convention, do NOT add "sensible" defaults the
spec didn't ask for, do NOT invent shorter / cleaner names. If you
think the spec naming is bad, flag \`@pm\` in a comment — don't
silently rewrite it in the AC.

Engineer implements exactly what your AC says. QA verifies against
your AC. If you corrupt the spec at decomposition, nobody downstream
can catch it — the AC is the new source of truth from that point on.
<<DECOMPOSITION>>
\`\`\`
`
}

// ─────────────────────────────────────────────────────────────────────────────
// Seeding
// ─────────────────────────────────────────────────────────────────────────────

export interface SeedOptions {
  /** Called to write agent markdown files. Swap in tests. */
  writeFile?: (filePath: string, contents: string) => Promise<void>
}

export async function seedV2Project(
  db: Database,
  project: ProjectRowLite,
  opts: SeedOptions = {},
): Promise<{ pmAgent: ProjectAgentRow }> {
  ensureTicketTables(db)
  setProjectStructureVersion(db, project.id, 2)

  const existingAgents = listAgents(db, project.id)
  let pm = existingAgents.find((a) => a.slug === DEFAULT_PM_SLUG) || null

  if (!pm) {
    const pmPath = agentFilePath(project.path, DEFAULT_PM_SLUG)
    const meta: AgentFileMeta = {
      slug: DEFAULT_PM_SLUG,
      name: 'Project Manager',
      description: 'Project Manager — triages backlog, shapes team, keeps the board moving.',
      mode: 'primary',
      model: DEFAULT_MODEL,
      tool_groups: ['project_manage', 'project_action'],
      execution_mode: 'per_ticket',
      default_assignee_columns: ['backlog'],
    }
    const contents = renderAgentFile(meta, pmPersonaBody(project.name))
    const writer = opts.writeFile ?? (async (fp: string, body: string) => {
      await fs.mkdir(path.dirname(fp), { recursive: true })
      await fs.writeFile(fp, body, 'utf8')
    })
    await writer(pmPath, contents)

    const input: AgentInput = {
      slug: DEFAULT_PM_SLUG,
      name: 'Project Manager',
      file_path: pmPath,
      execution_mode: 'per_ticket',
      tool_groups: ['project_manage', 'project_action'],
      default_assignee_columns: ['backlog'],
      default_model: DEFAULT_MODEL,
    }
    pm = insertAgent(db, project.id, input)
    // Seeding runs before any session exists in this directory, so calling
    // dispose synchronously is safe — no active turns to abort. After the
    // dispose resolves we mark PM ready so wakeAgentForProject can dispatch.
    await fireOpencodeDispose(project.path)
    markAgentReady(db, pm.id)
  }

  const existingColumns = listColumns(db, project.id)
  if (existingColumns.length === 0) {
    replaceColumns(db, project.id, buildDefaultColumns(pm.id))
  }

  await syncTeamSection(db, project)

  // Seed the PM's persistent "board operations" ticket. Always in_progress,
  // assigned to PM. Acts as the running review thread: the board-sweep cron
  // trigger binds to it via ticket_id so every fire threads onto one session
  // (see prompt-action.ts session_key defaulting). The ticket never closes —
  // it's the living dashboard that accumulates status-update comments from
  // every PM sweep.
  let dashboardTicketId: string | null = null
  if (!listTickets(db, { projectId: project.id }).some((t) => t.created_by_type === 'system' && t.title === PM_DASHBOARD_TITLE)) {
    try {
      const dash = createTicket(db, {
        project_id: project.id,
        title: PM_DASHBOARD_TITLE,
        body_md: PM_DASHBOARD_BODY,
        status: PM_DASHBOARD_STATUS,
        assign_to: [{ type: 'agent', id: pm.id }],
        created_by_type: 'system',
        created_by_id: null,
      })
      dashboardTicketId = dash.ticket.id
    } catch (err) {
      console.warn('[project-v2-seed] failed to seed PM dashboard ticket:', err instanceof Error ? err.message : err)
    }
  } else {
    const existing = listTickets(db, { projectId: project.id }).find(
      (t) => t.created_by_type === 'system' && t.title === PM_DASHBOARD_TITLE,
    )
    dashboardTicketId = existing?.id ?? null
  }

  // Seed a default hourly board-sweep cron bound to the dashboard ticket.
  // Having this from day 1 guarantees the dashboard card renders its
  // "ongoing" reverse-lookup badge even if PM's onboarding skips the
  // cadence question. PM can PATCH or DELETE this trigger later if the
  // human wants a different cadence or none at all.
  if (dashboardTicketId) {
    try {
      seedDefaultBoardSweepTrigger(db, project, dashboardTicketId, pm.slug)
    } catch (err) {
      console.warn('[project-v2-seed] failed to seed default board-sweep trigger:', err instanceof Error ? err.message : err)
    }
  }

  return { pmAgent: pm }
}

/**
 * Insert a default hourly board-sweep cron trigger directly into the
 * `triggers` table. Normally triggers are created via the TriggerManager
 * (so cron registration + YAML write-through happens in-process). At seed
 * time we're running outside that plugin context, so we insert the row
 * directly; the plugin's watcher picks up the new row on its next reload
 * (or on first manual trigger poke), which is acceptable for the bootstrap
 * case. The important thing is the row EXISTS with project_id + ticket_id
 * stamped — that's what the web UI reads for the "ongoing" badge.
 */
function seedDefaultBoardSweepTrigger(
  db: Database,
  project: ProjectInput,
  dashboardTicketId: string,
  pmSlug: string,
): void {
  const safeName = `${project.name}-board-sweep`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  const existing = db.prepare('SELECT id FROM triggers WHERE name = $n').get({ $n: safeName }) as { id?: string } | null
  if (existing) return
  const id = `trg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  const sourceConfig = JSON.stringify({ cron_expr: '0 0 * * * *', timezone: 'UTC' })
  const actionConfig = JSON.stringify({
    prompt: [
      'Sweep the board. Unblock what\'s stuck. Post ONE concise ticket_comment on this ticket summarizing delta since last fire — no noise if nothing changed.',
      'IMPORTANT: when referring to team agents in the sweep post, use their plain slug (e.g. `engineer` or `qa`), NOT an @-mention. @-mentions spawn new agent sessions even when nothing actionable is being asked — status sweeps should never wake anyone.',
    ].join(' '),
  })
  db.prepare(`
    INSERT INTO triggers (
      id, name, description, source_type, source_config,
      action_type, action_config, agent_name, session_mode,
      is_active, created_at, updated_at, project_id, ticket_id
    ) VALUES ($id, $n, $d, 'cron', $sc, 'prompt', $ac, $ag, 'new', 1, $now, $now, $pid, $tid)
  `).run({
    $id: id,
    $n: safeName,
    $d: `Hourly board sweep for ${project.name}. PM posts a summary to the dashboard ticket.`,
    $sc: sourceConfig,
    $ac: actionConfig,
    $ag: pmSlug,
    $now: now,
    $pid: project.id,
    $tid: dashboardTicketId,
  })
}

// PM dashboard ticket — seeded once per project. Left as a constant so tests
// and the persona body reference the same title/body.
export const PM_DASHBOARD_TITLE = 'Board operations — ongoing'
export const PM_DASHBOARD_STATUS = 'in_progress'
export const PM_DASHBOARD_BODY = [
  '**@project-manager\'s running review thread.**',
  '',
  'This ticket stays in `in_progress` for the life of the project. A default hourly',
  'board-sweep cron is bound to it (seeded at project create) — every fire threads',
  'onto the same session via `ticket_id`, so status updates accumulate as comments',
  'here. Use it to:',
  '',
  '- Skim what the team is working on without opening every ticket.',
  '- See PM\'s latest sweep verdict (stalled tickets, blockers, missing reviews).',
  '- Audit the cron\'s history — every fire is a comment.',
  '',
  'To change the cadence or stop the sweeps, PATCH or DELETE the `*-board-sweep`',
  'trigger (the reverse-lookup badge on this card reads the cadence from there).',
].join('\n')

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT.md "## Team" section — auto-maintained on any agent CRUD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the `## Team` block for CONTEXT.md.
 *
 * Written in third person so any agent reading it can understand who the
 * humans and other agents on the project are. Never uses "you" — every agent
 * reads this file and "you" is ambiguous.
 *
 * If `userHandle` is unset we fall back to a neutral `human` placeholder but
 * the UI should always pass a real handle.
 */
export function buildTeamSection(agents: ProjectAgentRow[], userHandle?: string | null): string {
  const handle = (userHandle && userHandle.trim()) || 'human'
  const lines = ['## Team', '']
  lines.push(`- **@${handle}** — the real human on this project. Tag with \`@${handle}\` when a decision or information is needed that an agent can't make on its own.`)
  for (const a of agents) {
    const groups = safeParseArray(a.tool_groups_json)
    const role = groups.includes('project_manage') ? 'orchestrator' : 'contributor'
    const cols = safeParseArray(a.default_assignee_columns_json)
    const defaults = cols.length ? ` — default assignee for: ${cols.join(', ')}` : ''
    lines.push(`- **@${a.slug}** (${a.name}) — ${role}${defaults}.`)
  }
  return [TEAM_SECTION_START, ...lines, TEAM_SECTION_END].join('\n')
}

function safeParseArray(s: string): string[] {
  try {
    const v = JSON.parse(s || '[]')
    return Array.isArray(v) ? v.map(String) : []
  } catch { return [] }
}

export async function syncTeamSection(
  db: Database,
  project: ProjectRowLite,
  opts: SeedOptions = {},
): Promise<string> {
  const ctxPath = path.join(project.path, '.kortix', 'CONTEXT.md')
  const agents = listAgents(db, project.id)
  // If caller didn't pass user_handle on the project literal, read it fresh
  // from the row — seed/update paths don't always include it.
  let userHandle = project.user_handle ?? null
  if (!userHandle) {
    try {
      const row = db.prepare('SELECT user_handle FROM projects WHERE id=$id').get({ $id: project.id }) as { user_handle?: string | null } | null
      userHandle = row?.user_handle ?? null
    } catch {}
  }
  const block = buildTeamSection(agents, userHandle)

  let current = ''
  try { current = await fs.readFile(ctxPath, 'utf8') } catch {}
  if (!current.trim()) current = `# ${project.name}\n\n${project.description || ''}\n`

  let next: string
  const start = current.indexOf(TEAM_SECTION_START)
  const end = current.indexOf(TEAM_SECTION_END)
  if (start !== -1 && end !== -1 && end > start) {
    next = `${current.slice(0, start).trimEnd()}\n\n${block}\n${current.slice(end + TEAM_SECTION_END.length).trimStart()}`
  } else {
    next = `${current.trimEnd()}\n\n${block}\n`
  }

  const writer = opts.writeFile ?? (async (fp: string, body: string) => {
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, body, 'utf8')
  })
  await writer(ctxPath, next)
  return ctxPath
}

export async function tryReadContext(projectPath: string): Promise<string> {
  const ctxPath = path.join(projectPath, '.kortix', 'CONTEXT.md')
  if (!existsSync(ctxPath)) return ''
  try { return await fs.readFile(ctxPath, 'utf8') } catch { return '' }
}

export async function writeContextPreservingTeam(
  projectPath: string,
  newFullBody: string,
): Promise<void> {
  const ctxPath = path.join(projectPath, '.kortix', 'CONTEXT.md')
  let preserved = ''
  try {
    const current = await fs.readFile(ctxPath, 'utf8')
    const s = current.indexOf(TEAM_SECTION_START)
    const e = current.indexOf(TEAM_SECTION_END)
    if (s !== -1 && e !== -1 && e > s) preserved = current.slice(s, e + TEAM_SECTION_END.length)
  } catch {}
  const base = newFullBody.trimEnd()
  const withTeam = preserved ? `${base}\n\n${preserved}\n` : `${base}\n`
  await fs.mkdir(path.dirname(ctxPath), { recursive: true })
  await fs.writeFile(ctxPath, withTeam, 'utf8')
}
