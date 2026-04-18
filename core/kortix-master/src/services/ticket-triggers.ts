/**
 * Agent trigger dispatcher — shared by agent tools (plugin) and HTTP routes.
 *
 * A "trigger" fires when an agent should be woken up: they were just assigned
 * a ticket, @-mentioned, or the column they're default for got a new ticket.
 * Per-agent execution_mode controls whether we reuse an existing session
 * (per_ticket, persistent) or spawn a new one (per_assignment).
 *
 * OpenCode serialises messages to a single session — reusing a session for
 * concurrent triggers gives us natural queueing (our "lock").
 */

import { Database } from 'bun:sqlite'
import * as fs from 'node:fs/promises'
import {
  type ProjectAgentRow,
  getAgentById,
  getTicket,
  getTicketAgentSession,
  setAgentSession,
  setTicketAgentSession,
} from './ticket-service'
import { tryReadContext } from './project-v2-seed'

export interface OpenCodeClientLike {
  session: {
    create(args: any): Promise<any>
    promptAsync(args: any): Promise<any>
  }
}

export interface FireTriggerOptions {
  db: Database
  client: OpenCodeClientLike
  projectId: string
  ticketId: string
  agent: ProjectAgentRow
  reason: string
  /** Optional callback to bind a new session to the project (e.g. ProjectManager.setSessionProject). */
  bindSessionToProject?: (sessionId: string, projectId: string) => void | Promise<void>
}

function ticketNotificationPrompt(params: {
  projectName: string
  agent: ProjectAgentRow
  ticketNumber: number
  ticketId: string
  ticketTitle: string
  ticketBody: string
  ticketStatus: string
  reason: string
  personaBody: string
  contextBody: string
}): string {
  const { agent, ticketId, ticketNumber, ticketTitle, ticketBody, ticketStatus, reason, personaBody, contextBody, projectName } = params
  return [
    personaBody.trim(),
    '',
    '───────────────────────────────────────────────',
    `Project: ${projectName}`,
    `You are agent: ${agent.name} (@${agent.slug})`,
    '',
    '## Project context (CONTEXT.md)',
    contextBody.trim() || '(empty)',
    '',
    '## Ticket',
    `#${ticketNumber} — ${ticketTitle}  (${ticketId})`,
    `Status: ${ticketStatus}`,
    '',
    ticketBody.trim() || '(no body)',
    '',
    '## Why you were notified',
    reason,
    '',
    '## What to do',
    '1. Call `ticket_get` with this ticket id to see the full state + assignees.',
    '2. Call `ticket_events` to see history.',
    '3. Use `project_action` tools (`ticket_comment`, `ticket_update`, `ticket_assign`, `ticket_update_status`) as your role dictates.',
    '4. When your piece is done, move the ticket to the next column.',
  ].join('\n')
}

export async function fireAgentTrigger(opts: FireTriggerOptions): Promise<string | null> {
  const { db, client, projectId, ticketId, agent, reason, bindSessionToProject } = opts
  const ticket = getTicket(db, ticketId)
  if (!ticket) return null
  const project = db.prepare('SELECT id,name,path,description FROM projects WHERE id=$id').get({ $id: projectId }) as { id: string; name: string; path: string; description: string } | null
  if (!project) return null

  let sessionId: string | null = null
  if (agent.execution_mode === 'per_ticket') {
    const bound = getTicketAgentSession(db, ticketId, agent.id)
    sessionId = bound?.session_id ?? null
  } else if (agent.execution_mode === 'persistent') {
    sessionId = agent.session_id
  }

  if (!sessionId) {
    try {
      const res = await client.session.create({
        body: { title: `${agent.name} · #${ticket.number} ${ticket.title}` },
      })
      sessionId = res?.data?.id as string | undefined ?? null
    } catch (err) {
      console.warn('[ticket-triggers] session.create failed:', err)
      return null
    }
    if (!sessionId) return null
    if (bindSessionToProject) {
      try { await bindSessionToProject(sessionId, projectId) } catch {}
    } else {
      try {
        db.prepare('INSERT OR REPLACE INTO session_projects (session_id, project_id, set_at) VALUES ($sid, $pid, $now)')
          .run({ $sid: sessionId, $pid: projectId, $now: new Date().toISOString() })
      } catch {}
    }
    if (agent.execution_mode === 'per_ticket') {
      setTicketAgentSession(db, ticketId, agent.id, sessionId)
    } else if (agent.execution_mode === 'persistent') {
      setAgentSession(db, agent.id, sessionId)
    }
  }

  let personaBody = ''
  try { personaBody = await fs.readFile(agent.file_path, 'utf8') } catch {}
  const personaStripped = personaBody.replace(/^---[\s\S]*?---\n?/, '')
  const contextBody = await tryReadContext(project.path)

  const prompt = ticketNotificationPrompt({
    projectName: project.name,
    agent,
    ticketNumber: ticket.number,
    ticketId: ticket.id,
    ticketTitle: ticket.title,
    ticketBody: ticket.body_md,
    ticketStatus: ticket.status,
    reason,
    personaBody: personaStripped,
    contextBody,
  })

  try {
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        agent: 'worker',
        parts: [{ type: 'text', text: prompt }],
        ...(agent.default_model ? { model: agent.default_model } : {}),
      },
    })
  } catch (err) {
    console.warn('[ticket-triggers] promptAsync failed:', err)
  }

  return sessionId
}

export async function fireAgentTriggers(opts: {
  db: Database
  client: OpenCodeClientLike
  projectId: string
  ticketId: string
  triggered: Array<{ agent_id: string; agent_slug: string; reason: string }>
  actor?: { type: 'user' | 'agent' | 'system'; id?: string | null }
  bindSessionToProject?: (sessionId: string, projectId: string) => void | Promise<void>
}): Promise<void> {
  for (const t of opts.triggered) {
    const agent = getAgentById(opts.db, t.agent_id)
    if (!agent) continue
    if (opts.actor?.type === 'agent' && opts.actor.id === agent.id) continue
    await fireAgentTrigger({
      db: opts.db,
      client: opts.client,
      projectId: opts.projectId,
      ticketId: opts.ticketId,
      agent,
      reason: t.reason,
      bindSessionToProject: opts.bindSessionToProject,
    })
  }
}
