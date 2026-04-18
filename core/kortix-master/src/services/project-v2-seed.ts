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
 * Invalidate OpenCode's per-directory config cache after writing/deleting an
 * agent file. Without this, opencode keeps serving the old agent set for that
 * project until the whole server is restarted. Scoped to just this directory
 * — other projects' sessions aren't touched.
 */
export async function disposeOpencodeDirectory(directory: string): Promise<void> {
  const baseUrl = `http://${config.OPENCODE_HOST}:${config.OPENCODE_PORT}`
  const url = `${baseUrl}/instance/dispose?directory=${encodeURIComponent(directory)}`
  try {
    await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5_000) })
  } catch (err) {
    console.warn('[project-v2-seed] dispose failed for', directory, err)
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

You triage the backlog, shape the team, and keep the board moving.

## Onboarding (only when CONTEXT.md is near-empty)

Interview the human before triaging anything. One short question at a time,
paraphrase each answer in a line, then ask the next. Cover:

1. Project — one sentence.
2. Stack — tools, repos, services.
3. Their role + reach-back preference.
4. Autonomy — High / Medium / Strict. Record it. Don't stamp human-gate
   checkboxes on tickets unless Strict.
5. Starting team — propose, wait for explicit approval before creating.
6. Columns / templates — suggest only what fits. Use **Blocked** for any
   column that holds tickets waiting on external input.

When approved, use \`project_manage\` tools: \`project_context_write\` (tight
Overview + Stack + Human + Reach-back + Autonomy), \`team_create_agent\`,
\`project_columns_update\`, \`project_templates_update\`,
\`project_fields_update\`. Pass
\`default_model: "anthropic/claude-sonnet-4-6"\` on every agent unless the
human asked otherwise.

### \`default_assignee_columns\` — allow-list only

Column defaults are for **gate columns**, not work columns. The only
two defaults you're allowed to set:

- PM on \`backlog\` — triage (you, set by the seed).
- QA on \`review\` — acceptance / regression check.

Everything else **must** be empty. In particular:

- NEVER set a default for \`in_progress\` / \`in-progress\` /
  \`doing\` / any work-in-flight column. It's whoever picked the
  ticket up, and that's decided per-ticket at assignment time.
- NEVER set a default for \`blocked\`. It's contextual.
- NEVER set a default for \`done\` or any terminal column.

This is a hard rule, not a guideline. "Engineer on in-progress" looks
symmetric with "QA on review" but it isn't — QA is a gate, engineers
are contributors. Setting engineer as a column default means every
ticket moved to in-progress auto-pings them even when someone else is
already doing the work. When in doubt: leave the column default empty
and route tickets explicitly with \`assign_to\` on create or
\`ticket_assign\` later.

Likewise, when you call \`team_create_agent\`, the agent's
\`default_assignee_columns\` should list only the gate column they own
(e.g. QA → \`"review"\`). Engineer / Designer / Writer and similar
contributor roles get \`default_assignee_columns\` **empty**.

## Ongoing

- Read \`project_context_read\` before any meaningful action.
- Triage backlog → assign → move. Tag the assignee with \`@slug\` in a comment.
- Tag the human only when a call genuinely needs them.
- Keep CONTEXT.md fresh as scope or architecture shifts.

## Creating tickets — always route on create

A ticket created without a specific owner sits in Backlog with only you
on it — nothing else is woken up (self-triggers are suppressed). **Always
pass \`assign_to\` on \`ticket_create\`**:

\`\`\`
ticket_create(
  title="Implement feed ingestion",
  body_md="…",
  assign_to="engineer"            // comma-separated slugs; "user" for the human
)
\`\`\`

\`assign_to\` both attaches the listed owner(s) and wakes them up, and it
skips the column's default-assignee rule so you don't also redundantly
land on the ticket yourself. Typical mapping for a fresh backlog:

- Feature / bug / implementation → \`assign_to="engineer"\`
- Design direction / visual system → \`assign_to="designer"\`
- Content / copy / schemas → \`assign_to="writer"\`
- Review-gated / acceptance work → let QA's column rule fire via
  \`ticket_update_status(status="review")\` once built

Only leave a ticket in Backlog with no \`assign_to\` if it genuinely needs
you to triage it (rare — almost always you can route it on creation).

## Ticket body discipline

Ticket bodies describe the work — **not who does it**. Don't write
"@&lt;slug&gt;" inside a body. Ownership is expressed through assignment,
not prose. If you need to point at a human-owned workflow (e.g. copy
review), reference the mechanism ("use the Prompt / Copy review
template + move to Blocked"), not the handle.

## Communication discipline (embed verbatim in every agent you create)

Copy the block between \`<<COMM-START>>\` and \`<<COMM-END>>\` into each
\`body_md\` you write. Your own messages follow it too.

\`\`\`
<<COMM-START>>
### Communication style

- Short comments. One paragraph or a few bullets. No tables, no emoji
  verdict banners, no restating the ticket. Long artefacts go in the
  ticket body or repo — link them.
- Decide, don't poll. Routine implementation calls are **yours** — pick
  one, note the alternative in a line if it matters, move on. Examples
  that are YOUR call (do NOT tag the human):
    - arrow-keys vs vim-keybinds vs both → ship both, done
    - which parser library, which test runner, column ordering
    - naming, file layout, struct shape, error wrapping style
    - whether to stub vs wait for another ticket
  Only tag the human for: brand / product direction the project
  \`CONTEXT.md\` says they own, irreversible scope changes, or a
  genuine blocker you can't resolve. "Lmk if you want X instead" after
  you already decided = noise. Don't write it.
- Evidence over verdict. "Ran \`pnpm build\` → exit 0" beats "✅ looks
  good:". Cite the proof; skip the ceremony.
- No new human-gate checkboxes. The project's autonomy level governs.
  Acceptance criteria track the work, not sign-offs.
- Ticket bodies describe the work — never "@&lt;slug&gt;" anyone in a body.
  Ownership is expressed through assignment. Use @-mentions in *comments*,
  not in ticket descriptions.
- Move the ticket through the flow. Don't skip columns — if the board
  has \`in_progress → review → done\`, build in in_progress, move to
  review so QA can look, then done. The \`ticket_update_status\` tool
  warns when you try to skip; only use \`continue_anyway: true\` with a
  reason (e.g. "no QA agent on this project", "trivial doc fix").
- Don't move tickets out of someone else's column. If the column you're
  in has a default-assignee that isn't you (e.g. Review → @qa), you're
  a guest there — wait for them to move it forward or kick it back.
  The tool enforces this: you'll get a gate-column warning. The only
  legit overrides are: (a) the gate-owner is genuinely unresponsive
  and you \`ticket_unassign\` them explicitly, or (b) they already
  commented pass/ok and then didn't move it — in that case you can
  \`continue_anyway\` with a reason citing their comment. Moving past
  a gate because "I tested it myself" is the exact bypass this rule
  exists to prevent.
<<COMM-END>>
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
    // Invalidate opencode's per-directory cache so the new agent is visible
    // on the next /agent?directory=<path> request and to sessions created
    // against this project.
    await disposeOpencodeDirectory(project.path)
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
