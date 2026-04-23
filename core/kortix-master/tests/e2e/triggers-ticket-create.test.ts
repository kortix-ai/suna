/**
 * End-to-end coverage for the additive trigger features introduced for the
 * v2 project → trigger → ticket round-trip:
 *
 *   1. Seed produces a default PM "Board operations" ticket (in_progress).
 *   2. `ticket_create` trigger action: renders `{{ var }}` against the
 *       webhook payload, creates a ticket, and wakes the routed agents.
 *   3. `ticket_id` on a trigger binds it to a specific ticket (reverse
 *       lookup consumed by the UI's "ongoing" badge).
 *
 * Uses a temp-dir sqlite DB + a mock OpenCode client — no real sessions or
 * opencode server. That keeps assertions focused on the state machine.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import {
  ensureTicketTables,
  listTickets,
  getAgentBySlug,
  getTicket,
  getTicketAgentSession,
} from '../../src/services/ticket-service'
import { executePromptAction } from '../../triggers/src/actions/prompt-action'
import {
  seedV2Project,
  DEFAULT_PM_SLUG,
  PM_DASHBOARD_TITLE,
  PM_DASHBOARD_STATUS,
} from '../../src/services/project-v2-seed'
import { executeTicketCreateAction } from '../../triggers/src/actions/ticket-create-action'
import type { TriggerRecord, MinimalOpenCodeClient } from '../../triggers/src/types'

// ── Fixture helpers ──────────────────────────────────────────────────────────

interface SessionPrompt { sessionId: string; agent: string; text: string }
interface MockClient {
  client: MinimalOpenCodeClient
  sessions: string[]
  prompts: SessionPrompt[]
}

function makeMockClient(): MockClient {
  const sessions: string[] = []
  const prompts: SessionPrompt[] = []
  let n = 1
  const client: MinimalOpenCodeClient = {
    session: {
      create: async () => {
        const id = `ses-mock-${n++}`
        sessions.push(id)
        return { data: { id } } as any
      },
      promptAsync: async (args: any) => {
        prompts.push({
          sessionId: args.path?.id ?? '',
          agent: args.body?.agent ?? '',
          text: args.body?.parts?.[0]?.text ?? '',
        })
      },
    },
  }
  return { client, sessions, prompts }
}

interface Fixture {
  dir: string
  projectPath: string
  db: Database
  project: { id: string; name: string; path: string; description: string }
  pmId: string
  engineerId: string
  mock: MockClient
}

async function makeFixture(): Promise<Fixture> {
  const dir = mkdtempSync(path.join(tmpdir(), 'kortix-trigtix-e2e-'))
  const projectPath = path.join(dir, 'demo-proj')
  mkdirSync(projectPath, { recursive: true })
  mkdirSync(path.join(projectPath, '.kortix'), { recursive: true })

  // Point the ticket-create-action at our temp DB via env.
  process.env.KORTIX_WORKSPACE = dir
  mkdirSync(path.join(dir, '.kortix'), { recursive: true })
  const db = new Database(path.join(dir, '.kortix', 'kortix.db'), { create: true, readwrite: true })
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      opencode_id TEXT, maintainer_session_id TEXT,
      structure_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS session_projects (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      set_at TEXT NOT NULL
    );
  `)
  db.exec('PRAGMA busy_timeout=5000')
  ensureTicketTables(db)
  // Triggers table — normally created by TriggerStore.migrate(). Inlined
  // here (minimal column set the tests need) to avoid coupling this test
  // fixture to the engine's constructor.
  db.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      description TEXT, source_type TEXT NOT NULL,
      source_config TEXT NOT NULL DEFAULT '{}',
      action_type TEXT NOT NULL DEFAULT 'prompt',
      action_config TEXT NOT NULL DEFAULT '{}',
      context_config TEXT NOT NULL DEFAULT '{}',
      agent_name TEXT, model_id TEXT,
      session_mode TEXT NOT NULL DEFAULT 'new', session_id TEXT,
      pipedream_app TEXT, pipedream_component TEXT,
      pipedream_deployed_id TEXT, pipedream_webhook_url TEXT,
      pipedream_props TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT, next_run_at TEXT, last_event_at TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      project_id TEXT, ticket_id TEXT
    );
  `)

  const project = { id: 'proj-demo-123', name: 'demo-proj', path: projectPath, description: 'demo' }
  db.prepare('INSERT INTO projects (id,name,path,description,created_at,structure_version) VALUES (?,?,?,?,?,?)')
    .run(project.id, project.name, project.path, project.description, new Date().toISOString(), 2)

  await seedV2Project(db, project)

  const pm = getAgentBySlug(db, project.id, DEFAULT_PM_SLUG)!
  // Manually insert an engineer row (normally done by team_create_agent).
  const engId = 'ag-eng-123'
  db.prepare(`INSERT INTO project_agents
      (id,project_id,slug,name,file_path,execution_mode,tool_groups_json,default_assignee_columns_json,default_model,created_at,ready_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(engId, project.id, 'engineer', 'Engineer', path.join(projectPath, '.opencode', 'agent', 'engineer.md'),
      'per_ticket', '["project_action"]', '[]', 'anthropic/claude-sonnet-4-6',
      new Date().toISOString(), new Date().toISOString())

  return { dir, projectPath, db, project, pmId: pm.id, engineerId: engId, mock: makeMockClient() }
}

const tempRoots: string[] = []
afterEach(() => {
  delete process.env.KORTIX_WORKSPACE
  for (const d of tempRoots.splice(0)) rmSync(d, { recursive: true, force: true })
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('trigger → ticket_create + reverse lookup', () => {
  test('seedV2Project creates the PM dashboard ticket in_progress, assigned to PM', async () => {
    const f = await makeFixture()
    tempRoots.push(f.dir)

    const tickets = listTickets(f.db, { projectId: f.project.id })
    const dash = tickets.find((t) => t.title === PM_DASHBOARD_TITLE)
    expect(dash).toBeTruthy()
    expect(dash!.status).toBe(PM_DASHBOARD_STATUS)
    expect(dash!.created_by_type).toBe('system')
    expect(dash!.assignees).toEqual([
      expect.objectContaining({ assignee_type: 'agent', assignee_id: f.pmId }),
    ])
  })

  test('ticket_create action renders {{ var }} + creates ticket + wakes assignees', async () => {
    const f = await makeFixture()
    tempRoots.push(f.dir)

    const trigger: TriggerRecord = {
      id: 'trig-1',
      name: 'bug-intake',
      description: null,
      source_type: 'webhook',
      source_config: JSON.stringify({ path: '/hooks/bug', method: 'POST' }),
      action_type: 'ticket_create',
      // No explicit column — lets createTicket's auto-move kick in for the
      // "assignees present" path (lands in in_progress instead of backlog).
      action_config: JSON.stringify({
        title: 'Bug: {{ summary }}',
        body_md: 'Reported by {{ reporter }}\n\n{{ details }}',
        assignee_slugs: ['engineer'],
      }),
      context_config: '{}',
      agent_name: null,
      model_id: null,
      session_mode: 'new',
      session_id: null,
      pipedream_app: null,
      pipedream_component: null,
      pipedream_deployed_id: null,
      pipedream_webhook_url: null,
      pipedream_props: '{}',
      is_active: 1,
      last_run_at: null,
      next_run_at: null,
      last_event_at: null,
      event_count: 0,
      metadata: '{}',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    // project_id is the additive column — set via raw SQL like the route does.
    ;(trigger as any).project_id = f.project.id

    const result = await executeTicketCreateAction(f.mock.client, trigger, {
      type: 'webhook.request',
      timestamp: new Date().toISOString(),
      data: {
        method: 'POST',
        path: '/hooks/bug',
        body: {
          summary: 'login fails on safari',
          reporter: 'alice',
          details: 'cookie scope broken',
        },
      },
    })

    const ticket = getTicket(f.db, result.ticketId)!
    expect(ticket.title).toBe('Bug: login fails on safari')
    expect(ticket.body_md).toContain('Reported by alice')
    expect(ticket.body_md).toContain('cookie scope broken')
    expect(ticket.created_by_type).toBe('agent')
    expect(ticket.assignees.find((a) => a.assignee_id === f.engineerId)).toBeTruthy()

    // assign_to routed → ticket auto-advances past the first column.
    expect(ticket.status).not.toBe('backlog')

    // Wake fired: mock client recorded a session.create + promptAsync for engineer.
    expect(f.mock.sessions.length).toBeGreaterThanOrEqual(1)
    expect(f.mock.prompts.some((p) => p.agent === 'engineer')).toBe(true)
  })

  test('ticket_create action requires project_id on the trigger', async () => {
    const f = await makeFixture()
    tempRoots.push(f.dir)

    const trigger = {
      id: 'trig-bad', name: 'no-project', source_type: 'webhook',
      source_config: '{}', action_type: 'ticket_create',
      action_config: JSON.stringify({ title: 'x' }),
      context_config: '{}', agent_name: null, model_id: null,
      session_mode: 'new', session_id: null,
      pipedream_app: null, pipedream_component: null,
      pipedream_deployed_id: null, pipedream_webhook_url: null,
      pipedream_props: '{}', is_active: 1, last_run_at: null, next_run_at: null,
      last_event_at: null, event_count: 0, metadata: '{}',
      description: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    } as any as TriggerRecord

    await expect(
      executeTicketCreateAction(f.mock.client, trigger, {
        type: 'webhook.request', timestamp: new Date().toISOString(), data: {},
      }),
    ).rejects.toThrow(/project_id unset/)
  })

  test('ticket_id on trigger persists through DB + is visible for reverse lookup', async () => {
    const f = await makeFixture()
    tempRoots.push(f.dir)

    // Grab the seeded PM dashboard ticket.
    const dash = listTickets(f.db, { projectId: f.project.id })
      .find((t) => t.title === PM_DASHBOARD_TITLE)!

    // Insert a cron trigger bound to the dashboard ticket — mimics what the
    // HTTP route does (raw INSERT + stamp).
    f.db.prepare(`INSERT INTO triggers
      (id,name,description,source_type,source_config,action_type,action_config,context_config,
       agent_name,model_id,session_mode,session_id,pipedream_app,pipedream_component,
       pipedream_deployed_id,pipedream_webhook_url,pipedream_props,is_active,last_run_at,
       next_run_at,last_event_at,event_count,metadata,created_at,updated_at,project_id,ticket_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        'trig-bound', 'board-sweep', null,
        'cron', JSON.stringify({ cron_expr: '0 */30 * * * *', timezone: 'UTC' }),
        'prompt', JSON.stringify({ prompt: 'sweep' }),
        '{}', 'project-manager', null, 'new', null,
        null, null, null, null, '{}', 1, null, null, null, 0, '{}',
        new Date().toISOString(), new Date().toISOString(),
        f.project.id, dash.id,
      )

    // Reverse-lookup query (what TicketBoard's triggersByTicket map runs).
    const bound = f.db.prepare('SELECT id,name,ticket_id FROM triggers WHERE ticket_id=?').all(dash.id) as Array<{ id: string; name: string; ticket_id: string }>
    expect(bound).toHaveLength(1)
    expect(bound[0].name).toBe('board-sweep')
    expect(bound[0].ticket_id).toBe(dash.id)
  })

  test('prompt-action fires register the spawned session in ticket_agent_sessions so PM comments are attributed to agent (not user)', async () => {
    const f = await makeFixture()
    tempRoots.push(f.dir)

    const dash = listTickets(f.db, { projectId: f.project.id })
      .find((t) => t.title === PM_DASHBOARD_TITLE)!

    const trigger = {
      id: 'trig-sweep',
      name: 'board-sweep',
      description: null,
      source_type: 'cron',
      source_config: JSON.stringify({ cron_expr: '0 */30 * * * *', timezone: 'UTC' }),
      action_type: 'prompt',
      action_config: JSON.stringify({ prompt: 'sweep the board' }),
      context_config: '{}',
      agent_name: DEFAULT_PM_SLUG,
      model_id: null,
      session_mode: 'new',
      session_id: null,
      pipedream_app: null,
      pipedream_component: null,
      pipedream_deployed_id: null,
      pipedream_webhook_url: null,
      pipedream_props: '{}',
      is_active: 1,
      last_run_at: null,
      next_run_at: null,
      last_event_at: null,
      event_count: 0,
      metadata: '{}',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any as import('../../triggers/src/types').TriggerRecord
    ;(trigger as any).project_id = f.project.id
    ;(trigger as any).ticket_id = dash.id

    await executePromptAction(f.mock.client, trigger, {
      type: 'cron.tick',
      timestamp: new Date().toISOString(),
      data: undefined,
    }, { directory: f.projectPath, reusedSessions: new Map() })

    // Session must have been bound to the PM agent for this ticket.
    const bound = getTicketAgentSession(f.db, dash.id, f.pmId)
    expect(bound).toBeTruthy()
    expect(bound!.session_id).toMatch(/^ses-mock-\d+/)
    // And the session_projects row must exist too.
    const sp = f.db.prepare('SELECT project_id FROM session_projects WHERE session_id=?').get(bound!.session_id) as { project_id?: string } | null
    expect(sp?.project_id).toBe(f.project.id)
  })
})
