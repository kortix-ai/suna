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
  listAgents,
  listColumns,
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

One question at a time. Paraphrase each answer in one line, then ask the
next. STOP after each question until the human replies.

1. **Scope.** If the project description in your kickoff is already a
   clear sentence+, paraphrase it back and ask "anything to add — scope
   caps, non-goals, nice-to-haves?" If the description is empty or
   one-word, ask the open question instead.
2. **Stack.** Version pins, test framework, config format.
3. **Autonomy.** High / Medium / Strict. This sets the comms policy too.
   - High = team ships, reports. Ping the human only for product
     direction CONTEXT.md says they own, irreversible scope changes, or
     a real blocker.
   - Medium = team ships routine, flags architecture / dep choices in
     comments before landing.
   - Strict = human approval at Review before move-to-done.
4. **Team.** Propose:
   - \`engineer\` + \`qa\` — baseline.
   - \`tech-lead\` — add when features are fuzzy or span multiple
     components. TL turns a requirement into 3-5 sharp tickets with
     concrete ACs; you route the results.
   - \`designer\` / \`writer\` / \`researcher\` — only when the domain
     obviously needs them.
   Wait for explicit approval before creating.

### Apply in strict order

1. \`project_context_write\` — tight Overview + Stack + Autonomy.
2. \`team_create_agent\` for each approved role. Pass
   \`default_model: "anthropic/claude-sonnet-4-6"\` unless the human
   asked otherwise.
3. \`project_columns_update\` — auto-apply the defaults (backlog →
   in_progress → review → done, plus blocked as off_flow). Don't ask.
4. \`project_templates_update\` — Feature, Bug, Chore. Don't ask.

One line to the human when done: "Board set. Tweak columns or templates
in Settings if your flow differs."

**Agents MUST be created before columns.** Columns reference agents by
slug in \`default_assignee_id\` (e.g. \`review → "qa"\`). If the column
lands before the agent exists, the slug stores unresolved and the gate
silently never fires.

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

  return { pmAgent: pm }
}

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
