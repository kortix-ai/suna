/**
 * End-to-end coverage for the v2 ticket board: schema, seeding, column rules,
 * @-mentions, tool-group gating, and the per-ticket execution model.
 *
 * Uses a temp dir + a mock OpenCode client (no real sessions). That keeps the
 * test focused on our state machine — session creation / prompts are asserted
 * via calls into the mock.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import {
  ensureTicketTables,
  createTicket,
  updateTicketStatus,
  addAssignee,
  addComment,
  listColumns,
  listAgents,
  getAgentBySlug,
  insertAgent,
  getTicket,
  listTickets,
  extractMentions,
  getTicketAgentSession,
  setProjectStructureVersion,
} from '../../src/services/ticket-service'
import { seedV2Project, syncTeamSection, DEFAULT_PM_SLUG, TEAM_SECTION_START, TEAM_SECTION_END } from '../../src/services/project-v2-seed'
import { fireAgentTrigger, fireAgentTriggers, type OpenCodeClientLike } from '../../src/services/ticket-triggers'
import { findAgentForSession, agentHasGroup, TOOL_GROUPS, ticketToolGateHook } from '../../opencode/plugin/kortix-system/ticket-tools'

// ── Fixture helpers ──────────────────────────────────────────────────────────

interface Fixture {
  dir: string
  projectPath: string
  db: Database
  project: { id: string; name: string; path: string; description: string }
  mock: MockClient
}

interface SessionPrompt { sessionId: string; agent: string; text: string }

interface MockClient {
  client: OpenCodeClientLike
  sessions: string[]
  prompts: SessionPrompt[]
  createCount(): number
  promptCount(): number
}

function makeMockClient(): MockClient {
  const sessions: string[] = []
  const prompts: SessionPrompt[] = []
  let nextId = 1
  const client: OpenCodeClientLike = {
    session: {
      create: async (_args: any) => {
        const id = `ses-mock-${nextId++}`
        sessions.push(id)
        return { data: { id } }
      },
      promptAsync: async (args: any) => {
        prompts.push({
          sessionId: args.path.id,
          agent: args.body?.agent ?? '',
          text: args.body?.parts?.[0]?.text ?? '',
        })
      },
    },
  }
  return {
    client,
    sessions,
    prompts,
    createCount: () => sessions.length,
    promptCount: () => prompts.length,
  }
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'kortix-tickets-e2e-'))
  const projectPath = path.join(dir, 'workspace')
  const dbDir = path.join(projectPath, '.kortix')
  mkdirSync(dbDir, { recursive: true })
  const dbPath = path.join(dbDir, 'kortix.db')
  const db = new Database(dbPath, { create: true, readwrite: true })

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
  ensureTicketTables(db)

  const project = {
    id: `proj-${Date.now().toString(36)}`,
    name: 'Ticket E2E',
    path: projectPath,
    description: 'test project',
  }
  db.prepare('INSERT INTO projects (id,name,path,description,created_at,structure_version) VALUES ($id,$n,$p,$d,$c,$v)').run({
    $id: project.id, $n: project.name, $p: project.path, $d: project.description, $c: new Date().toISOString(), $v: 2,
  })

  return {
    dir,
    projectPath,
    db,
    project,
    mock: makeMockClient(),
  }
}

let fixtures: Fixture[] = []

beforeEach(() => {
  fixtures = []
})
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.db.close()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

async function setupSeededProject(): Promise<Fixture> {
  const fx = makeFixture()
  fixtures.push(fx)
  await seedV2Project(fx.db, fx.project)
  return fx
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('v2 project seeding', () => {
  test('seeds PM agent, default columns, structure_version=2, and Team section in CONTEXT.md', async () => {
    const fx = await setupSeededProject()

    const pm = getAgentBySlug(fx.db, fx.project.id, DEFAULT_PM_SLUG)
    expect(pm).not.toBeNull()
    expect(pm!.name).toBe('Project Manager')
    const groups = JSON.parse(pm!.tool_groups_json)
    expect(groups).toContain('project_manage')
    expect(groups).toContain('project_action')

    const cols = listColumns(fx.db, fx.project.id)
    expect(cols.map((c) => c.key)).toEqual(['backlog', 'in_progress', 'review', 'done'])
    const backlog = cols.find((c) => c.key === 'backlog')!
    expect(backlog.default_assignee_type).toBe('agent')
    expect(backlog.default_assignee_id).toBe(pm!.id)
    const done = cols.find((c) => c.key === 'done')!
    expect(done.is_terminal).toBe(1)

    const ctx = await fs.readFile(path.join(fx.project.path, '.kortix', 'CONTEXT.md'), 'utf8')
    expect(ctx).toContain(TEAM_SECTION_START)
    expect(ctx).toContain(TEAM_SECTION_END)
    expect(ctx).toContain('@project-manager')
    // No literal "You" in the team block — agents read this and "you" is ambiguous.
    expect(ctx).not.toMatch(/\*\*You\s/)
    // Handle placeholder when no user_handle is set.
    expect(ctx).toContain('@human')

    const row = fx.db.prepare('SELECT structure_version FROM projects WHERE id=$id').get({ $id: fx.project.id }) as any
    expect(row.structure_version).toBe(2)

    // The PM markdown file must exist on disk with frontmatter.
    const pmMd = await fs.readFile(pm!.file_path, 'utf8')
    expect(pmMd).toContain('slug: project-manager')
    expect(pmMd).toContain('tool_groups')
    expect(pmMd).toContain('project_manage')
  })

  test('seeding is idempotent — running twice doesn\'t duplicate agents or columns', async () => {
    const fx = await setupSeededProject()
    await seedV2Project(fx.db, fx.project)
    expect(listAgents(fx.db, fx.project.id)).toHaveLength(1)
    expect(listColumns(fx.db, fx.project.id)).toHaveLength(4)
  })
})

describe('ticket lifecycle', () => {
  test('new ticket lands in first column (backlog) and auto-assigns the PM', async () => {
    const fx = await setupSeededProject()
    const pm = getAgentBySlug(fx.db, fx.project.id, DEFAULT_PM_SLUG)!

    const { ticket, triggered } = createTicket(fx.db, {
      project_id: fx.project.id,
      title: 'First ticket',
      body_md: '## Acceptance\nShip it.',
      created_by_type: 'user',
    })

    expect(ticket.number).toBe(1)
    expect(ticket.status).toBe('backlog')
    expect(ticket.assignees).toHaveLength(1)
    expect(ticket.assignees[0]).toMatchObject({ assignee_type: 'agent', assignee_id: pm.id })
    expect(triggered).toHaveLength(1)
    expect(triggered[0]).toMatchObject({ agent_slug: DEFAULT_PM_SLUG })
  })

  test('assign_to on create routes to listed owner, skips column default, and is self-stripped for the creator', async () => {
    const fx = await setupSeededProject()
    const pm = getAgentBySlug(fx.db, fx.project.id, DEFAULT_PM_SLUG)!
    const engPersona = path.join(fx.project.path, '.kortix', 'agents', 'engineer.md')
    await fs.mkdir(path.dirname(engPersona), { recursive: true })
    await fs.writeFile(engPersona, '# Engineer', 'utf8')
    const eng = insertAgent(fx.db, fx.project.id, {
      slug: 'engineer', name: 'Engineer', file_path: engPersona,
      tool_groups: ['project_action'],
    })

    // PM creates a ticket and routes to engineer in the same call.
    const { ticket, triggered } = createTicket(fx.db, {
      project_id: fx.project.id,
      title: 'Routed ticket',
      created_by_type: 'agent',
      created_by_id: pm.id,
      assign_to: [{ type: 'agent', id: eng.id }],
    })

    // Only engineer is on it — column default (PM) is skipped because
    // assign_to was provided.
    expect(ticket.assignees).toHaveLength(1)
    expect(ticket.assignees[0]).toMatchObject({ assignee_type: 'agent', assignee_id: eng.id })
    expect(triggered).toHaveLength(1)
    expect(triggered[0]).toMatchObject({ agent_slug: 'engineer' })

    // Self-routing is a no-op: PM trying to assign itself creates an
    // unassigned ticket, not a ticket with PM redundantly on it.
    const r2 = createTicket(fx.db, {
      project_id: fx.project.id,
      title: 'Self-route',
      created_by_type: 'agent',
      created_by_id: pm.id,
      assign_to: [{ type: 'agent', id: pm.id }],
    })
    expect(r2.ticket.assignees).toHaveLength(0)
    expect(r2.triggered).toHaveLength(0)
  })

  test('ticket numbers increment per project', async () => {
    const fx = await setupSeededProject()
    const a = createTicket(fx.db, { project_id: fx.project.id, title: 'a' }).ticket
    const b = createTicket(fx.db, { project_id: fx.project.id, title: 'b' }).ticket
    const c = createTicket(fx.db, { project_id: fx.project.id, title: 'c' }).ticket
    expect([a.number, b.number, c.number]).toEqual([1, 2, 3])
  })

  test('updating status validates destination column', async () => {
    const fx = await setupSeededProject()
    const { ticket } = createTicket(fx.db, { project_id: fx.project.id, title: 'x' })
    expect(() => updateTicketStatus(fx.db, {
      ticketId: ticket.id, toStatus: 'nonexistent', actor_type: 'user',
    })).toThrow(/Unknown status/)
  })

  test('status change to a column with default assignee auto-assigns and emits a trigger', async () => {
    const fx = await setupSeededProject()
    const qaPersona = path.join(fx.project.path, '.kortix', 'agents', 'qa.md')
    await fs.mkdir(path.dirname(qaPersona), { recursive: true })
    await fs.writeFile(qaPersona, '# QA\nYou verify.', 'utf8')
    const qa = insertAgent(fx.db, fx.project.id, {
      slug: 'qa',
      name: 'QA',
      file_path: qaPersona,
      execution_mode: 'per_ticket',
      tool_groups: ['project_action'],
      default_assignee_columns: ['review'],
    })
    // Wire QA as default assignee of review column.
    fx.db.prepare('UPDATE project_columns SET default_assignee_type=$t, default_assignee_id=$id WHERE project_id=$pid AND key=$k')
      .run({ $t: 'agent', $id: qa.id, $pid: fx.project.id, $k: 'review' })

    const { ticket } = createTicket(fx.db, { project_id: fx.project.id, title: 'to review' })
    const res = updateTicketStatus(fx.db, {
      ticketId: ticket.id, toStatus: 'review', actor_type: 'user',
    })
    expect(res?.triggered).toHaveLength(1)
    expect(res?.triggered[0].agent_slug).toBe('qa')
    const assignees = getTicket(fx.db, ticket.id)!.assignees
    expect(assignees.some((a) => a.assignee_id === qa.id)).toBe(true)
  })

  test('promote-clears: when an agent moves a ticket they\'re assigned to, their assignment is removed', async () => {
    const fx = await setupSeededProject()
    const pm = getAgentBySlug(fx.db, fx.project.id, DEFAULT_PM_SLUG)!
    const { ticket } = createTicket(fx.db, { project_id: fx.project.id, title: 'pm moves' })
    expect(ticket.assignees.some((a) => a.assignee_id === pm.id)).toBe(true)

    updateTicketStatus(fx.db, {
      ticketId: ticket.id, toStatus: 'in_progress', actor_type: 'agent', actor_id: pm.id,
    })
    const after = getTicket(fx.db, ticket.id)!
    expect(after.assignees.some((a) => a.assignee_id === pm.id)).toBe(false)
  })
})

describe('comments + @-mentions', () => {
  test('extractMentions filters to registered slugs only', () => {
    expect(extractMentions('hey @qa and @unknown', ['qa', 'engineer'])).toEqual(['qa'])
    expect(extractMentions('no mentions', ['qa'])).toEqual([])
    expect(extractMentions('@QA @Qa @qa', ['qa'])).toEqual(['qa']) // case-insensitive, deduped
  })

  test('comment with @-mention emits a trigger for each mentioned agent', async () => {
    const fx = await setupSeededProject()
    const engPersona = path.join(fx.project.path, '.kortix', 'agents', 'engineer.md')
    await fs.mkdir(path.dirname(engPersona), { recursive: true })
    await fs.writeFile(engPersona, '# Engineer', 'utf8')
    const eng = insertAgent(fx.db, fx.project.id, {
      slug: 'engineer', name: 'Engineer', file_path: engPersona,
      tool_groups: ['project_action'],
    })

    const { ticket } = createTicket(fx.db, { project_id: fx.project.id, title: 'with mention' })
    const r = addComment(fx.db, {
      ticketId: ticket.id,
      body: 'Hey @engineer can you take this',
      actor_type: 'user',
    })
    expect(r.mentions).toEqual(['engineer'])
    expect(r.triggered[0].agent_slug).toBe('engineer')
    expect(r.triggered[0].agent_id).toBe(eng.id)
  })

  test('a self-mention does not trigger the agent', async () => {
    const fx = await setupSeededProject()
    const pm = getAgentBySlug(fx.db, fx.project.id, DEFAULT_PM_SLUG)!
    const { ticket } = createTicket(fx.db, { project_id: fx.project.id, title: 'self' })
    const r = addComment(fx.db, {
      ticketId: ticket.id, body: 'self-ping @project-manager',
      actor_type: 'agent', actor_id: pm.id,
    })
    expect(r.mentions).toEqual(['project-manager'])
    expect(r.triggered).toHaveLength(0) // don't notify self
  })
})

describe('per-ticket execution mode', () => {
  test('fireAgentTrigger spawns a session on first call and reuses it on subsequent calls', async () => {
    const fx = await setupSeededProject()
    const pm = getAgentBySlug(fx.db, fx.project.id, DEFAULT_PM_SLUG)!
    const { ticket } = createTicket(fx.db, { project_id: fx.project.id, title: 'reuse' })

    // First: spawns a session.
    const s1 = await fireAgentTrigger({
      db: fx.db, client: fx.mock.client, projectId: fx.project.id, ticketId: ticket.id,
      agent: pm, reason: 'assigned',
    })
    expect(s1).not.toBeNull()
    expect(fx.mock.createCount()).toBe(1)
    expect(fx.mock.promptCount()).toBe(1)
    expect(getTicketAgentSession(fx.db, ticket.id, pm.id)?.session_id).toBe(s1)

    // Second: reuses the existing session (no new create).
    const s2 = await fireAgentTrigger({
      db: fx.db, client: fx.mock.client, projectId: fx.project.id, ticketId: ticket.id,
      agent: pm, reason: 'mentioned',
    })
    expect(s2).toBe(s1)
    expect(fx.mock.createCount()).toBe(1)
    expect(fx.mock.promptCount()).toBe(2)
  })

  test('per_assignment mode spawns a new session each time', async () => {
    const fx = await setupSeededProject()
    const persona = path.join(fx.project.path, '.kortix', 'agents', 'eng2.md')
    await fs.mkdir(path.dirname(persona), { recursive: true })
    await fs.writeFile(persona, '# Engineer', 'utf8')
    const agent = insertAgent(fx.db, fx.project.id, {
      slug: 'eng2', name: 'Eng2', file_path: persona,
      execution_mode: 'per_assignment',
      tool_groups: ['project_action'],
    })
    const { ticket } = createTicket(fx.db, { project_id: fx.project.id, title: 'multi' })

    await fireAgentTrigger({ db: fx.db, client: fx.mock.client, projectId: fx.project.id, ticketId: ticket.id, agent, reason: 'r1' })
    await fireAgentTrigger({ db: fx.db, client: fx.mock.client, projectId: fx.project.id, ticketId: ticket.id, agent, reason: 'r2' })
    expect(fx.mock.createCount()).toBe(2)
  })

  test('fireAgentTriggers honours actor === self and does not re-notify the mover', async () => {
    const fx = await setupSeededProject()
    const pm = getAgentBySlug(fx.db, fx.project.id, DEFAULT_PM_SLUG)!
    const { ticket } = createTicket(fx.db, { project_id: fx.project.id, title: 'self-dedup' })

    await fireAgentTriggers({
      db: fx.db,
      client: fx.mock.client,
      projectId: fx.project.id,
      ticketId: ticket.id,
      triggered: [{ agent_id: pm.id, agent_slug: pm.slug, reason: 'column' }],
      actor: { type: 'agent', id: pm.id },
    })
    expect(fx.mock.createCount()).toBe(0)
  })

  test('session prompt includes ticket body, persona, and trigger reason', async () => {
    const fx = await setupSeededProject()
    const pm = getAgentBySlug(fx.db, fx.project.id, DEFAULT_PM_SLUG)!
    const { ticket } = createTicket(fx.db, {
      project_id: fx.project.id, title: 'Inspect me', body_md: '## Acceptance\nShip the thing.',
    })

    await fireAgentTrigger({
      db: fx.db, client: fx.mock.client, projectId: fx.project.id, ticketId: ticket.id,
      agent: pm, reason: 'You were assigned.',
    })
    const prompt = fx.mock.prompts[fx.mock.prompts.length - 1]
    expect(prompt.text).toContain('Inspect me')
    expect(prompt.text).toContain('Ship the thing.')
    expect(prompt.text).toContain('You were assigned.')
    expect(prompt.text).toContain('Project Manager')
    expect(prompt.text).toContain('@project-manager')
  })
})

describe('tool_group enforcement', () => {
  test('agent with only project_action cannot call team_create_agent', async () => {
    const fx = await setupSeededProject()
    const persona = path.join(fx.project.path, '.kortix', 'agents', 'worker.md')
    await fs.mkdir(path.dirname(persona), { recursive: true })
    await fs.writeFile(persona, '# Worker', 'utf8')
    const worker = insertAgent(fx.db, fx.project.id, {
      slug: 'worker', name: 'Worker', file_path: persona,
      tool_groups: ['project_action'],
    })
    // Pretend the worker has an active per_ticket session.
    const { ticket } = createTicket(fx.db, { project_id: fx.project.id, title: 't' })
    fx.db.prepare('INSERT INTO ticket_agent_sessions (ticket_id, agent_id, session_id, created_at) VALUES ($t,$a,$s,$c)')
      .run({ $t: ticket.id, $a: worker.id, $s: 'ses-worker-1', $c: new Date().toISOString() })

    const agent = findAgentForSession(fx.db, 'ses-worker-1')
    expect(agent?.id).toBe(worker.id)
    expect(agentHasGroup(agent, 'project_action')).toBe(true)
    expect(agentHasGroup(agent, 'project_manage')).toBe(false)

    const gate = ticketToolGateHook(fx.db)
    await expect(gate({ tool: 'ticket_comment', sessionID: 'ses-worker-1', callID: 'c1' }, { args: {} })).resolves.toBeUndefined()
    await expect(gate({ tool: 'team_create_agent', sessionID: 'ses-worker-1', callID: 'c2' }, { args: {} })).rejects.toThrow(/project_manage/)
  })

  test('user/interactive session (no bound agent) bypasses gating', async () => {
    const fx = await setupSeededProject()
    const gate = ticketToolGateHook(fx.db)
    await expect(gate({ tool: 'team_create_agent', sessionID: 'ses-interactive', callID: 'c0' }, { args: {} })).resolves.toBeUndefined()
  })

  test('every declared tool has a known group', () => {
    const knownGroups = new Set(['project_action', 'project_manage'])
    for (const [name, group] of Object.entries(TOOL_GROUPS)) {
      expect(knownGroups.has(group)).toBe(true)
      expect(name).toMatch(/^(ticket_|team_|project_)/)
    }
  })
})

describe('structure_version branching', () => {
  test('explicit v1 project does NOT get seeded by default', async () => {
    const fx = makeFixture()
    fixtures.push(fx)
    setProjectStructureVersion(fx.db, fx.project.id, 1)
    // Don't call seed.
    expect(listAgents(fx.db, fx.project.id)).toHaveLength(0)
    expect(listColumns(fx.db, fx.project.id)).toHaveLength(0)
  })

  test('syncTeamSection updates the CONTEXT.md after a new agent is registered', async () => {
    const fx = await setupSeededProject()
    const engPath = path.join(fx.project.path, '.kortix', 'agents', 'engineer.md')
    await fs.mkdir(path.dirname(engPath), { recursive: true })
    await fs.writeFile(engPath, '# Engineer', 'utf8')
    insertAgent(fx.db, fx.project.id, {
      slug: 'engineer', name: 'Engineer', file_path: engPath,
      tool_groups: ['project_action'],
    })
    await syncTeamSection(fx.db, fx.project)
    const ctx = await fs.readFile(path.join(fx.project.path, '.kortix', 'CONTEXT.md'), 'utf8')
    expect(ctx).toContain('@engineer')
    expect(ctx).toContain('@project-manager')
  })

  test('buildTeamSection uses provided user_handle and drops "You" wording', async () => {
    const fx = await setupSeededProject()
    await syncTeamSection(fx.db, { ...fx.project, user_handle: 'vukasinkubet' })
    const ctx = await fs.readFile(path.join(fx.project.path, '.kortix', 'CONTEXT.md'), 'utf8')
    expect(ctx).toContain('@vukasinkubet')
    expect(ctx).not.toContain('@human')
    expect(ctx).not.toContain('@user')
    expect(ctx).not.toMatch(/\*\*You\s/)
  })
})

describe('listing + filtering', () => {
  test('listTickets filters by project and status', async () => {
    const fx = await setupSeededProject()
    const { ticket: a } = createTicket(fx.db, { project_id: fx.project.id, title: 'A' })
    const { ticket: b } = createTicket(fx.db, { project_id: fx.project.id, title: 'B' })
    updateTicketStatus(fx.db, { ticketId: b.id, toStatus: 'in_progress', actor_type: 'user' })

    const backlog = listTickets(fx.db, { projectId: fx.project.id, status: 'backlog' })
    expect(backlog.map((t) => t.id)).toEqual([a.id])

    const inProgress = listTickets(fx.db, { projectId: fx.project.id, status: 'in_progress' })
    expect(inProgress.map((t) => t.id)).toEqual([b.id])
  })

  test('activity log records created → assigned → status_changed', async () => {
    const fx = await setupSeededProject()
    const { ticket } = createTicket(fx.db, { project_id: fx.project.id, title: 'trace me' })
    updateTicketStatus(fx.db, { ticketId: ticket.id, toStatus: 'in_progress', actor_type: 'user' })

    const events = fx.db.prepare('SELECT type FROM ticket_events WHERE ticket_id=$id ORDER BY created_at ASC').all({ $id: ticket.id }) as Array<{ type: string }>
    const types = events.map((e) => e.type)
    expect(types).toContain('created')
    expect(types).toContain('assigned')
    expect(types).toContain('status_changed')
  })
})
