/**
 * Milestone-service coverage: CRUD, ticket linking, progress aggregation,
 * event log, name-collision rejection, delete-with-tickets refusal, status
 * transitions (close → reopen).
 *
 * Same fixture style as tickets-lifecycle.test.ts: temp dir + sqlite, no real
 * OpenCode client. We exercise the service layer directly + the CONTEXT.md
 * `## Milestones` sync.
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
  updateTicket,
  updateTicketStatus,
} from '../../src/services/ticket-service'
import {
  seedV2Project,
  syncMilestonesSection,
  MILESTONES_SECTION_START,
  MILESTONES_SECTION_END,
} from '../../src/services/project-v2-seed'
import {
  closeMilestone,
  computeMilestoneProgress,
  createMilestone,
  deleteMilestone,
  getMilestoneByNumber,
  getMilestoneByTitle,
  listMilestoneEvents,
  listMilestones,
  listTicketsForMilestone,
  reopenMilestone,
  updateMilestone,
} from '../../src/services/milestone-service'

interface Fixture {
  dir: string
  projectPath: string
  db: Database
  project: { id: string; name: string; path: string; description: string }
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'kortix-milestones-e2e-'))
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
    name: 'Milestone E2E',
    path: projectPath,
    description: 'milestone test project',
  }
  db.prepare(
    'INSERT INTO projects (id,name,path,description,created_at,structure_version) VALUES ($id,$n,$p,$d,$c,$v)',
  ).run({
    $id: project.id,
    $n: project.name,
    $p: project.path,
    $d: project.description,
    $c: new Date().toISOString(),
    $v: 2,
  })

  return { dir, projectPath, db, project }
}

let fixtures: Fixture[] = []

beforeEach(() => { fixtures = [] })
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    try { f.db.close() } catch {}
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

describe('milestones — CRUD', () => {
  test('create assigns sequential per-project numbers and stamps actor', async () => {
    const fx = await setupSeededProject()
    const a = createMilestone(fx.db, {
      project_id: fx.project.id,
      title: 'Delivery path e2e',
      acceptance_md: 'Done when: POST /events arrives at subscriber.',
      created_by_type: 'user',
      created_by_id: 'vukasin',
    })
    expect(a.number).toBe(1)
    expect(a.title).toBe('Delivery path e2e')
    expect(a.status).toBe('open')
    expect(a.created_by_type).toBe('user')
    expect(a.created_by_id).toBe('vukasin')

    const b = createMilestone(fx.db, {
      project_id: fx.project.id,
      title: 'Admin UX',
      created_by_type: 'agent',
      created_by_id: 'ag-pm-123',
    })
    expect(b.number).toBe(2)
    expect(b.created_by_type).toBe('agent')
  })

  test('rejects duplicate title in the same project (case-sensitive)', async () => {
    const fx = await setupSeededProject()
    createMilestone(fx.db, { project_id: fx.project.id, title: 'Delivery' })
    expect(() =>
      createMilestone(fx.db, { project_id: fx.project.id, title: 'Delivery' }),
    ).toThrow(/already exists/)
  })

  test('rejects empty title', async () => {
    const fx = await setupSeededProject()
    expect(() =>
      createMilestone(fx.db, { project_id: fx.project.id, title: '   ' }),
    ).toThrow(/title is required/i)
  })

  test('update writes a `updated` event with diff payload', async () => {
    const fx = await setupSeededProject()
    const m = createMilestone(fx.db, { project_id: fx.project.id, title: 'M' })

    updateMilestone(fx.db, m.id, {
      title: 'M renamed',
      acceptance_md: 'curl x | jq .ok',
    }, { type: 'user', id: 'tester' })

    const events = listMilestoneEvents(fx.db, m.id)
    expect(events.map((e) => e.type)).toEqual(['created', 'updated'])
    const updated = events[1]
    expect(updated.actor_type).toBe('user')
    expect(updated.actor_id).toBe('tester')
    const payload = JSON.parse(updated.payload_json ?? '{}')
    expect(payload.title.from).toBe('M')
    expect(payload.title.to).toBe('M renamed')
    expect(payload.acceptance_md).toBeTruthy()
  })

  test('update rejects renaming into another milestone’s title', async () => {
    const fx = await setupSeededProject()
    const a = createMilestone(fx.db, { project_id: fx.project.id, title: 'Alpha' })
    createMilestone(fx.db, { project_id: fx.project.id, title: 'Beta' })
    expect(() =>
      updateMilestone(fx.db, a.id, { title: 'Beta' }, { type: 'user', id: null }),
    ).toThrow(/already uses the title/)
  })
})

describe('milestones — ticket linking + progress', () => {
  test('ticket_create with milestone_id links and emits ticket_linked event', async () => {
    const fx = await setupSeededProject()
    const m = createMilestone(fx.db, { project_id: fx.project.id, title: 'M1' })
    const r = createTicket(fx.db, {
      project_id: fx.project.id,
      title: 'Scaffold',
      milestone_id: m.id,
    })
    expect(r.ticket.milestone_id).toBe(m.id)

    const events = listMilestoneEvents(fx.db, m.id)
    const linked = events.find((e) => e.type === 'ticket_linked')
    expect(linked).toBeDefined()
    expect(linked!.message).toContain('Scaffold')

    const linkedTickets = listTicketsForMilestone(fx.db, m.id)
    expect(linkedTickets.length).toBe(1)
    expect(linkedTickets[0].id).toBe(r.ticket.id)
  })

  test('ticket_create rejects milestone_id from a different project', async () => {
    const fx = await setupSeededProject()
    // Second project to source a foreign milestone from.
    const otherId = 'proj-other'
    fx.db.prepare(
      'INSERT INTO projects (id,name,path,description,created_at,structure_version) VALUES ($id,$n,$p,$d,$c,$v)',
    ).run({ $id: otherId, $n: 'Other', $p: fx.project.path + '-other', $d: '', $c: new Date().toISOString(), $v: 2 })
    const foreign = createMilestone(fx.db, { project_id: otherId, title: 'Foreign' })

    expect(() => createTicket(fx.db, {
      project_id: fx.project.id,
      title: 'Bad',
      milestone_id: foreign.id,
    })).toThrow(/different project/)
  })

  test('ticket_update with milestone_id link/unlink emits both ticket_unlinked + ticket_linked', async () => {
    const fx = await setupSeededProject()
    const a = createMilestone(fx.db, { project_id: fx.project.id, title: 'A' })
    const b = createMilestone(fx.db, { project_id: fx.project.id, title: 'B' })
    const r = createTicket(fx.db, { project_id: fx.project.id, title: 'T', milestone_id: a.id })

    // Move to b
    updateTicket(fx.db, r.ticket.id, { milestone_id: b.id }, { type: 'user', id: 'tester' })
    const aEvents = listMilestoneEvents(fx.db, a.id).map((e) => e.type)
    const bEvents = listMilestoneEvents(fx.db, b.id).map((e) => e.type)
    expect(aEvents).toContain('ticket_unlinked')
    expect(bEvents).toContain('ticket_linked')

    // Unlink completely
    updateTicket(fx.db, r.ticket.id, { milestone_id: null }, { type: 'user', id: 'tester' })
    const bEvents2 = listMilestoneEvents(fx.db, b.id).map((e) => e.type)
    expect(bEvents2.filter((t) => t === 'ticket_unlinked').length).toBe(1)
  })

  test('progress aggregation buckets tickets by status', async () => {
    const fx = await setupSeededProject()
    const m = createMilestone(fx.db, { project_id: fx.project.id, title: 'M' })

    // 5 tickets linked: 2 done, 1 in_progress, 1 review, 1 backlog
    const titles = ['t1', 't2', 't3', 't4', 't5']
    const created = titles.map((title) =>
      createTicket(fx.db, { project_id: fx.project.id, title, milestone_id: m.id }).ticket,
    )
    updateTicketStatus(fx.db, { ticketId: created[0].id, toStatus: 'done', actor_type: 'user' })
    updateTicketStatus(fx.db, { ticketId: created[1].id, toStatus: 'done', actor_type: 'user' })
    updateTicketStatus(fx.db, { ticketId: created[2].id, toStatus: 'in_progress', actor_type: 'user' })
    updateTicketStatus(fx.db, { ticketId: created[3].id, toStatus: 'review', actor_type: 'user' })
    // created[4] stays in default first column

    const p = computeMilestoneProgress(fx.db, m.id)
    expect(p.total).toBe(5)
    expect(p.done).toBe(2)
    expect(p.in_progress).toBe(1)
    expect(p.review).toBe(1)
    // backlog rolls into "other" since it's not one of the named buckets
    expect(p.other + p.blocked).toBe(1)

    const list = listMilestones(fx.db, fx.project.id, 'open')
    const wm = list.find((x) => x.id === m.id)!
    expect(wm.progress.total).toBe(5)
    expect(wm.progress.done).toBe(2)
  })
})

describe('milestones — close, reopen, delete', () => {
  test('close marks completed_at + closed_by + emits "closed" event with summary', async () => {
    const fx = await setupSeededProject()
    const m = createMilestone(fx.db, { project_id: fx.project.id, title: 'Ship' })
    const closed = closeMilestone(fx.db, m.id, {
      actor_type: 'agent', actor_id: 'ag-pm', summary_md: 'All tickets done; bun test green.',
    })
    expect(closed!.status).toBe('closed')
    expect(closed!.completed_at).toBeTruthy()
    expect(closed!.closed_by_type).toBe('agent')
    expect(closed!.closed_by_id).toBe('ag-pm')

    const events = listMilestoneEvents(fx.db, m.id)
    const closeEvent = events.find((e) => e.type === 'closed')
    expect(closeEvent).toBeDefined()
    expect(closeEvent!.message).toContain('bun test')
  })

  test('close with cancelled=true marks status=cancelled, not closed', async () => {
    const fx = await setupSeededProject()
    const m = createMilestone(fx.db, { project_id: fx.project.id, title: 'Drop' })
    const r = closeMilestone(fx.db, m.id, { actor_type: 'user', cancelled: true })
    expect(r!.status).toBe('cancelled')
    const events = listMilestoneEvents(fx.db, m.id).map((e) => e.type)
    expect(events).toContain('cancelled')
  })

  test('reopen flips back to open and emits "reopened"', async () => {
    const fx = await setupSeededProject()
    const m = createMilestone(fx.db, { project_id: fx.project.id, title: 'X' })
    closeMilestone(fx.db, m.id, { actor_type: 'user' })
    const r = reopenMilestone(fx.db, m.id, { type: 'user', id: 'tester' })
    expect(r!.status).toBe('open')
    expect(r!.completed_at).toBeNull()
    const events = listMilestoneEvents(fx.db, m.id).map((e) => e.type)
    expect(events).toContain('reopened')
  })

  test('delete refuses if tickets still linked', async () => {
    const fx = await setupSeededProject()
    const m = createMilestone(fx.db, { project_id: fx.project.id, title: 'Linked' })
    createTicket(fx.db, { project_id: fx.project.id, title: 'Still here', milestone_id: m.id })
    const r = deleteMilestone(fx.db, m.id, { type: 'user', id: null })
    expect(r.deleted).toBe(false)
    expect(r.reason).toMatch(/linked ticket/)
  })

  test('delete succeeds when no tickets linked, removing event log too', async () => {
    const fx = await setupSeededProject()
    const m = createMilestone(fx.db, { project_id: fx.project.id, title: 'Lonely' })
    const r = deleteMilestone(fx.db, m.id, { type: 'user', id: null })
    expect(r.deleted).toBe(true)
    expect(getMilestoneByNumber(fx.db, fx.project.id, m.number)).toBeNull()
    expect(listMilestoneEvents(fx.db, m.id).length).toBe(0)
  })
})

describe('milestones — resolution helpers', () => {
  test('getMilestoneByNumber + getMilestoneByTitle find the same row', async () => {
    const fx = await setupSeededProject()
    const m = createMilestone(fx.db, { project_id: fx.project.id, title: 'Find me' })
    expect(getMilestoneByNumber(fx.db, fx.project.id, m.number)?.id).toBe(m.id)
    expect(getMilestoneByTitle(fx.db, fx.project.id, 'Find me')?.id).toBe(m.id)
    expect(getMilestoneByNumber(fx.db, fx.project.id, 999)).toBeNull()
  })

  test('listMilestones status filters', async () => {
    const fx = await setupSeededProject()
    const a = createMilestone(fx.db, { project_id: fx.project.id, title: 'Open' })
    const b = createMilestone(fx.db, { project_id: fx.project.id, title: 'Closed' })
    closeMilestone(fx.db, b.id, { actor_type: 'user' })
    expect(listMilestones(fx.db, fx.project.id, 'open').length).toBe(1)
    expect(listMilestones(fx.db, fx.project.id, 'closed').length).toBe(1)
    expect(listMilestones(fx.db, fx.project.id, 'all').length).toBe(2)
    void a
  })
})

describe('milestones — CONTEXT.md sync', () => {
  test('syncMilestonesSection writes a marked block listing OPEN milestones with acceptance preview', async () => {
    const fx = await setupSeededProject()
    createMilestone(fx.db, {
      project_id: fx.project.id,
      title: 'Delivery',
      acceptance_md: 'Done when: subscriber receives signed hook.\nMore detail.',
    })
    createMilestone(fx.db, { project_id: fx.project.id, title: 'Admin' })
    await syncMilestonesSection(fx.db, fx.project)
    const ctx = await fs.readFile(path.join(fx.project.path, '.kortix', 'CONTEXT.md'), 'utf8')
    expect(ctx).toContain(MILESTONES_SECTION_START)
    expect(ctx).toContain(MILESTONES_SECTION_END)
    expect(ctx).toContain('## Milestones')
    expect(ctx).toContain('M1')
    expect(ctx).toContain('Delivery')
    // Acceptance preview is the first line, truncated to 140 chars.
    expect(ctx).toContain('Done when: subscriber receives signed hook.')
  })

  test('closed milestones are hidden from the open-only block (history lives in events)', async () => {
    const fx = await setupSeededProject()
    const a = createMilestone(fx.db, { project_id: fx.project.id, title: 'Active' })
    const b = createMilestone(fx.db, { project_id: fx.project.id, title: 'Done deal' })
    closeMilestone(fx.db, b.id, { actor_type: 'user' })
    await syncMilestonesSection(fx.db, fx.project)
    const ctx = await fs.readFile(path.join(fx.project.path, '.kortix', 'CONTEXT.md'), 'utf8')
    expect(ctx).toContain('Active')
    expect(ctx).not.toContain('Done deal')
    void a
  })

  test('empty (no open milestones) renders the friendly placeholder, not a stale list', async () => {
    const fx = await setupSeededProject()
    await syncMilestonesSection(fx.db, fx.project)
    const ctx = await fs.readFile(path.join(fx.project.path, '.kortix', 'CONTEXT.md'), 'utf8')
    expect(ctx).toContain('## Milestones')
    expect(ctx).toContain('No open milestones')
  })
})
