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
import * as path from 'node:path'
import {
  type ProjectAgentRow,
  getAgentById,
  getTicket,
  getTicketAgentSession,
  setAgentSession,
  setTicketAgentSession,
  enqueuePendingTrigger,
} from './ticket-service'
import { globalWorkspacePath, tryReadContext } from './project-v2-seed'

export interface OpenCodeClientLike {
  session: {
    create(args: any): Promise<any>
    promptAsync(args: any): Promise<any>
    message?: { list?: (args: { path: { id: string } }) => Promise<any> }
  }
}

/**
 * Probe whether a session is currently mid-LLM-turn. Used to avoid firing a
 * new prompt at a busy persistent-mode session — opencode would abort the
 * in-flight generation, losing whatever the agent was doing. If we detect
 * busy, the caller queues the assignment in pending_agent_triggers and the
 * session.idle hook will drain it when the agent is free.
 */
async function isSessionBusy(client: OpenCodeClientLike, sessionId: string): Promise<boolean> {
  try {
    const list = client.session.message?.list
    if (!list) return false
    const res = await list({ path: { id: sessionId } }) as { data?: Array<{ info?: { role?: string; time?: { completed?: number } } }> } | undefined
    const msgs = res?.data ?? []
    if (!msgs.length) return false
    const last = msgs[msgs.length - 1].info ?? {}
    return last.role === 'assistant' && !last.time?.completed
  } catch {
    return false
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

async function ensureAgentFileInGlobalWorkspace(db: Database, agent: ProjectAgentRow, workspace: string): Promise<void> {
  const target = path.join(workspace, '.opencode', 'agent', `${agent.slug}.md`)
  if (agent.file_path === target) return
  try {
    const body = await fs.readFile(agent.file_path, 'utf8')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, body, 'utf8')
    db.prepare('UPDATE project_agents SET file_path=$fp WHERE id=$id').run({ $fp: target, $id: agent.id })
    agent.file_path = target
  } catch {
    // Keep historical project files untouched. If the old file cannot be read,
    // dispatch still proceeds against the global agent registry and OpenCode
    // will surface any missing-agent failure normally.
  }
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
    `Workspace: ${projectName}`,
    `You are agent: ${agent.name} (@${agent.slug})`,
    '',
    '## Workspace context (CONTEXT.md)',
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

  // Persistent-mode busy-check: if the agent's single session is mid-turn,
  // firing now would abort their current work. Queue this assignment and
  // bail — the session.idle hook in the kortix-system plugin will drain
  // pending_agent_triggers for this agent the next time their session
  // goes idle.
  if (agent.execution_mode === 'persistent' && sessionId) {
    if (await isSessionBusy(client, sessionId)) {
      enqueuePendingTrigger(db, { agent_id: agent.id, ticket_id: ticketId, reason })
      return null
    }
  }

  const workspace = globalWorkspacePath(project.path)
  await ensureAgentFileInGlobalWorkspace(db, agent, workspace)

  // Agent-cache freshness guard MUST run BEFORE session.create. Reason:
  // ensureAgentCacheFresh may POST /instance/dispose to flush the
  // directory's stale cache — and dispose nukes EVERY session in that
  // directory, including one we just minted. Symptom is bad: session.create
  // returns id X, dispose runs, promptAsync to X gets 204'd silently
  // (opencode no longer has X), and the agent never wakes (msgs=0,
  // ready_at=null forever). Always make the cache fresh first, then mint
  // the session into a stable instance.
  await ensureAgentCacheFresh(workspace, agent.slug)

  if (!sessionId) {
    try {
      const res = await client.session.create({
        body: { title: `${agent.name} · #${ticket.number} ${ticket.title}` },
        // Scope every session to the single global workspace directory so
        // OpenCode sees one Kortix instance instead of per-project instances.
        query: { directory: workspace },
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

  const contextBody = await tryReadContext(workspace)

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

  try {
    await client.session.promptAsync({
      path: { id: sessionId },
      // Dispatch under the agent's real opencode name from the global
      // workspace `.opencode/agent/<slug>.md` registry.
      query: { directory: workspace },
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

  // Brief grace for opencode's file watcher to detect the new .md on its
  // own (cheap; usually a few ms in practice).
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await isListed()) return
  }

  // Escalation: force-dispose the directory's instance to reload the
  // agent registry from disk. Trade-off: dispose nukes runtime state of
  // sibling sessions in this directory (e.g. PM's session is the one
  // calling team_create_agent + ticket_create that triggered this
  // ensure path). Without it, freshly-created engineer/qa agents NEVER
  // appear in the registry — opencode's file watcher misses them — so
  // every wake prompt with `agent: "engineer"` 204s silently and
  // sessions sit at msgs=0 forever. Project progress stops dead.
  //
  // Empirically: PM's tool call already returned to opencode by the
  // time the assignment-trigger fires this; PM resumes from disk on
  // its next turn. Net win.
  try { await fetch(disposeUrl, { method: 'POST' }) } catch {}
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await isListed()) return
  }
  console.warn(`[ticket-triggers] agent '${agentSlug}' still missing after dispose — proceeding anyway`)
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

  const workspace = globalWorkspacePath(project.path)
  await ensureAgentFileInGlobalWorkspace(db, agent, workspace)

  // Make the agent cache hot BEFORE minting a session — see comment on the
  // matching call in fireAgentTrigger. dispose-after-create wipes our
  // freshly-created session and the prompt vanishes silently.
  await ensureAgentCacheFresh(workspace, agent.slug)

  let sessionId = agent.session_id
  if (!sessionId) {
    try {
      const res = await client.session.create({
        body: { title: sessionTitle || `${agent.name} · ${project.name}` },
        // Scope to the single global workspace so opencode discovers the
        // global agent file registry.
        query: { directory: workspace },
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

  // Dispatch to the real opencode agent — persona + config live in the global
  // workspace `.opencode/agent/<slug>.md` file. Pass `directory` so opencode
  // resolves the agent from that single registry.
  try {
    await client.session.promptAsync({
      path: { id: sessionId },
      query: { directory: workspace },
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
