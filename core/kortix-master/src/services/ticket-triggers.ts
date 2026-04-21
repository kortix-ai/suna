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

/**
 * Parse a stored "providerID/modelID" string into the shape OpenCode's
 * session.promptAsync expects. Returns null if the agent has no model set or
 * the stored value isn't parseable.
 */
function parseModel(raw: string | null | undefined): { providerID: string; modelID: string } | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return null
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) }
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
  contextBody: string
}): string {
  const { agent, ticketId, ticketNumber, ticketTitle, ticketBody, ticketStatus, reason, contextBody, projectName } = params
  // Persona is applied as a SYSTEM prompt by the plugin's
  // experimental.chat.system.transform hook — no need to prepend it here.
  return [
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
        // Scope the session to the project's directory so opencode discovers
        // `.opencode/agent/<slug>.md` files under it.
        query: { directory: project.path },
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
    contextBody,
  })

  // Agent-cache freshness guard: opencode caches `.opencode/agent/*.md` per
  // directory. If the agent was just created by team_create_agent in the
  // same PM turn, cache may not have picked it up yet — promptAsync then
  // returns 2xx but no LLM loop starts (opencode internally logs
  // `undefined is not an object (evaluating 'agent.variant')`).
  //
  // Strategy: POLL opencode's /agent endpoint until our slug is listed.
  // If it's missing after a short wait, force a dispose (blocking flush)
  // and poll again. ONLY then dispatch the prompt. This prevents both
  // empty-session wakes AND mid-turn aborts from later stray disposes.
  await ensureAgentCacheFresh(project.path, agent.slug)

  try {
    await client.session.promptAsync({
      path: { id: sessionId },
      // Dispatch under the agent's real opencode name — opencode loads the
      // persona + config from `<project>/.opencode/agent/<slug>.md`.
      query: { directory: project.path },
      body: {
        agent: agent.slug,
        parts: [{ type: 'text', text: prompt }],
        ...(parseModel(agent.default_model) ? { model: parseModel(agent.default_model)! } : {}),
      },
    })
  } catch (err) {
    console.warn('[ticket-triggers] promptAsync failed:', err)
  }

  return sessionId
}

async function ensureAgentCacheFresh(directory: string, agentSlug: string): Promise<void> {
  const listUrl = `http://localhost:4096/agent?directory=${encodeURIComponent(directory)}`
  const disposeUrl = `http://localhost:4096/instance/dispose?directory=${encodeURIComponent(directory)}`

  const isListed = async (): Promise<boolean> => {
    try {
      const res = await fetch(listUrl)
      if (!res.ok) return false
      const agents = (await res.json()) as Array<{ name?: string; slug?: string }>
      return agents.some((a) => a?.name === agentSlug || a?.slug === agentSlug)
    } catch {
      return false
    }
  }

  // Fast path: agent is already cached.
  if (await isListed()) return

  // Give opencode a short grace period before escalating to dispose (the
  // file watcher may be about to pick up the new .md on its own).
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await isListed()) return
  }

  // Escalate: force dispose to drop the stale per-directory cache, then
  // poll until the agent reappears. Dispose kills any in-flight LLM in
  // this directory, but at this point PM has already handed control over
  // via its tool call, so there's nothing actively generating.
  try { await fetch(disposeUrl, { method: 'POST' }) } catch {}
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await isListed()) return
  }
  console.warn(`[ticket-triggers] agent cache still missing '${agentSlug}' after dispose — proceeding anyway`)
}

/**
 * Wake an agent without a ticket — used for project-level onboarding.
 * Creates a dedicated session (stored on project_agents.session_id) so the
 * user can follow the conversation from the project's Sessions tab.
 */
export async function wakeAgentForProject(opts: {
  db: Database
  client: OpenCodeClientLike
  projectId: string
  agent: ProjectAgentRow
  prompt: string
  sessionTitle?: string
  bindSessionToProject?: (sessionId: string, projectId: string) => void | Promise<void>
}): Promise<string | null> {
  const { db, client, projectId, agent, prompt, sessionTitle, bindSessionToProject } = opts
  const project = db.prepare('SELECT id,name,path FROM projects WHERE id=$id').get({ $id: projectId }) as { id: string; name: string; path: string } | null
  if (!project) return null

  let sessionId = agent.session_id
  if (!sessionId) {
    try {
      const res = await client.session.create({
        body: { title: sessionTitle || `${agent.name} · ${project.name}` },
        // Scope to project directory so opencode discovers the agent file.
        query: { directory: project.path },
      })
      sessionId = (res?.data?.id as string | undefined) ?? null
    } catch (err) {
      console.warn('[ticket-triggers] project-level session.create failed:', err)
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
    try {
      db.prepare('UPDATE project_agents SET session_id=$sid WHERE id=$id').run({ $sid: sessionId, $id: agent.id })
    } catch {}
  }

  // Dispatch to the real opencode agent — persona + config live in the file
  // under `<project>/.opencode/agent/<slug>.md`. Pass `directory` so opencode
  // resolves the agent from the project's `.opencode/agent/` tree.
  try {
    await client.session.promptAsync({
      path: { id: sessionId },
      query: { directory: project.path },
      body: {
        agent: agent.slug,
        parts: [{ type: 'text', text: prompt }],
        ...(parseModel(agent.default_model) ? { model: parseModel(agent.default_model)! } : {}),
      },
    })
  } catch (err) {
    console.warn('[ticket-triggers] onboarding promptAsync failed:', err)
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

