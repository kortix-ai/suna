/**
 * Ticket tool bundles for OpenCode agents.
 *
 * Two groups, chosen per-agent via project_agents.tool_groups_json:
 *   - project_action   — ticket work (read/create/update/status/assign/comment),
 *                        plus team_list and project_context_read.
 *   - project_manage   — everything above, plus: team CRUD, columns/fields/
 *                        templates editing, project_context_write.
 *
 * Enforcement runs in a tool.execute.before hook that looks up the session's
 * bound agent (via ticket_agent_sessions or project_agents.session_id) and
 * rejects calls to tools outside the agent's tool_groups.
 *
 * When a column rule fires an auto-assignment or a comment @-mentions an
 * agent, fireAgentTrigger spawns or reuses a session per the agent's
 * execution_mode.
 */

import { Database } from 'bun:sqlite'
import { tool, type ToolContext } from '@opencode-ai/plugin'
import type { ProjectManager } from './projects'
import {
  addAssignee,
  addComment,
  createTicket,
  ensureTicketTables,
  getAgentById,
  getAgentBySlug,
  getTicket,
  insertAgent,
  isAgentAssignedTo,
  listAgents,
  listColumns,
  listTickets,
  listTicketEvents,
  removeAssignee,
  replaceColumns,
  replaceFields,
  replaceTemplates,
  updateAgent as svcUpdateAgent,
  updateTicket,
  updateTicketStatus,
  type ActorType,
  type AssigneeType,
  type ExecutionMode,
  type ProjectAgentRow,
  type ToolGroup,
} from '../../../src/services/ticket-service'
import {
  syncTeamSection,
  tryReadContext,
  writeContextPreservingTeam,
  renderAgentFile,
  agentFilePath,
  fireOpencodeDispose,
  type AgentFileMeta,
} from '../../../src/services/project-v2-seed'
import {
  fireAgentTrigger as svcFireAgentTrigger,
  fireAgentTriggers as svcFireAgentTriggers,
} from '../../../src/services/ticket-triggers'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Agent cache refresh — debounced per-directory
// ─────────────────────────────────────────────────────────────────────────────
// After writing an agent file (team_create_agent / team_update_agent) opencode
// still has its per-directory agent list cached, so dispatching to the new
// slug silently no-ops and the agent never wakes. We have to invalidate via
// POST /instance/dispose — but doing so while a session is generating kills
// the turn (the PM is usually in one). Debounce: each call resets a 1.5s
// timer; when the timer fires we assume the directory is quiet and dispose.
// Good enough for the common pattern (several team_create_agent + tickets in
// one PM turn — the PM's turn ends, then the timer fires just after).
const pendingDisposes = new Map<string, ReturnType<typeof setTimeout>>()
const DISPOSE_DEBOUNCE_MS = 1500
function scheduleAgentRefresh(directory: string) {
  const existing = pendingDisposes.get(directory)
  if (existing) clearTimeout(existing)
  const handle = setTimeout(() => {
    pendingDisposes.delete(directory)
    fireOpencodeDispose(directory).catch((err) => {
      console.warn('[ticket-tools] scheduled dispose failed for', directory, err)
    })
  }, DISPOSE_DEBOUNCE_MS)
  pendingDisposes.set(directory, handle)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool → required group mapping
// ─────────────────────────────────────────────────────────────────────────────

export const TOOL_GROUPS: Record<string, ToolGroup> = {
  // project_action — contributors (engineer, qa, designer, writer) + PM
  ticket_list: 'project_action',
  ticket_get: 'project_action',
  // ticket_create is project_action at the hook layer, but the tool body
  // enforces a finer rule: contributors can only create SUB-tickets (via
  // parent_id) of tickets they're already assigned to. Top-level tickets
  // (no parent_id) still require project_manage.
  ticket_create: 'project_action',
  ticket_update: 'project_action',
  ticket_update_status: 'project_action',
  ticket_assign: 'project_action',
  ticket_unassign: 'project_action',
  ticket_comment: 'project_action',
  ticket_events: 'project_action',
  team_list: 'project_action',
  project_context_read: 'project_action',
  // project_manage — PM only (and anyone PM explicitly gives this group to)
  team_create_agent: 'project_manage',
  team_update_agent: 'project_manage',
  team_delete_agent: 'project_manage',
  project_columns_update: 'project_manage',
  project_fields_update: 'project_manage',
  project_templates_update: 'project_manage',
  project_context_write: 'project_manage',
}

// ─────────────────────────────────────────────────────────────────────────────
// Session → Agent resolution
// ─────────────────────────────────────────────────────────────────────────────

export function findAgentForSession(db: Database, sessionId: string): ProjectAgentRow | null {
  const bound = db.prepare('SELECT agent_id FROM ticket_agent_sessions WHERE session_id=$sid').get({ $sid: sessionId }) as { agent_id: string } | null
  if (bound) return getAgentById(db, bound.agent_id)
  const persistent = db.prepare('SELECT id FROM project_agents WHERE session_id=$sid').get({ $sid: sessionId }) as { id: string } | null
  if (persistent) return getAgentById(db, persistent.id)
  return null
}

export function agentHasGroup(agent: ProjectAgentRow | null, group: ToolGroup): boolean {
  if (!agent) return true // non-agent sessions (user/interactive) can use everything
  try {
    const groups = JSON.parse(agent.tool_groups_json || '[]') as string[]
    return groups.includes(group)
  } catch {
    return false
  }
}

function getProjectIdForCtx(mgr: ProjectManager, ctx: ToolContext): string | null {
  if (!ctx?.sessionID) return null
  return mgr.getSessionProject(ctx.sessionID)?.id || null
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution / triggers — delegate to ticket-triggers service for shared logic
// ─────────────────────────────────────────────────────────────────────────────

function pluginFireAgentTriggers(
  db: Database,
  mgr: ProjectManager,
  client: any,
  projectId: string,
  ticketId: string,
  triggered: Array<{ agent_id: string; agent_slug: string; reason: string }>,
  actor?: { type: ActorType; id?: string | null },
): Promise<void> {
  return svcFireAgentTriggers({
    db,
    client,
    projectId,
    ticketId,
    triggered,
    actor,
    bindSessionToProject: (sessionId, pid) => mgr.setSessionProject(sessionId, pid),
  })
}

async function pluginFireAgentTrigger(
  db: Database,
  mgr: ProjectManager,
  client: any,
  projectId: string,
  ticketId: string,
  agent: ProjectAgentRow,
  reason: string,
): Promise<string | null> {
  return svcFireAgentTrigger({
    db, client, projectId, ticketId, agent, reason,
    bindSessionToProject: (sessionId, pid) => mgr.setSessionProject(sessionId, pid),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

export function ticketTools(db: Database, mgr: ProjectManager, client: any) {
  const actorFromCtx = (ctx: ToolContext): { type: ActorType; id: string | null } => {
    const agent = findAgentForSession(db, ctx.sessionID)
    if (agent) return { type: 'agent', id: agent.id }
    return { type: 'user', id: null }
  }

  return {
    // ── project_action: read/write tickets ─────────────────────────────────

    ticket_list: tool({
      description: 'List tickets in the current project, optionally filtered by status (column key).',
      args: {
        status: tool.schema.string().optional().describe('Column key filter — e.g. "backlog", "in_progress", "review", "done".'),
      },
      async execute(args: { status?: string }, ctx: ToolContext): Promise<string> {
        const pid = getProjectIdForCtx(mgr, ctx)
        if (!pid) return 'Error: no project selected.'
        const rows = listTickets(db, { projectId: pid, status: args.status })
        if (!rows.length) return args.status ? `No tickets in column "${args.status}".` : 'No tickets in this project.'
        return rows.map((t) => {
          const assignees = t.assignees.length
            ? ` — assignees: ${t.assignees.map((a) => `${a.assignee_type}:${a.assignee_id}`).join(', ')}`
            : ''
          return `#${t.number} [${t.status}] ${t.title} (${t.id})${assignees}`
        }).join('\n')
      },
    }),

    ticket_get: tool({
      description: 'Get full ticket detail including body, status, custom fields, and assignees.',
      args: { id: tool.schema.string().describe('Ticket id (tk-…) or #number') },
      async execute(args: { id: string }, ctx: ToolContext): Promise<string> {
        const pid = getProjectIdForCtx(mgr, ctx)
        if (!pid) return 'Error: no project selected.'
        let t = getTicket(db, args.id)
        if (!t && /^#?\d+$/.test(args.id)) {
          const n = Number(args.id.replace('#', ''))
          const row = db.prepare('SELECT id FROM tickets WHERE project_id=$pid AND number=$n').get({ $pid: pid, $n: n }) as { id: string } | null
          if (row) t = getTicket(db, row.id)
        }
        if (!t) return `Ticket not found: ${args.id}`
        const fields = JSON.parse(t.custom_fields_json || '{}')
        return [
          `## #${t.number} — ${t.title}`,
          '',
          `**ID:** ${t.id}`,
          `**Status:** ${t.status}`,
          `**Assignees:** ${t.assignees.length ? t.assignees.map((a) => `${a.assignee_type}:${a.assignee_id}`).join(', ') : '—'}`,
          Object.keys(fields).length ? `**Fields:** ${JSON.stringify(fields)}` : null,
          '',
          t.body_md || '(no body)',
        ].filter(Boolean).join('\n')
      },
    }),

    ticket_events: tool({
      description: 'List the activity log (comments, status changes, assignments, etc.) for a ticket.',
      args: { id: tool.schema.string().describe('Ticket id') },
      async execute(args: { id: string }, ctx: ToolContext): Promise<string> {
        if (!getProjectIdForCtx(mgr, ctx)) return 'Error: no project selected.'
        const events = listTicketEvents(db, args.id)
        if (!events.length) return 'No events.'
        return events.map((e) => `[${e.created_at}] ${e.actor_type}${e.actor_id ? `:${e.actor_id}` : ''} · ${e.type}${e.message ? ` — ${e.message}` : ''}`).join('\n')
      },
    }),

    ticket_create: tool({
      description: [
        'Create a ticket. Two modes:',
        '  (1) Top-level (no parent_id) — PM-only. Requires project_manage group.',
        '  (2) Sub-ticket (parent_id set) — any contributor assigned to the parent can use this to decompose work. Tech Lead does this for goal tickets; engineer/QA can file sub-work items against tickets they own.',
        'Always pass `assign_to` on create to route the ticket and wake the owner (omitting it leaves the ticket attached only to you).',
      ].join(' '),
      args: {
        title: tool.schema.string().describe('Short ticket title'),
        body_md: tool.schema.string().optional().describe('Markdown body — Goal + `- [ ]` AC checkboxes. No @-tags inside bodies.'),
        status: tool.schema.string().optional().describe('Column key — defaults to first column (e.g. "backlog")'),
        template_id: tool.schema.string().optional(),
        assign_to: tool.schema.string().optional().describe('Comma-separated assignees (slugs). "user" for the human. Skips the column default-assignee when set.'),
        parent_id: tool.schema.string().optional().describe('Parent ticket id (tk-… or #number) to make this a sub-ticket. Required for contributors (non-PM). PM can also use it for explicit parent-child links.'),
      },
      async execute(args: { title: string; body_md?: string; status?: string; template_id?: string; assign_to?: string; parent_id?: string }, ctx: ToolContext): Promise<string> {
        const pid = getProjectIdForCtx(mgr, ctx)
        if (!pid) return 'Error: no project selected.'
        const actor = actorFromCtx(ctx)

        // Resolve parent_id — accept #number or tk-… id.
        let parentTicketId: string | null = null
        if (args.parent_id) {
          let resolved = getTicket(db, args.parent_id)
          if (!resolved && /^#?\d+$/.test(args.parent_id)) {
            const n = Number(args.parent_id.replace('#', ''))
            const row = db.prepare('SELECT id FROM tickets WHERE project_id=$pid AND number=$n').get({ $pid: pid, $n: n }) as { id: string } | null
            if (row) resolved = getTicket(db, row.id)
          }
          if (!resolved) return `Parent ticket not found: ${args.parent_id}`
          if (resolved.project_id !== pid) return `Parent ticket belongs to a different project.`
          parentTicketId = resolved.id
        }

        // Fine-grained permission. Agent sessions only — user/interactive bypass.
        if (actor.type === 'agent' && actor.id) {
          const agent = getAgentById(db, actor.id)
          const groups = agent ? JSON.parse(agent.tool_groups_json || '[]') as string[] : []
          const isPM = groups.includes('project_manage')
          if (!isPM) {
            // Contributor — must pass parent_id AND be assigned to that parent.
            if (!parentTicketId) {
              return `Permission denied: top-level tickets require the project_manage tool group (PM only). If you need sub-work on a ticket you own, pass parent_id=<that ticket>. If a new top-level ticket is genuinely needed, comment + tag @pm.`
            }
            if (!isAgentAssignedTo(db, parentTicketId, actor.id)) {
              const parent = getTicket(db, parentTicketId)
              return `Permission denied: you can only create sub-tickets of tickets you're assigned to. You are not on #${parent?.number} (${parentTicketId}).`
            }
          }
        }

        // Resolve assign_to slugs to typed assignees.
        const parsed: Array<{ type: AssigneeType; id: string }> = []
        if (args.assign_to) {
          const proj = db.prepare('SELECT user_handle FROM projects WHERE id=$id').get({ $id: pid }) as { user_handle?: string | null } | null
          for (const raw of args.assign_to.split(',').map((s) => s.trim()).filter(Boolean)) {
            if (raw === 'user' || (proj?.user_handle && raw === proj.user_handle)) {
              parsed.push({ type: 'user', id: proj?.user_handle || 'user' })
              continue
            }
            const ag = getAgentBySlug(db, pid, raw) || getAgentById(db, raw)
            if (ag) parsed.push({ type: 'agent', id: ag.id })
          }
        }
        const result = createTicket(db, {
          project_id: pid,
          title: args.title,
          body_md: args.body_md,
          status: args.status,
          template_id: args.template_id ?? null,
          created_by_type: actor.type,
          created_by_id: actor.id,
          assign_to: parsed.length ? parsed : undefined,
          parent_id: parentTicketId,
        })
        await pluginFireAgentTriggers(db, mgr, client, pid, result.ticket.id,
          result.triggered.map((t) => ({ ...t, reason: `You were assigned to ticket #${result.ticket.number} on creation.` })),
          actor)
        const routed = parsed.length
          ? ` routed to ${parsed.map((p) => p.type === 'agent' ? '@' + (getAgentById(db, p.id)?.slug ?? p.id) : '@' + p.id).join(', ')}`
          : ''
        const parentRef = parentTicketId
          ? ` (sub of #${getTicket(db, parentTicketId)?.number})`
          : ''
        return `Created ticket **#${result.ticket.number}** (${result.ticket.id})${parentRef} in ${result.ticket.status}${routed}.`
      },
    }),

    ticket_update: tool({
      description: 'Update a ticket\'s title, body, template, or custom fields. Use ticket_update_status to change column.',
      args: {
        id: tool.schema.string(),
        title: tool.schema.string().optional(),
        body_md: tool.schema.string().optional(),
        template_id: tool.schema.string().optional(),
        custom_fields_json: tool.schema.string().optional().describe('JSON object of custom field values to merge in.'),
      },
      async execute(args, ctx): Promise<string> {
        if (!getProjectIdForCtx(mgr, ctx)) return 'Error: no project selected.'
        const actor = actorFromCtx(ctx)
        let custom_fields: Record<string, unknown> | undefined
        if (args.custom_fields_json) {
          try { custom_fields = JSON.parse(args.custom_fields_json) } catch { return 'Error: custom_fields_json is not valid JSON.' }
        }
        const r = updateTicket(db, args.id, {
          title: args.title, body_md: args.body_md, template_id: args.template_id ?? undefined, custom_fields,
        }, actor)
        return r ? `Updated ticket ${r.id}.` : `Ticket not found: ${args.id}`
      },
    }),

    ticket_update_status: tool({
      description: [
        'Change a ticket\'s column. Status is a free string matching a project column key.',
        'Flow: move one column forward when your piece is done, or back if rework is needed.',
        'Skipping columns (e.g. in_progress → done past review) is blocked by default —',
        'the tool will return a warning naming the columns you\'d bypass. If the skip is',
        'intentional (no QA on this project, trivial doc fix, etc.) re-call with',
        'continue_anyway: true and a reason.',
        'If the destination column has a default assignee (e.g. QA on review), they\'re',
        'auto-assigned and notified. Your own assignment is NOT auto-cleared by a move —',
        'unassign yourself explicitly if you\'re handing off.',
      ].join(' '),
      args: {
        id: tool.schema.string(),
        status: tool.schema.string().describe('Destination column key (e.g. "review")'),
        continue_anyway: tool.schema.boolean().optional().describe('Set true to bypass the skip-column warning when intentionally jumping past intermediate columns.'),
        reason: tool.schema.string().optional().describe('Short justification when continue_anyway is true (e.g. "no QA agent", "trivial typo fix"). Recorded in the comment trail.'),
      },
      async execute(args, ctx): Promise<string> {
        const pid = getProjectIdForCtx(mgr, ctx)
        if (!pid) return 'Error: no project selected.'
        const actor = actorFromCtx(ctx)

        const t = getTicket(db, args.id)
        if (!t) return `Ticket not found: ${args.id}`
        const allCols = listColumns(db, pid)
        // On-flow columns drive the linear sequence; off-flow (e.g. "blocked")
        // are side-channels reachable from any on-flow column. The skip-column
        // guard indexes on-flow only so moves through blocked don't look like
        // they're jumping past real gates, and the gate-column guard ignores
        // off-flow source columns (nobody owns blocked the way QA owns review).
        const flowCols = allCols.filter((c) => !c.is_off_flow)
        const srcCol = allCols.find((c) => c.key === t.status) ?? null
        const dstCol = allCols.find((c) => c.key === args.status) ?? null
        if (!dstCol) {
          return `Unknown status "${args.status}". Available: ${allCols.map((c) => c.key).join(', ')}.`
        }

        const srcFlowIdx = srcCol && !srcCol.is_off_flow ? flowCols.findIndex((c) => c.key === srcCol.key) : -1
        const dstFlowIdx = !dstCol.is_off_flow ? flowCols.findIndex((c) => c.key === dstCol.key) : -1

        // Terminal-column guard — tickets in done (or any terminal column) are
        // closed. Refuse to move them OUT unless the caller explicitly passes
        // continue_anyway: true with a reason that signals intentional
        // reopening. This catches agents that try to "resurrect" closed or
        // cancelled tickets (observed: engineer sessions moving PM-cancelled
        // duplicates from done → review, confusing the board).
        if (srcCol?.is_terminal && !args.continue_anyway) {
          return [
            `Terminal-column guard: "${t.status}" is a terminal column — this ticket is closed.`,
            `Moving it out resurrects it. If the ticket genuinely needs reopening, that's PM's call — comment and tag @pm with what needs changing.`,
            `If you ARE PM and are intentionally reopening, re-call ticket_update_status with continue_anyway: true and a reason starting with "Reopening:".`,
          ].join(' ')
        }

        // Skip-column guard — only meaningful when both source and destination
        // are on-flow. Moving INTO or OUT OF an off-flow column never trips it.
        if (srcFlowIdx !== -1 && dstFlowIdx !== -1 && dstFlowIdx > srcFlowIdx + 1 && !args.continue_anyway) {
          const skipped = flowCols.slice(srcFlowIdx + 1, dstFlowIdx).map((c) => `"${c.key}"`).join(', ')
          return [
            `Skip-column warning: moving from "${t.status}" → "${args.status}" bypasses ${skipped}.`,
            `The flow expects one column at a time (e.g. in_progress → review → done) so the owner of each column can do their pass.`,
            `If this is intentional, re-call ticket_update_status with continue_anyway: true and a short reason.`,
          ].join(' ')
        }

        // Gate-column guard — refuse to move a ticket OUT of a column whose
        // default assignee is a DIFFERENT agent who is still assigned. That's
        // their column; only they should move it forward. Engineer moving out
        // of "review" while @qa is still assigned = bypassing the QA gate.
        // Backward moves are always fine (handing back for rework). Source
        // must be on-flow — off-flow columns (blocked) have no owner.
        if (srcCol && !srcCol.is_off_flow && srcFlowIdx !== -1 && dstFlowIdx > srcFlowIdx && actor.type === 'agent' && actor.id) {
          if (srcCol.default_assignee_type === 'agent' && srcCol.default_assignee_id && srcCol.default_assignee_id !== actor.id) {
            const gateAgent = getAgentById(db, srcCol.default_assignee_id)
            if (gateAgent) {
              const stillAssigned = db.prepare(
                `SELECT 1 FROM ticket_assignees WHERE ticket_id=$tid AND assignee_type='agent' AND assignee_id=$aid`
              ).get({ $tid: args.id, $aid: gateAgent.id })
              if (stillAssigned && !args.continue_anyway) {
                return [
                  `Gate-column guard: "${t.status}" belongs to @${gateAgent.slug} (default assignee) and they are still on the ticket.`,
                  `Let @${gateAgent.slug} move it forward themselves — that's the whole point of the gate.`,
                  `If @${gateAgent.slug} is unresponsive or you're confident they're done, either (a) unassign them explicitly with ticket_unassign, or`,
                  `(b) re-call ticket_update_status with continue_anyway: true and a reason naming why you're moving past them.`,
                ].join(' ')
              }
            }
          }
        }

        try {
          const r = updateTicketStatus(db, {
            ticketId: args.id, toStatus: args.status, actor_type: actor.type, actor_id: actor.id,
          })
          if (!r) return `Ticket not found: ${args.id}`
          // Record the reason as a comment when the skip was overridden so the
          // trail captures why a column was bypassed.
          if (args.continue_anyway && srcFlowIdx !== -1 && dstFlowIdx > srcFlowIdx + 1 && args.reason) {
            const skipped = flowCols.slice(srcFlowIdx + 1, dstFlowIdx).map((c) => c.key).join(', ')
            addComment(db, {
              ticketId: args.id,
              body: `_Skipped ${skipped} intentionally: ${args.reason}_`,
              actor_type: actor.type,
              actor_id: actor.id,
            })
          }
          await pluginFireAgentTriggers(db, mgr, client, pid, args.id,
            r.triggered.map((t) => ({ ...t, reason: `Ticket moved to "${args.status}" — you are the default assignee for this column.` })),
            actor)
          return `Ticket moved to "${args.status}".`
        } catch (err) {
          return `Failed: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    }),

    ticket_assign: tool({
      description: 'Assign a ticket to an agent (by slug) or the user.',
      args: {
        id: tool.schema.string(),
        assignee_type: tool.schema.string().describe('"agent" or "user"'),
        assignee_id: tool.schema.string().describe('Agent slug, user id, or "user" for the real human.'),
      },
      async execute(args, ctx): Promise<string> {
        const pid = getProjectIdForCtx(mgr, ctx)
        if (!pid) return 'Error: no project selected.'
        const actor = actorFromCtx(ctx)
        let resolvedId = args.assignee_id
        if (args.assignee_type === 'agent') {
          const ag = getAgentBySlug(db, pid, args.assignee_id) || getAgentById(db, args.assignee_id)
          if (!ag) return `Agent not found: ${args.assignee_id}`
          resolvedId = ag.id
        }
        const r = addAssignee(db, {
          ticketId: args.id,
          assignee_type: args.assignee_type as AssigneeType,
          assignee_id: resolvedId,
          actor_type: actor.type,
          actor_id: actor.id,
        })
        if (!r.added) return 'Already assigned.'
        if (args.assignee_type === 'agent') {
          const ag = getAgentById(db, resolvedId)
          if (ag && (actor.type !== 'agent' || actor.id !== ag.id)) {
            await pluginFireAgentTrigger(db, mgr, client, pid, args.id, ag,
              'You were assigned to this ticket.')
          }
        }
        return `Assigned ${args.assignee_type}:${resolvedId} to ticket ${args.id}.`
      },
    }),

    ticket_unassign: tool({
      description: 'Remove an assignee from a ticket.',
      args: {
        id: tool.schema.string(),
        assignee_type: tool.schema.string().describe('"agent" or "user"'),
        assignee_id: tool.schema.string().describe('Agent slug or user id'),
      },
      async execute(args, ctx): Promise<string> {
        const pid = getProjectIdForCtx(mgr, ctx)
        if (!pid) return 'Error: no project selected.'
        const actor = actorFromCtx(ctx)
        let resolvedId = args.assignee_id
        if (args.assignee_type === 'agent') {
          const ag = getAgentBySlug(db, pid, args.assignee_id) || getAgentById(db, args.assignee_id)
          if (ag) resolvedId = ag.id
        }
        const r = removeAssignee(db, {
          ticketId: args.id,
          assignee_type: args.assignee_type as AssigneeType,
          assignee_id: resolvedId,
          actor_type: actor.type,
          actor_id: actor.id,
        })
        return r.removed ? 'Unassigned.' : 'Was not assigned.'
      },
    }),

    ticket_comment: tool({
      description: 'Post a comment on a ticket. Use @slug to mention a team agent — they\'ll be auto-notified.',
      args: {
        id: tool.schema.string(),
        body: tool.schema.string().describe('Markdown body. Reference agents as @slug.'),
      },
      async execute(args, ctx): Promise<string> {
        const pid = getProjectIdForCtx(mgr, ctx)
        if (!pid) return 'Error: no project selected.'
        const actor = actorFromCtx(ctx)
        const r = addComment(db, {
          ticketId: args.id, body: args.body, actor_type: actor.type, actor_id: actor.id,
        })
        await pluginFireAgentTriggers(db, mgr, client, pid, args.id,
          r.triggered.map((t) => ({ ...t, reason: 'You were @-mentioned in a comment.' })),
          actor)
        return r.mentions.length
          ? `Comment posted. Notified: ${r.mentions.map((m) => `@${m}`).join(', ')}.`
          : 'Comment posted.'
      },
    }),

    // ── project_action: team + context reads ──────────────────────────────

    team_list: tool({
      description: 'List all team agents in the current project (plus the user role).',
      args: {},
      async execute(_args: unknown, ctx: ToolContext): Promise<string> {
        const pid = getProjectIdForCtx(mgr, ctx)
        if (!pid) return 'Error: no project selected.'
        const agents = listAgents(db, pid)
        const lines = ['- @user — real human. Tag when you need a decision an agent can\'t make.']
        for (const a of agents) {
          const groups = safeParseArray(a.tool_groups_json).join(', ')
          const cols = safeParseArray(a.default_assignee_columns_json)
          lines.push(`- @${a.slug} (${a.name}) — ${groups}${cols.length ? ` · default-assignee: ${cols.join(', ')}` : ''} · ${a.execution_mode}`)
        }
        return lines.join('\n')
      },
    }),

    project_context_read: tool({
      description: 'Read the project CONTEXT.md file.',
      args: {},
      async execute(_args: unknown, ctx: ToolContext): Promise<string> {
        const pid = getProjectIdForCtx(mgr, ctx)
        if (!pid) return 'Error: no project selected.'
        const proj = db.prepare('SELECT path FROM projects WHERE id=$id').get({ $id: pid }) as { path: string } | null
        if (!proj) return 'Error: project not found.'
        const body = await tryReadContext(proj.path)
        return body || '(CONTEXT.md is empty)'
      },
    }),

    // ── project_manage: team CRUD + project config ────────────────────────

    team_create_agent: tool({
      description: [
        'Create a new team agent. Writes .opencode/agent/<slug>.md — this becomes a real',
        'OpenCode agent that the user can select from the agent picker and that the',
        'runtime dispatches to. The markdown body is the agent\'s system prompt; the',
        'YAML frontmatter (name, description, mode, model + kortix metadata) is',
        'generated by this tool, so body_md should be plain prompt text, no ---...---.',
        '',
        'Tool_groups are "project_action" alone (contributor) or both "project_action"',
        'and "project_manage" (orchestrator). Pass default_model to pin the LLM.',
        '',
        'IMPORTANT: body_md MUST embed the Communication discipline block from your',
        'own persona verbatim — short comments, decide-don\'t-poll, evidence-over-',
        'verdict, no new human-gate acceptance items. Agents created without this',
        'block ship verdict-theatre comments and over-gate tickets.',
      ].join(' '),
      args: {
        slug: tool.schema.string().describe('URL-safe short id, e.g. "engineer"'),
        name: tool.schema.string().describe('Display name, e.g. "Engineer"'),
        body_md: tool.schema.string().describe('System prompt markdown — plain text, no YAML frontmatter (this tool owns the frontmatter).'),
        description: tool.schema.string().optional().describe('One-line description shown in the agent picker (e.g. "Engineer — Python implementation + tests").'),
        tool_groups: tool.schema.string().optional().describe('Comma-separated: "project_action" and/or "project_manage". Defaults to project_action.'),
        default_assignee_columns: tool.schema.string().optional().describe('Comma-separated column keys this agent auto-assigns for, e.g. "review".'),
        execution_mode: tool.schema.string().optional().describe('"per_ticket" (default), "per_assignment", or "persistent".'),
        default_model: tool.schema.string().optional().describe('Model id in "providerID/modelID" form, e.g. "anthropic/claude-sonnet-4-6". Defaults to the session default.'),
      },
      async execute(args, ctx): Promise<string> {
        const pid = getProjectIdForCtx(mgr, ctx)
        if (!pid) return 'Error: no project selected.'
        const proj = db.prepare('SELECT id,name,path,description FROM projects WHERE id=$id').get({ $id: pid }) as { id: string; name: string; path: string; description: string } | null
        if (!proj) return 'Error: project not found.'
        if (getAgentBySlug(db, pid, args.slug)) return `Agent with slug "${args.slug}" already exists.`
        const toolGroups = (parseSlugList(args.tool_groups).length ? parseSlugList(args.tool_groups) : ['project_action']) as ToolGroup[]
        const cols = parseSlugList(args.default_assignee_columns)
        const mode = (args.execution_mode as ExecutionMode) || 'per_ticket'
        const filePath = agentFilePath(proj.path, args.slug)
        const meta: AgentFileMeta = {
          slug: args.slug,
          name: args.name,
          description: args.description || `${args.name} — project agent`,
          mode: 'primary',
          model: args.default_model || null,
          tool_groups: toolGroups,
          execution_mode: mode,
          default_assignee_columns: cols,
        }
        await fs.mkdir(path.dirname(filePath), { recursive: true })
        await fs.writeFile(filePath, renderAgentFile(meta, args.body_md), 'utf8')
        const ag = insertAgent(db, pid, {
          slug: args.slug,
          name: args.name,
          file_path: filePath,
          execution_mode: mode,
          tool_groups: toolGroups,
          default_assignee_columns: cols,
          default_model: args.default_model || null,
        })
        await syncTeamSection(db, proj)
        scheduleAgentRefresh(proj.path)
        return `Created agent @${ag.slug} (${ag.id}). File + DB row written. Opencode agent cache refresh scheduled (~${DISPOSE_DEBOUNCE_MS}ms after the last team write) so @${ag.slug} becomes dispatchable.`
      },
    }),

    team_update_agent: tool({
      description: 'Update an existing team agent. Rewrites .opencode/agent/<slug>.md with merged metadata + updated body and invalidates the project\'s opencode cache.',
      args: {
        slug: tool.schema.string(),
        name: tool.schema.string().optional(),
        body_md: tool.schema.string().optional().describe('New system prompt (plain text, no frontmatter).'),
        description: tool.schema.string().optional(),
        tool_groups: tool.schema.string().optional(),
        default_assignee_columns: tool.schema.string().optional(),
        execution_mode: tool.schema.string().optional(),
        default_model: tool.schema.string().optional(),
      },
      async execute(args, ctx): Promise<string> {
        const pid = getProjectIdForCtx(mgr, ctx)
        if (!pid) return 'Error: no project selected.'
        const proj = db.prepare('SELECT id,name,path,description FROM projects WHERE id=$id').get({ $id: pid }) as { id: string; name: string; path: string; description: string } | null
        if (!proj) return 'Error: project not found.'
        const ag = getAgentBySlug(db, pid, args.slug)
        if (!ag) return `Agent not found: ${args.slug}`
        // Parse new values, falling back to existing DB state when omitted.
        const toolGroups = args.tool_groups
          ? parseSlugList(args.tool_groups) as ToolGroup[]
          : (JSON.parse(ag.tool_groups_json || '[]') as ToolGroup[])
        const cols = args.default_assignee_columns !== undefined
          ? parseSlugList(args.default_assignee_columns)
          : (JSON.parse(ag.default_assignee_columns_json || '[]') as string[])
        const mode = (args.execution_mode as ExecutionMode | undefined) ?? ag.execution_mode
        const name = args.name ?? ag.name
        const model = args.default_model ?? ag.default_model ?? null
        // Read current body to preserve when only metadata changed.
        let currentBody = ''
        try { currentBody = await fs.readFile(ag.file_path, 'utf8') } catch {}
        const bodyOnly = (args.body_md ?? currentBody).replace(/^---[\s\S]*?---\s*/m, '')
        const targetPath = agentFilePath(proj.path, ag.slug)
        const meta: AgentFileMeta = {
          slug: ag.slug,
          name,
          description: args.description ?? `${name} — project agent`,
          mode: 'primary',
          model,
          tool_groups: toolGroups,
          execution_mode: mode,
          default_assignee_columns: cols,
        }
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        await fs.writeFile(targetPath, renderAgentFile(meta, bodyOnly), 'utf8')
        // If the agent was stored at the legacy `.kortix/agents/` path, clean
        // up the stale file and point the DB row at the new `.opencode/agent/`
        // location. Old projects get auto-migrated on first update.
        if (ag.file_path && ag.file_path !== targetPath) {
          try { await fs.unlink(ag.file_path) } catch {}
          try { db.prepare('UPDATE project_agents SET file_path=$fp WHERE id=$id').run({ $fp: targetPath, $id: ag.id }) } catch {}
        }
        svcUpdateAgent(db, ag.id, {
          name: args.name,
          execution_mode: args.execution_mode as ExecutionMode | undefined,
          tool_groups: args.tool_groups ? toolGroups : undefined,
          default_assignee_columns: args.default_assignee_columns !== undefined ? cols : undefined,
        })
        if (args.default_model !== undefined) {
          try { db.prepare('UPDATE project_agents SET default_model=$m WHERE id=$id').run({ $m: model, $id: ag.id }) } catch {}
        }
        // The persona body or model changed — mark not-ready so the next
        // dispatch waits for the refresh cycle to pick up the new file.
        try { db.prepare('UPDATE project_agents SET ready_at=NULL WHERE id=$id').run({ $id: ag.id }) } catch {}
        await syncTeamSection(db, proj)
        scheduleAgentRefresh(proj.path)
        return `Updated agent @${args.slug}. File rewritten + opencode agent cache refresh scheduled.`
      },
    }),

    team_delete_agent: tool({
      description: 'Delete a team agent. Removes the markdown file and the registration row. Does not touch existing tickets they were assigned to.',
      args: { slug: tool.schema.string() },
      async execute(args, ctx): Promise<string> {
        const pid = getProjectIdForCtx(mgr, ctx)
        if (!pid) return 'Error: no project selected.'
        const proj = db.prepare('SELECT id,name,path,description FROM projects WHERE id=$id').get({ $id: pid }) as { id: string; name: string; path: string; description: string } | null
        if (!proj) return 'Error: project not found.'
        const ag = getAgentBySlug(db, pid, args.slug)
        if (!ag) return `Agent not found: ${args.slug}`
        // Unlink both the legacy and the new path — whichever exists.
        try { await fs.unlink(ag.file_path) } catch {}
        try { await fs.unlink(agentFilePath(proj.path, ag.slug)) } catch {}
        db.prepare('DELETE FROM project_agents WHERE id=$id').run({ $id: ag.id })
        db.prepare('DELETE FROM ticket_agent_sessions WHERE agent_id=$id').run({ $id: ag.id })
        db.prepare('DELETE FROM pending_agent_triggers WHERE agent_id=$id').run({ $id: ag.id })
        await syncTeamSection(db, proj)
        return `Deleted agent @${args.slug}.`
      },
    }),

    project_columns_update: tool({
      description: [
        'Replace the project\'s column set. Pass JSON array of',
        '{key,label,default_assignee_type?,default_assignee_id?,is_terminal?,is_off_flow?}.',
        'For `default_assignee_id` with type "agent", pass the agent SLUG',
        '(e.g. "qa") — the tool resolves it to the real agent id. Only set',
        'defaults for gate columns (backlog → PM, review → QA). NEVER set a',
        'default for in_progress / doing / work columns — that\'s a persona',
        'rule, not a UX convenience.',
        '',
        'is_off_flow=true marks a column as a side-channel (reachable from',
        'any on-flow column, doesn\'t participate in linear flow). Use it for',
        '"blocked" / "on hold" / similar parking columns. Skip-column and',
        'gate-column guards ignore off-flow columns, so moves through them',
        'don\'t trip false positives.',
      ].join(' '),
      args: { columns_json: tool.schema.string().describe('JSON array of column definitions in display order.') },
      async execute(args, ctx): Promise<string> {
        const pid = getProjectIdForCtx(mgr, ctx)
        if (!pid) return 'Error: no project selected.'
        let cols: any[]
        try { cols = JSON.parse(args.columns_json) } catch { return 'columns_json is not valid JSON.' }
        if (!Array.isArray(cols)) return 'columns_json must be an array.'
        // Resolve agent slugs → real agent ids so column-default triggers
        // actually fire. A column that stores `agent:<slug>` never matches a
        // real agent row, so auto-assign and wake-up silently break.
        for (const col of cols) {
          if (col && col.default_assignee_type === 'agent' && typeof col.default_assignee_id === 'string') {
            const raw = col.default_assignee_id
            if (!raw.startsWith('ag-')) {
              const ag = getAgentBySlug(db, pid, raw) || getAgentById(db, raw)
              if (ag) col.default_assignee_id = ag.id
            }
          }
        }
        replaceColumns(db, pid, cols)
        return `Replaced columns (${cols.length}).`
      },
    }),

    project_fields_update: tool({
      description: 'Replace the project\'s custom-field definitions. Pass JSON array of {key,label,type,options?}.',
      args: { fields_json: tool.schema.string() },
      async execute(args, ctx): Promise<string> {
        const pid = getProjectIdForCtx(mgr, ctx)
        if (!pid) return 'Error: no project selected.'
        let fields: any[]
        try { fields = JSON.parse(args.fields_json) } catch { return 'fields_json is not valid JSON.' }
        if (!Array.isArray(fields)) return 'fields_json must be an array.'
        replaceFields(db, pid, fields)
        return `Replaced fields (${fields.length}).`
      },
    }),

    project_templates_update: tool({
      description: 'Replace the project\'s ticket templates. Pass JSON array of {name,body_md}.',
      args: { templates_json: tool.schema.string() },
      async execute(args, ctx): Promise<string> {
        const pid = getProjectIdForCtx(mgr, ctx)
        if (!pid) return 'Error: no project selected.'
        let tpls: any[]
        try { tpls = JSON.parse(args.templates_json) } catch { return 'templates_json is not valid JSON.' }
        if (!Array.isArray(tpls)) return 'templates_json must be an array.'
        replaceTemplates(db, pid, tpls)
        return `Replaced templates (${tpls.length}).`
      },
    }),

    project_context_write: tool({
      description: 'Overwrite the project\'s CONTEXT.md with new content. The auto-maintained "## Team" section is preserved.',
      args: { body: tool.schema.string() },
      async execute(args, ctx): Promise<string> {
        const pid = getProjectIdForCtx(mgr, ctx)
        if (!pid) return 'Error: no project selected.'
        const proj = db.prepare('SELECT id,name,path,description FROM projects WHERE id=$id').get({ $id: pid }) as { id: string; name: string; path: string; description: string } | null
        if (!proj) return 'Error: project not found.'
        await writeContextPreservingTeam(proj.path, args.body)
        await syncTeamSection(db, proj)
        return 'CONTEXT.md updated.'
      },
    }),
  }
}

function safeParseArray(s: string): string[] {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.map(String) : [] } catch { return [] }
}

/**
 * Parse a slug list in either form:
 *   "engineer,qa"               ← comma-separated (documented form)
 *   "[\"engineer\", \"qa\"]"    ← JSON array (PM occasionally emits this)
 *   "[]"                        ← empty JSON array (PM occasionally emits for empty)
 *   ""                          ← empty
 * Always returns a clean string[] with trimmed items and no empties.
 */
function parseSlugList(raw?: string | null): string[] {
  if (!raw) return []
  const trimmed = raw.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const v = JSON.parse(trimmed)
      if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean)
    } catch { /* fall through to comma split */ }
  }
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean)
}

// ─────────────────────────────────────────────────────────────────────────────
// Gating hook — tool.execute.before
// ─────────────────────────────────────────────────────────────────────────────

export function ticketToolGateHook(db: Database) {
  return async (input: { tool: string; sessionID: string; callID: string }, _output: { args: any }) => {
    ensureTicketTables(db)
    const toolName = input.tool
    const required = TOOL_GROUPS[toolName]
    if (!required) return // not one of ours
    if (!input.sessionID) return
    const agent = findAgentForSession(db, input.sessionID)
    if (!agent) return // interactive/user sessions bypass
    if (!agentHasGroup(agent, required)) {
      throw new Error(`Tool "${toolName}" requires tool_group "${required}". Agent @${agent.slug} has: ${agent.tool_groups_json}.`)
    }
  }
}

