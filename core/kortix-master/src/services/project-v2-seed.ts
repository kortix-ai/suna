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

**Q1 — Scope check.**
If the kickoff description is already a full sentence, paraphrase it
back in one line and ask:

> "Anything to add — stuff it should NOT do, or nice-to-haves?"

If the description is empty or a single word, ask the open question:

> "Tell me in one or two sentences what this should do."

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

**Q5 — Check-in cadence.** One short ask with a real default:

> "I can sweep the board and post a summary on a cadence. Default is
> every hour — say a different cadence or 'no' to skip."

If they say "yes" / "fine" / "sounds good" → hourly. Any explicit
cadence ("every 30 min", "daily 9am", "weekdays only") → use that.
"no" / "skip" / "none" → no cron.

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
5. **If Q5 gave a cadence**: \`triggers(action="create", ...)\` — see
   "Scheduled board review" below. Bind to the dashboard ticket. If
   Q5 was "no", skip.
6. **\`ticket_create\` — cut the first work ticket.** This is what
   actually kicks the team. Pull the title + body from Q1 scope and
   Q2 stack. Routing:
   - **If @tech-lead is on the team**: assign the GOAL ticket to
     \`@tech-lead\` with the scope as the body (not yet decomposed —
     that's their job). Put in \`in_progress\` so they wake
     immediately.
   - **Else (no TL)**: assign directly to the primary implementer
     (usually \`@engineer\`). Include crisp acceptance criteria
     derived from scope + stack — what each endpoint/behavior must
     do, what tests must pass. Put in \`in_progress\`.

   Do NOT ask the human "should I cut a ticket?" — just do it.

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
  if (!listTickets(db, { projectId: project.id }).some((t) => t.created_by_type === 'system' && t.title === PM_DASHBOARD_TITLE)) {
    try {
      createTicket(db, {
        project_id: project.id,
        title: PM_DASHBOARD_TITLE,
        body_md: PM_DASHBOARD_BODY,
        status: PM_DASHBOARD_STATUS,
        assign_to: [{ type: 'agent', id: pm.id }],
        created_by_type: 'system',
        created_by_id: null,
      })
    } catch (err) {
      console.warn('[project-v2-seed] failed to seed PM dashboard ticket:', err instanceof Error ? err.message : err)
    }
  }

  return { pmAgent: pm }
}

// PM dashboard ticket — seeded once per project. Left as a constant so tests
// and the persona body reference the same title/body.
export const PM_DASHBOARD_TITLE = 'Board operations — ongoing'
export const PM_DASHBOARD_STATUS = 'in_progress'
export const PM_DASHBOARD_BODY = [
  '**@project-manager\'s running review thread.**',
  '',
  'This ticket stays in `in_progress` for the life of the project. Every board-sweep',
  'cron fire threads onto the same session via `ticket_id` → status updates accumulate',
  'as comments here. Use it to:',
  '',
  '- Skim what the team is working on without opening every ticket.',
  '- See PM\'s latest sweep verdict (stalled tickets, blockers, missing reviews).',
  '- Audit the cron\'s history — every fire is a comment.',
  '',
  'When you wire the board-sweep trigger during onboarding, bind it to THIS ticket\'s',
  'id via the `ticket_id` arg on the `triggers` tool. The reverse-lookup badge on',
  'this card will then read "ongoing" with the cadence in its tooltip.',
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
