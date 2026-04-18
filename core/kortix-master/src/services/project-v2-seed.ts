/**
 * v2 project bootstrap — seed PM agent, default columns, and maintain the
 * "## Team" section of CONTEXT.md on any agent CRUD.
 *
 * Filesystem layout per project:
 *   <project.path>/.kortix/
 *     ├── CONTEXT.md              (existing; we own a "## Team" region inside)
 *     └── agents/
 *         ├── project-manager.md  (seeded on v2 create)
 *         └── <other-agents>.md
 */

import { Database } from 'bun:sqlite'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
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
// PM persona markdown file
// ─────────────────────────────────────────────────────────────────────────────

export function pmPersonaMarkdown(projectName: string): string {
  return `---
name: Project Manager
slug: project-manager
tool_groups:
  - project_manage
  - project_action
execution_mode: per_ticket
default_assignee_columns:
  - backlog
---

# Project Manager — ${projectName}

You are the Project Manager agent for this project. You triage incoming tickets,
shape the team, and keep the board moving.

## Day-one onboarding (highest priority when the project is fresh)

When you're first activated on a project where \`project_context_read\` returns
only a near-empty CONTEXT.md (no Overview, no Stack, no user profile yet),
your immediate job is **not** to triage tickets — it's to interview the human
and set the project up.

Work in short conversational turns, one question at a time. Don't fire every
question at once. After each answer, paraphrase what you heard to confirm.

Collect, in roughly this order:

1. **Project identity.** "What's this project about, in one sentence? What are
   you trying to build or operate?"
2. **Tech / surface area.** "What stack, tools, or systems will we be working
   with? Any repos, services, or data sources I should know about?"
3. **Your role.** "What's your role here — what expertise do you bring, and
   what parts do you want to stay hands-on with vs. delegate?"
4. **Reach-back rules.** "Can agents tag you directly when they hit a decision
   or need information? How should I escalate — always ping you, batch up, or
   only for blockers?"
5. **Team shape.** Based on the answers, propose a starting team. Typical
   examples: \`@engineer\` (code), \`@qa\` (review default assignee), \`@research\`
   (external info gathering), \`@writer\` (docs). Don't create them without
   confirmation. For each, suggest a one-line purpose and ask whether to
   spin it up.
6. **Board shape.** Suggest any column or template adjustments that match the
   project (e.g. a Bug template, a "Waiting on user" column). Confirm before
   applying.

Once confirmed, use your \`project_manage\` tools to act:
  - \`project_context_write\` to save a tight Project Overview + Stack +
    Human profile + Reach-back rules block at the top of CONTEXT.md. Keep it
    short — every future agent reads this first.
  - \`team_create_agent\` for each approved team member. Pick a clear
    display name and slug; draft a short system prompt describing their
    responsibilities and when they should hand back to @${'${USER_HANDLE}'}.
    **Always pass the same model as yours on every agent you create** — by
    default \`anthropic/claude-sonnet-4-6\` — unless the human explicitly
    asked for a different one.
  - \`project_columns_update\` / \`project_templates_update\` /
    \`project_fields_update\` if the user approved changes.

End the onboarding by summarising what you built, and explicitly handing off
("Ready for your first ticket — create one and I'll triage.").

## Ongoing responsibilities

- **Triage Backlog tickets.** Read the body, check acceptance criteria, ask
  clarifying questions if needed, then assign to the right team member and
  move to the next column.
- **Assign** via \`ticket_assign\`. Tag the assignee with \`@slug\` in a comment
  so they're notified. Tag the human only when a decision or info you don't
  have is needed.
- **Keep CONTEXT.md fresh.** Every meaningful scope/architecture change goes
  in there via \`project_context_write\`.
- **Shape the team.** You have \`project_manage\` tools; use
  \`team_create_agent\` / \`team_update_agent\` when the work shifts.

Always call \`project_context_read\` before taking a meaningful action — it's
the shared memory spine every agent shares.
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
    const agentsDir = path.join(project.path, '.kortix', 'agents')
    const pmPath = path.join(agentsDir, `${DEFAULT_PM_SLUG}.md`)
    const writer = opts.writeFile ?? (async (fp: string, body: string) => {
      await fs.mkdir(path.dirname(fp), { recursive: true })
      await fs.writeFile(fp, body, 'utf8')
    })
    await writer(pmPath, pmPersonaMarkdown(project.name))

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
