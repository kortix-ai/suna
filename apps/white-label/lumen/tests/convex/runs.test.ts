import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { KIT } from '../../convex/kit/bundle.generated';
import { addMember, lumenTest, org, signedInUser } from './setup';

// Kortix, faked at the SDK edge: an in-memory Drive and scripted sessions. Each
// test scripts what "the agent" writes when its session starts or is prompted.
/** `agent`: the session's Kortix agent (the firm's). `role`: the kit role its input.json names. */
type Session = { id: string; agent: string; role: string; inputPath: string; sends: string[] };
const fake = vi.hoisted(() => {
  const drive = new Map<string, { data: string; mtime: number }>();
  const sessions: Session[] = [];
  const created: Array<{ projectId: string; agent: string }> = [];
  const stopped: string[] = [];
  const script = {
    onStart: (_s: Session) => {},
    onSend: (_s: Session, _text: string) => {},
    turn: (_s: Session): { turns: unknown[]; last_ended?: { ended_at: string; end_reason: string; error?: { name: string; message: string } } } =>
      ({ turns: [{}] }),
  };
  let clock = 0;
  const write = (path: string, value: unknown) => drive.set(path, { data: typeof value === 'string' ? value : JSON.stringify(value), mtime: ++clock });
  return { drive, sessions, created, stopped, script, write };
});

vi.mock('@kortix/sdk', () => ({
  createProjectSession: async (pid: string, input: { agent_name: string; initial_prompt: string }) => {
    fake.created.push({ projectId: pid, agent: input.agent_name });
    // The firm folder /Lumen/Firms/<firmId> mounts at /drives/<firmId>; a restricted matter's /Lumen/Walled/<matterId> at /drives/<matterId>.
    const seen = /Input: (\S+)/.exec(input.initial_prompt)![1];
    const inputPath = [seen.replace(/^\/drives\/([^/]+)/, '/Lumen/Firms/$1'), seen.replace(/^\/drives\/([^/]+)/, '/Lumen/Walled/$1')].find((p) => fake.drive.has(p))!;
    const role = JSON.parse(fake.drive.get(inputPath)!.data).role as string;
    const s = { id: `sess_${fake.sessions.length + 1}`, agent: input.agent_name, role, inputPath, sends: [] };
    fake.sessions.push(s);
    fake.script.onStart(s);
    return { session_id: s.id };
  },
  getSessionTurn: async (_pid: string, sid: string) => fake.script.turn(fake.sessions.find((s) => s.id === sid)!),
  makeDriveFolder: async (_d: string, path: string) => ({ path }),
  uploadDriveFile: async (_d: string, path: string, body: Uint8Array) => {
    fake.write(path, new TextDecoder().decode(body));
    return { path, size: body.byteLength };
  },
  readDriveFile: async (_d: string, path: string) => {
    const f = fake.drive.get(path);
    if (!f) throw Object.assign(new Error('not found'), { status: 404 });
    return { blob: new Blob([f.data]), version: String(f.mtime) };
  },
  listDriveFolder: async (_d: string, path: string) => {
    const prefix = `${path}/`;
    const names = new Map<string, { type: 'file' | 'dir'; size: number; mtime: number }>();
    for (const [p, f] of fake.drive) {
      if (!p.startsWith(prefix)) continue;
      const [head, ...rest] = p.slice(prefix.length).split('/');
      names.set(head, rest.length ? { type: 'dir', size: 0, mtime: 0 } : { type: 'file', size: f.data.length, mtime: f.mtime });
    }
    if (!names.size) throw Object.assign(new Error('not found'), { status: 404 });
    return { entries: [...names].map(([name, e]) => ({ name, path: `${prefix}${name}`, ...e })), access: 'edit' };
  },
}));
vi.mock('@kortix/sdk/server', () => ({
  runWithKortix: (_c: unknown, fn: () => unknown) => fn(),
  createScopedKortix: () => ({
    session: (_pid: string, sid: string) => ({
      send: async (text: string) => {
        const s = fake.sessions.find((x) => x.id === sid)!;
        s.sends.push(text);
        fake.script.onSend(s, text);
      },
      abort: async () => {},
      stop: async () => void fake.stopped.push(sid),
    }),
  }),
}));

type T = ReturnType<typeof lumenTest>;

beforeEach(() => {
  vi.useFakeTimers();
  fake.drive.clear();
  fake.sessions.length = 0;
  fake.created.length = 0;
  fake.stopped.length = 0;
  fake.script.onStart = () => {};
  fake.script.onSend = () => {};
  fake.script.turn = () => ({ turns: [{}] });
});
afterEach(() => vi.useRealTimers());

const PARA = (i: number) => `${i}.1 The clause of document ${i} that answers every column.`;

/** An onboarded firm in the shared project (kit current) with one matter of `n` ready documents, each with one paragraph. */
async function world(n: number) {
  const t = lumenTest();
  const orgId = await org(t, 'Example Co');
  const owner = await signedInUser(t, 'owner@example.com');
  await addMember(t, orgId, owner.userId, 'owner');
  const w = await t.run(async (ctx) => {
    await ctx.db.insert('deployment', {
      key: 'default', status: 'ready', projectId: 'proj_shared', accountId: 'acc_1', driveId: 'drive_shared', kitVersion: KIT.version, kitHash: KIT.hash,
    });
    const firmId = await ctx.db.insert('firms', {
      orgId, name: 'Example & Co. Legal', practiceTags: [], sizeBand: '2-10', status: 'ready',
      plan: 'trial', seats: 5, billingStatus: 'none', createdBy: owner.userId,
    });
    await ctx.db.patch(firmId, { kortixAgent: `lumen-f-${firmId}`, agentConfig: `${KIT.hash}:`, kortixServiceAccountId: 'sa_1' });
    await ctx.db.insert('firmCredentials', { firmId, serviceAccountId: 'sa_1', secret: 'kortix_sa_secret_1' });
    const root = `/Lumen/Firms/${firmId}/Matters/m1`;
    const matterId = await ctx.db.insert('matters', {
      firmId, name: 'Project Aster', client: 'Brightwater Example Holdings', parties: [], status: 'open', visibility: 'firm',
      driveFolder: root, createdBy: 'user_owner', updatedAt: 0,
    });
    const docs: Id<'documents'>[] = [];
    for (let i = 1; i <= n; i++) {
      const storageId = await ctx.storage.store(new Blob(['x']));
      const id = await ctx.db.insert('documents', {
        firmId, matterId, storageId, filename: `doc-${i}.pdf`, mime: 'application/pdf', bytes: 1, status: 'ready', pages: 1, paras: 1,
        driveFile: `${root}/Docs/d${i}.pdf`, textFile: `${root}/Text/d${i}.md`, uploadedBy: 'user_owner',
      });
      await ctx.db.insert('documentParas', { documentId: id, matterId, page: 1, para: 1, text: PARA(i) });
      docs.push(id);
    }
    return { firmId, matterId, docs };
  });
  return { t, owner, ...w };
}

type Input = { batch_dir: string; documents: Array<{ doc_id: string }>; columns: Array<{ key: string }> };
const inputOf = (s: Session) => JSON.parse(fake.drive.get(s.inputPath)!.data) as Input;
const dirOf = (s: Session) => s.inputPath.replace(/\/input\.json$/, '');

function goodRow(docId: string, columns: Array<{ key: string }>, i: number, override: Record<string, unknown> = {}) {
  return {
    schema: 'review-row/1', doc_id: docId,
    cells: Object.fromEntries(columns.map((c) => [c.key, {
      value: `answer ${c.key}`, note: 'Read clause 1.', confidence: 'high',
      citations: [{ doc_id: docId, a: 'p1.1', quote: `The clause of document ${i}` }], ...override,
    }])),
  };
}

/** The agent writes every row of its batch, then done.json. */
function writeAll(s: Session) {
  const input = inputOf(s);
  input.documents.forEach((d) => fake.write(`${dirOf(s)}/out/rows/${d.doc_id}.json`, goodRow(d.doc_id, input.columns, docIndex.get(d.doc_id)!)));
  fake.write(`${dirOf(s)}/done.json`, { status: 'succeeded', outputs: [] });
}
const docIndex = new Map<string, number>();

async function startReview(t: T, matterId: Id<'matters'>, docs: Id<'documents'>[]) {
  docs.forEach((d, i) => docIndex.set(d, i + 1));
  return t.mutation(internal.runs.startReviewAsOwner, { matterId });
}

const idleNow = () => ({ turns: [], last_ended: { ended_at: new Date(Date.now()).toISOString(), end_reason: 'completed' } });

async function finish(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers, 500);
}

describe('run engine: a restricted matter', () => {
  test('its batches run on the matter agent and work inside the matter folder, never in the firm folder', async () => {
    const { t, matterId, docs } = await world(2);
    await t.run(async (ctx) => {
      await ctx.db.patch(matterId, { visibility: 'restricted', driveFolder: '/Lumen/Walled/m1', kortixAgent: 'lumen-m-m1', agentConfig: `${KIT.hash}:` });
      for (const [i, d] of docs.entries()) await ctx.db.patch(d, { driveFile: `/Lumen/Walled/m1/Docs/d${i + 1}.pdf`, textFile: `/Lumen/Walled/m1/Text/d${i + 1}.md` });
    });
    fake.script.onStart = writeAll;
    const { runId } = await startReview(t, matterId, docs);
    await finish(t);
    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run).toMatchObject({ status: 'succeeded', driveDir: `/Lumen/Walled/m1/Runs/${runId}` });
    expect(fake.created.map((c) => c.agent)).toEqual(['lumen-m-m1']);
    const input = inputOf(fake.sessions[0]) as Input & Record<string, string>;
    expect(input.batch_dir.startsWith(`/drives/m1/Runs/${runId}/`)).toBe(true);
    expect(input.matter_dir).toBe('/drives/m1');
    expect([...fake.drive.keys()].some((k) => k.startsWith('/Lumen/Firms/'))).toBe(false);
  });

  test('a restricted matter whose folder is moving starts no run', async () => {
    const { t, matterId, docs } = await world(1);
    await t.run((ctx) => ctx.db.patch(matterId, { visibility: 'restricted', folderMoving: true }));
    const { runId } = await startReview(t, matterId, docs);
    await finish(t);
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({ status: 'failed' });
    expect(fake.created).toEqual([]);
  });
});

describe('run engine: fan-out, validation, repair, nudge, relaunch, limits', () => {
  test('a 6-document review fans out into 2 batches, fills 48 cells with verified citations, and succeeds', async () => {
    const { t, matterId, docs } = await world(6);
    fake.script.onStart = writeAll;
    const { runId, reviewId } = await startReview(t, matterId, docs);
    await finish(t);
    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run?.status).toBe('succeeded');
    expect(fake.sessions.map((s) => s.role)).toEqual(['lumen-extractor', 'lumen-extractor']);
    // Every batch runs on the firm's one agent in the shared project; the role is a kit file the input names.
    const firm = await t.run(async (ctx) => (await ctx.db.query('firms').first())!);
    expect(fake.created).toEqual([1, 2].map(() => ({ projectId: 'proj_shared', agent: `lumen-f-${firm._id}` })));
    const input = inputOf(fake.sessions[0]) as Input & Record<string, string>;
    expect(input.role_path).toBe(`${KIT.dir}/agents/lumen-extractor.md`);
    expect(input.batch_dir.startsWith(`/drives/${firm._id}/Runs/`)).toBe(true);
    expect(input.matter_dir).toBe(`/drives/${firm._id}/Matters/m1`);
    expect(fake.sessions.map((s) => inputOf(s).documents.length)).toEqual([4, 2]);
    const cells = await t.run((ctx) => ctx.db.query('reviewCells').withIndex('by_review', (q) => q.eq('reviewId', reviewId)).collect());
    expect(cells).toHaveLength(48);
    expect(cells.every((c) => c.state === 'filled' && c.citations[0]?.status === 'verified')).toBe(true);
    expect(fake.stopped.sort()).toEqual(['sess_1', 'sess_2']);
    const events = await t.run((ctx) => ctx.db.query('runEvents').withIndex('by_run', (q) => q.eq('runId', runId)).collect());
    expect(events.filter((e) => e.type === 'row')).toHaveLength(6);
  });

  test('an invalid row is rejected and repaired by a prompt on the same session', async () => {
    const { t, matterId, docs } = await world(2);
    fake.script.onStart = (s) => {
      const input = inputOf(s);
      fake.write(`${dirOf(s)}/out/rows/${input.documents[0].doc_id}.json`, goodRow(input.documents[0].doc_id, input.columns, 1, { confidence: 'certain' }));
      fake.write(`${dirOf(s)}/out/rows/${input.documents[1].doc_id}.json`, goodRow(input.documents[1].doc_id, input.columns, 2));
      fake.write(`${dirOf(s)}/done.json`, { status: 'succeeded', outputs: [] });
    };
    fake.script.onSend = (s, text) => {
      expect(text).toContain('confidence');
      writeAll(s);
    };
    const { runId } = await startReview(t, matterId, docs);
    await finish(t);
    const batch = await t.run((ctx) => ctx.db.query('runBatches').withIndex('by_run', (q) => q.eq('runId', runId)).first());
    expect(batch).toMatchObject({ status: 'succeeded', attempts: { repair: 1, nudge: 0, relaunch: 0 } });
    expect(fake.sessions).toHaveLength(1);
  });

  test('an idle session with results missing is nudged, then finishes', async () => {
    const { t, matterId, docs } = await world(1);
    fake.script.turn = idleNow;
    fake.script.onSend = writeAll;
    const { runId } = await startReview(t, matterId, docs);
    await finish(t);
    const batch = await t.run((ctx) => ctx.db.query('runBatches').withIndex('by_run', (q) => q.eq('runId', runId)).first());
    expect(batch).toMatchObject({ status: 'succeeded', attempts: { repair: 0, nudge: 1, relaunch: 0 } });
    expect(fake.sessions[0].sends[0]).toContain('You stopped before the batch was finished');
  });

  test('a failed session is replaced once by a new session', async () => {
    const { t, matterId, docs } = await world(1);
    fake.script.turn = (s) =>
      s.id === 'sess_1'
        ? { turns: [], last_ended: { ended_at: new Date(Date.now()).toISOString(), end_reason: 'error', error: { name: 'SandboxLost', message: 'gone' } } }
        : { turns: [{}] };
    fake.script.onStart = (s) => s.id === 'sess_2' && writeAll(s);
    const { runId } = await startReview(t, matterId, docs);
    await finish(t);
    const batch = await t.run((ctx) => ctx.db.query('runBatches').withIndex('by_run', (q) => q.eq('runId', runId)).first());
    expect(batch).toMatchObject({ status: 'succeeded', kortixSessionId: 'sess_2', attempts: { relaunch: 1 } });
    expect(fake.stopped).toContain('sess_1');
  });

  test('a batch that never finishes uses its 2 nudges, fails, and the run ends partial with its cells marked', async () => {
    const { t, matterId, docs } = await world(5);
    fake.script.turn = idleNow;
    // Batch 1 (4 documents) works; batch 2 (1 document) never writes anything.
    fake.script.onStart = (s) => inputOf(s).documents.length === 4 && writeAll(s);
    const { runId, reviewId } = await startReview(t, matterId, docs);
    await finish(t);
    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run).toMatchObject({ status: 'partial', error: '1 of 2 batches failed' });
    const batches = await t.run((ctx) => ctx.db.query('runBatches').withIndex('by_run', (q) => q.eq('runId', runId)).collect());
    expect(batches[1]).toMatchObject({ status: 'failed', attempts: { nudge: 2 } });
    expect(batches[1].error).toContain('stopped before finishing');
    const cells = await t.run((ctx) => ctx.db.query('reviewCells').withIndex('by_review', (q) => q.eq('reviewId', reviewId)).collect());
    expect(cells.filter((c) => c.documentId === docs[4]).every((c) => c.state === 'error')).toBe(true);
    expect(cells.filter((c) => c.documentId !== docs[4]).every((c) => c.state === 'filled')).toBe(true);
  });
});

describe('watchdog: an interrupted action never leaves a run stuck', () => {
  test('a run stuck in preparing (its action died) fails after 10 min with an audit row, and Retry runs it to success', async () => {
    const { t, owner, matterId, docs } = await world(2);
    docs.forEach((d, i) => docIndex.set(d, i + 1));
    const { runId } = await owner.as.mutation(api.runs.startReview, { matterId });
    // The prepare action is lost (a backend restart): the run sits in preparing with pending batches.
    await t.run(async (ctx) => {
      for (const f of await ctx.db.system.query('_scheduled_functions').collect()) await ctx.scheduler.cancel(f._id);
      await ctx.db.patch(runId, { status: 'preparing' });
    });
    expect(await t.mutation(internal.runs.sweep, {})).toEqual({ failedRuns: 0, failedBatches: 0, rescheduled: 0 });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await t.mutation(internal.runs.sweep, {})).toMatchObject({ failedRuns: 1 });
    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run).toMatchObject({ status: 'failed', error: 'The run stopped while it was starting. Retry it.' });
    const batches = await t.run((ctx) => ctx.db.query('runBatches').withIndex('by_run', (q) => q.eq('runId', runId)).collect());
    expect(batches.every((b) => b.status === 'failed')).toBe(true);
    const audit = await t.run((ctx) => ctx.db.query('auditEvents').collect());
    expect(audit.some((a) => a.action === 'run.finish' && a.detail?.endsWith(': failed'))).toBe(true);
    fake.script.onStart = writeAll;
    await owner.as.mutation(api.runs.retryFailed, { runId });
    await finish(t);
    expect((await t.run((ctx) => ctx.db.get(runId)))?.status).toBe('succeeded');
  });

  test('a batch stuck in starting fails; a working batch with a dead poll chain fails past 25 min', async () => {
    const { t, owner, matterId } = await world(5);
    const { runId } = await owner.as.mutation(api.runs.startReview, { matterId });
    const [b1, b2] = await t.run(async (ctx) => {
      for (const f of await ctx.db.system.query('_scheduled_functions').collect()) await ctx.scheduler.cancel(f._id);
      await ctx.db.patch(runId, { status: 'running', startedAt: Date.now() });
      const bs = await ctx.db.query('runBatches').withIndex('by_run', (q) => q.eq('runId', runId)).collect();
      await ctx.db.patch(bs[0]._id, { status: 'starting' });
      await ctx.db.patch(bs[1]._id, { status: 'working', kortixSessionId: 'sess_x', startedAt: Date.now(), lastProgressAt: Date.now() });
      return bs.map((b) => b._id);
    });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await t.mutation(internal.runs.sweep, {})).toMatchObject({ failedRuns: 0, failedBatches: 1 });
    await finish(t);
    vi.setSystemTime(Date.now() + 15 * 60_000);
    expect(await t.mutation(internal.runs.sweep, {})).toMatchObject({ failedBatches: 1 });
    await finish(t);
    const got = await t.run(async (ctx) => [await ctx.db.get(b1), await ctx.db.get(b2), await ctx.db.get(runId)]);
    expect(got[0]).toMatchObject({ status: 'failed', error: 'The workspace could not start' });
    expect(got[1]).toMatchObject({ status: 'failed', error: 'No progress for 20 minutes' });
    expect(got[2]?.status).toBe('failed');
  });
});

describe('concurrency', () => {
  test('10 one-batch runs in one firm: 8 run at once, the 2 waiting runs start when slots free', async () => {
    const { t, matterId, docs } = await world(1);
    docs.forEach((d, i) => docIndex.set(d, i + 1));
    let peak = 0;
    fake.script.onStart = (s) => {
      // Sessions alive now: started and not yet stopped (a settled batch stops its session).
      peak = Math.max(peak, fake.sessions.length - fake.stopped.length);
      fake.write(`${dirOf(s)}/out/answer.json`, { schema: 'answer/1', question: 'q', addressed: false, answer_md: 'The documents in this matter do not address this.', citations: [] });
      fake.write(`${dirOf(s)}/done.json`, { status: 'succeeded', outputs: [] });
    };
    const runIds: Id<'runs'>[] = [];
    for (let i = 0; i < 10; i++) runIds.push(await t.mutation(internal.runs.askAsOwner, { matterId, question: `Question ${i}?` }));
    await finish(t);
    const statuses = await t.run(async (ctx) => Promise.all(runIds.map(async (id) => (await ctx.db.get(id))?.status)));
    expect(statuses).toEqual(Array(10).fill('succeeded'));
    expect(fake.sessions).toHaveLength(10);
    expect(peak).toBeLessThanOrEqual(8);
  });
});

describe('citations, human work, cancel', () => {
  test('Convex is the authority: verified, relocated (anchor corrected) and unverified (needs review)', async () => {
    const { t, matterId, docs } = await world(1);
    await t.run((ctx) => ctx.db.insert('documentParas', { documentId: docs[0], matterId, page: 2, para: 2, text: 'A second paragraph about governing law.' }));
    const { runId, reviewId } = await startReview(t, matterId, docs);
    const batch = (await t.run((ctx) => ctx.db.query('runBatches').withIndex('by_run', (q) => q.eq('runId', runId)).first()))!;
    await t.run((ctx) => ctx.db.patch(batch._id, { status: 'working' }));
    const row = goodRow(docs[0], [{ key: 'parties' }, { key: 'term' }, { key: 'auto_renewal' }, { key: 'termination_convenience' },
      { key: 'liability_cap' }, { key: 'governing_law' }, { key: 'assignment' }, { key: 'change_of_control' }], 1);
    row.cells.governing_law.citations = [{ doc_id: docs[0], a: 'p1.1', quote: 'about governing law' }];
    row.cells.term.citations = [{ doc_id: docs[0], a: 'p1.1', quote: 'a quote the document does not contain' }];
    (row.cells.liability_cap as Record<string, unknown>) = { value: null, not_found: true, note: 'No cap clause.', confidence: 'high', citations: [] };
    expect(await t.mutation(internal.runs.ingestResult, { batchId: batch._id, path: 'out/rows/x.json', version: '1', value: row })).toEqual([]);
    const cells = await t.run((ctx) => ctx.db.query('reviewCells').withIndex('by_review', (q) => q.eq('reviewId', reviewId)).collect());
    const by = (k: string) => cells.find((c) => c.columnKey === k)!;
    expect(by('parties')).toMatchObject({ state: 'filled', citations: [{ status: 'verified', page: 1, para: 1 }] });
    expect(by('governing_law')).toMatchObject({ state: 'filled', citations: [{ status: 'relocated', page: 2, para: 2 }] });
    expect(by('term')).toMatchObject({ state: 'needs_review', citations: [{ status: 'unverified' }] });
    expect(by('liability_cap')).toMatchObject({ state: 'not_found', citations: [] });
    // A row for a document outside the batch is refused.
    expect(await t.mutation(internal.runs.ingestResult, { batchId: batch._id, path: 'out/rows/y.json', version: '1', value: { ...row, doc_id: 'nope' } }))
      .toEqual(['doc_id nope is not a document of this batch']);

    // A verified or edited cell keeps its value; the new AI answer is kept beside it.
    await t.run((ctx) => ctx.db.patch(by('parties')._id, { reviewStatus: 'verified' }));
    await t.run((ctx) => ctx.db.patch(by('assignment')._id, { editedValue: 'Edited by a lawyer' }));
    row.cells.parties.value = 'a newer AI answer';
    row.cells.assignment.value = 'another AI answer';
    await t.mutation(internal.runs.ingestResult, { batchId: batch._id, path: 'out/rows/x.json', version: '2', value: row });
    const after = await t.run((ctx) => ctx.db.query('reviewCells').withIndex('by_review', (q) => q.eq('reviewId', reviewId)).collect());
    expect(after.find((c) => c.columnKey === 'parties')).toMatchObject({ value: 'answer parties', aiValue: 'a newer AI answer' });
    expect(after.find((c) => c.columnKey === 'assignment')).toMatchObject({ editedValue: 'Edited by a lawyer', aiValue: 'another AI answer' });
  });

  test('an ask run stores a checked answer', async () => {
    const { t, matterId, docs } = await world(2);
    docs.forEach((d, i) => docIndex.set(d, i + 1));
    fake.script.onStart = (s) => {
      fake.write(`${dirOf(s)}/out/answer.json`, {
        schema: 'answer/1', question: 'q', addressed: false, answer_md: 'The documents in this matter do not address this.',
        citations: [{ doc_id: docs[1], a: 'p1.1', quote: 'The clause of document 2' }],
      });
      fake.write(`${dirOf(s)}/done.json`, { status: 'succeeded', outputs: ['out/answer.json'] });
    };
    const runId = await t.mutation(internal.runs.askAsOwner, { matterId, question: 'What rent does it set?' });
    await finish(t);
    expect((await t.run((ctx) => ctx.db.get(runId)))?.status).toBe('succeeded');
    expect(fake.sessions[0].role).toBe('lumen-counsel');
    const answer = await t.run((ctx) => ctx.db.query('answers').withIndex('by_run', (q) => q.eq('runId', runId)).first());
    expect(answer).toMatchObject({ addressed: false, citations: [{ documentId: docs[1], status: 'verified' }] });
  });

  test('a member cancels: the run and its batches stop, their sessions are stopped, a stranger cannot', async () => {
    const { t, owner, matterId, docs } = await world(2);
    const { runId } = await owner.as.mutation(api.runs.startReview, { matterId });
    await t.run(async (ctx) => {
      for (const b of await ctx.db.query('runBatches').withIndex('by_run', (q) => q.eq('runId', runId)).collect()) {
        await ctx.db.patch(b._id, { status: 'working', kortixSessionId: 'sess_live' });
      }
      await ctx.db.patch(runId, { status: 'running' });
    });
    const stranger = await signedInUser(t, 'stranger@example.com');
    await expect(stranger.as.mutation(api.runs.cancel, { runId })).rejects.toThrow(/403/);
    await owner.as.mutation(api.runs.cancel, { runId });
    await finish(t);
    expect((await t.run((ctx) => ctx.db.get(runId)))?.status).toBe('canceled');
    const batches = await t.run((ctx) => ctx.db.query('runBatches').withIndex('by_run', (q) => q.eq('runId', runId)).collect());
    expect(batches.every((b) => b.status === 'canceled')).toBe(true);
    expect(fake.stopped).toEqual(['sess_live']);
    expect(docs).toHaveLength(2);
  });
});

const PLAYBOOK = '# Example playbook\n\n## Rule NDA-01: Confidentiality term\nPosition: at most 3 years.\nFallback: none.\nSeverity if missed: high\n';
const TEMPLATE = '# Mutual NDA\n\nMade on {{effective_date}} between {{party_a}} and {{party_b}}, governed by {{governing_law}}.\n';

async function libraryOf(t: T, firmId: Id<'firms'>) {
  return t.run(async (ctx) => ({
    playbookId: await ctx.db.insert('libraryItems', { firmId, kind: 'playbook', name: 'Example playbook', body: PLAYBOOK, updatedBy: 'u', updatedAt: 0 }),
    templateId: await ctx.db.insert('libraryItems', { firmId, kind: 'template', name: 'Mutual NDA', body: TEMPLATE, updatedBy: 'u', updatedAt: 0 }),
  }));
}

const issuesJson = (docId: string) => ({
  schema: 'issues/1', doc_id: docId, playbook: 'Example playbook', perspective: 'Brightwater', summary: 'One high-severity deviation.',
  issues: [{
    rule_id: 'NDA-01', title: 'Confidentiality term', status: 'deviates', severity: 'high', finding: 'Clause 1.1 sets 7 years; the maximum is 3.',
    redline: { a: 'p1.1', from: 'every column', to: 'three years', comment: 'Rule NDA-01: max 3 years.' },
    citations: [{ doc_id: docId, a: 'p1.1', quote: 'The clause of document 1' }],
  }],
  unmatched: [{ title: 'Odd clause', finding: 'Favours the counterparty.', citations: [{ doc_id: docId, a: 'p1.1', quote: 'not in the source' }] }],
  files: ['redline.docx'],
});

describe('workflows: contract review, due diligence, draft', () => {
  test('contract review: the playbook is copied into the run, issues are checked, redline.docx lands in Lumen storage, decisions are audited', async () => {
    const { t, owner, firmId, matterId, docs } = await world(1);
    const { playbookId } = await libraryOf(t, firmId);
    fake.script.onStart = (s) => {
      fake.write(`${dirOf(s)}/out/redline.docx`, 'PK fake docx');
      fake.write(`${dirOf(s)}/out/issues.json`, issuesJson(docs[0]));
      fake.write(`${dirOf(s)}/done.json`, { status: 'succeeded', outputs: [] });
    };
    const runId = await owner.as.mutation(api.workflows.startContractReview, { matterId, documentId: docs[0], playbookId });
    await finish(t);
    expect((await t.run((ctx) => ctx.db.get(runId)))?.status).toBe('succeeded');
    const s = fake.sessions[0];
    expect(s.role).toBe('lumen-reviewer');
    const input = JSON.parse(fake.drive.get(s.inputPath)!.data);
    expect(input).toMatchObject({ kind: 'contract_review', perspective: 'Brightwater Example Holdings' });
    expect(input.playbook_path).toMatch(/^\/drives\/[a-z0-9]+\/Runs\/.+\/in\/playbook\.md$/);
    expect(fake.drive.get(`${dirOf(s)}/in/playbook.md`)!.data).toBe(PLAYBOOK);
    const view = await owner.as.query(api.runs.get, { runId });
    expect(view!.issues.map((i) => [i.ruleId, i.assessment, i.severity, i.citations[0].status])).toEqual([
      ['NDA-01', 'deviates', 'high', 'verified'], ['unmatched', 'unmatched', 'medium', 'unverified'],
    ]);
    expect(view!.result).toMatchObject({ kind: 'issues', summary: 'One high-severity deviation.', files: [{ name: 'redline.docx', bytes: 12 }] });
    const bytes = await owner.as.action(api.workflows.fileBytes, { runId, name: 'redline.docx' });
    expect(new TextDecoder().decode(bytes)).toBe('PK fake docx');
    const stranger = await signedInUser(t, 'stranger@example.com');
    await expect(stranger.as.action(api.workflows.fileBytes, { runId, name: 'redline.docx' })).rejects.toThrow(/403/);
    await owner.as.mutation(api.workflows.decideIssue, { issueId: view!.issues[0]._id, decision: 'accepted' });
    const audit = await t.run((ctx) => ctx.db.query('auditEvents').collect());
    expect(audit.map((e) => e.action)).toContain('issue.accept');
  });

  test('contract review: a result whose redline.docx never reaches Drive is repaired with a prompt that names the file', async () => {
    const { t, firmId, matterId, docs } = await world(1);
    const { playbookId } = await libraryOf(t, firmId);
    fake.script.onStart = (s) => {
      fake.write(`${dirOf(s)}/out/issues.json`, issuesJson(docs[0]));
      fake.write(`${dirOf(s)}/done.json`, { status: 'succeeded', outputs: [] });
    };
    fake.script.onSend = (s, text) => {
      expect(text).toContain('redline.docx');
      fake.write(`${dirOf(s)}/out/redline.docx`, 'PK late');
    };
    const runId = await t.mutation(internal.workflows.startContractReviewAsOwner, { matterId, documentId: docs[0], playbookId });
    await finish(t);
    const batch = await t.run((ctx) => ctx.db.query('runBatches').withIndex('by_run', (q) => q.eq('runId', runId)).first());
    expect(batch).toMatchObject({ status: 'succeeded', attempts: { repair: 1 } });
  });

  test('contract review: a summary that names a working file is sent back before a lawyer sees it', async () => {
    const { t, owner, firmId, matterId, docs } = await world(1);
    const { playbookId } = await libraryOf(t, firmId);
    fake.script.onStart = (s) => {
      fake.write(`${dirOf(s)}/out/redline.docx`, 'PK fake docx');
      fake.write(`${dirOf(s)}/out/issues.json`, { ...issuesJson(docs[0]), summary: 'One high-severity deviation. The redline is at out/redline.docx.' });
      fake.write(`${dirOf(s)}/done.json`, { status: 'succeeded', outputs: [] });
    };
    const prompts: string[] = [];
    fake.script.onSend = (s, text) => {
      prompts.push(text);
      fake.write(`${dirOf(s)}/out/issues.json`, issuesJson(docs[0]));
    };
    const runId = await owner.as.mutation(api.workflows.startContractReview, { matterId, documentId: docs[0], playbookId });
    await finish(t);
    expect(prompts.join("\n")).toContain('"summary" names the working file "out/redline.docx"');
    const view = await owner.as.query(api.runs.get, { runId });
    expect(view!.result).toMatchObject({ kind: 'issues', summary: 'One high-severity deviation.' });
  });

  test('due diligence: map batches fill the checklist, then one reduce batch gets the checked rows and writes a cited report', async () => {
    const { t, owner, matterId, docs } = await world(5);
    docs.forEach((d, i) => docIndex.set(d, i + 1));
    let mapsDoneAtReduce = -1;
    fake.script.onStart = (s) => {
      if (s.role === 'lumen-extractor') return writeAll(s);
      mapsDoneAtReduce = fake.stopped.length;
      const input = JSON.parse(fake.drive.get(s.inputPath)!.data);
      expect(input).toMatchObject({ kind: 'diligence_reduce' });
      expect(input.columns).toBeUndefined();
      const rows = [...fake.drive.keys()].filter((p) => p.startsWith(`${dirOf(s)}/in/rows/`));
      expect(rows).toHaveLength(5);
      const row = JSON.parse(fake.drive.get(rows[0])!.data);
      expect(row.cells.doc_type).toMatchObject({ label: 'Type', citations: [{ a: 'p1.1' }] });
      fake.write(`${dirOf(s)}/out/report.json`, {
        schema: 'diligence-report/1',
        sections: [{ heading: 'Overview', body_md: 'Five agreements.', citations: [{ doc_id: docs[0], a: 'p1.1', quote: 'The clause of document 1' }] }],
        red_flags: [{ title: 'Uncapped liability', severity: 'high', doc_id: docs[2], citations: [{ doc_id: docs[2], a: 'p1.1', quote: 'The clause of document 3' }] }],
      });
      fake.write(`${dirOf(s)}/done.json`, { status: 'succeeded', outputs: [] });
    };
    const runId = await owner.as.mutation(api.workflows.startDiligence, { matterId });
    await finish(t);
    expect((await t.run((ctx) => ctx.db.get(runId)))?.status).toBe('succeeded');
    expect(fake.sessions.map((s) => s.role)).toEqual(['lumen-extractor', 'lumen-extractor', 'lumen-counsel']);
    expect(mapsDoneAtReduce).toBe(2);
    const view = await owner.as.query(api.runs.get, { runId });
    expect(view!.result).toMatchObject({
      kind: 'report', sections: [{ heading: 'Overview', citations: [{ status: 'verified' }] }],
      redFlags: [{ title: 'Uncapped liability', filename: 'doc-3.pdf', citations: [{ status: 'verified' }] }],
    });
    expect(view!.cells).toHaveLength(5 * 8);
  });

  test('draft: unknown fields are dropped, the template is copied, draft.json + draft.docx are stored', async () => {
    const { t, owner, firmId, matterId } = await world(0);
    const { templateId } = await libraryOf(t, firmId);
    fake.script.onStart = (s) => {
      const input = JSON.parse(fake.drive.get(s.inputPath)!.data);
      expect(input.fields).toEqual({ party_a: 'Alpha Example Ltd', party_b: 'Beta Example Inc.' });
      expect(fake.drive.get(`${dirOf(s)}/in/template.md`)!.data).toBe(TEMPLATE);
      fake.write(`${dirOf(s)}/out/draft.docx`, 'PK draft');
      fake.write(`${dirOf(s)}/out/draft.json`, {
        schema: 'draft/1', title: 'Mutual NDA', markdown: '# Mutual NDA\n\nMade on [[CONFIRM: effective_date]] between Alpha Example Ltd and Beta Example Inc., governed by [[CONFIRM: governing_law]].',
        unfilled: ['effective_date', 'governing_law'], citations: [], files: ['draft.docx'],
      });
      fake.write(`${dirOf(s)}/done.json`, { status: 'succeeded', outputs: [] });
    };
    const runId = await owner.as.mutation(api.workflows.startDraft, {
      matterId, templateId, fields: { party_a: 'Alpha Example Ltd', party_b: 'Beta Example Inc.', evil: 'x', governing_law: '  ' },
    });
    await finish(t);
    expect(fake.sessions[0].role).toBe('lumen-drafter');
    const view = await owner.as.query(api.runs.get, { runId });
    expect(view!.run.status).toBe('succeeded');
    expect(view!.result).toMatchObject({ kind: 'draft', unfilled: ['effective_date', 'governing_law'], files: [{ name: 'draft.docx' }] });
  });
});

test('draft: a field with no value and no source document must stay a [[CONFIRM]] marker, or the draft is repaired', async () => {
  const { t, firmId, matterId } = await world(0);
  const { templateId } = await libraryOf(t, firmId);
  const draft = (md: string, unfilled: string[]) => ({ schema: 'draft/1', title: 'Mutual NDA', markdown: md, unfilled, citations: [], files: ['draft.docx'] });
  fake.script.onStart = (s) => {
    fake.write(`${dirOf(s)}/out/draft.docx`, 'PK');
    // The agent invents a governing law it was never given.
    fake.write(`${dirOf(s)}/out/draft.json`, draft('Made on 2026-10-20 between A and B, governed by Novaria.', []));
    fake.write(`${dirOf(s)}/done.json`, { status: 'succeeded', outputs: [] });
  };
  fake.script.onSend = (s, text) => {
    expect(text).toContain('governing_law is not in "fields"');
    fake.write(`${dirOf(s)}/out/draft.json`, draft('Made on 2026-10-20 between A and B, governed by [[CONFIRM: governing_law]].', ['governing_law']));
  };
  const runId = await t.mutation(internal.workflows.startDraftAsOwner, {
    matterId, templateId, fields: { party_a: 'A', party_b: 'B', effective_date: '2026-10-20' },
  });
  await finish(t);
  const batch = await t.run((ctx) => ctx.db.query('runBatches').withIndex('by_run', (q) => q.eq('runId', runId)).first());
  expect(batch).toMatchObject({ status: 'succeeded', attempts: { repair: 1 } });
  const result = await t.run((ctx) => ctx.db.query('runResults').withIndex('by_run', (q) => q.eq('runId', runId)).first());
  expect(result?.unfilled).toEqual(['governing_law']);
});

describe('reviews: add a column, re-run a column, lawyer decisions', () => {
  test('a new column runs alone; a re-run keeps verified and edited cells; every decision is audited', async () => {
    const { t, owner, matterId, docs } = await world(2);
    docs.forEach((d, i) => docIndex.set(d, i + 1));
    fake.script.onStart = writeAll;
    const { reviewId } = await owner.as.mutation(api.reviews.create, { matterId });
    await finish(t);

    await owner.as.mutation(api.reviews.setCell, { reviewId, documentId: docs[0], columnKey: 'term', action: 'verify' });
    await owner.as.mutation(api.reviews.setCell, { reviewId, documentId: docs[1], columnKey: 'term', action: 'edit', value: 'Five years' });

    const before = fake.sessions.length;
    const colRun = await owner.as.mutation(api.reviews.addColumns, {
      reviewId, columns: [{ key: 'non_solicit', label: 'Non-solicit', prompt: 'Is there a non-solicitation clause?', format: 'yes_no' }],
    });
    await finish(t);
    expect(inputOf(fake.sessions[before]).columns.map((c) => c.key)).toEqual(['non_solicit']);
    expect((await t.run((ctx) => ctx.db.get(colRun)))).toMatchObject({ kind: 'column', status: 'succeeded', columnKeys: ['non_solicit'] });

    await owner.as.mutation(api.reviews.rerunColumn, { reviewId, columnKey: 'term' });
    await finish(t);
    const view = (await owner.as.query(api.reviews.get, { reviewId }))!;
    expect(view.columns).toHaveLength(9);
    expect(view.cells.filter((c) => c.state === 'filled')).toHaveLength(18);
    const term = (d: Id<'documents'>) => view.cells.find((c) => c.columnKey === 'term' && c.documentId === d)!;
    expect(term(docs[0])).toMatchObject({ reviewStatus: 'verified', value: 'answer term', aiValue: 'answer term' });
    expect(term(docs[1])).toMatchObject({ edited: true, value: 'Five years' });
    const actions = (await t.run((ctx) => ctx.db.query('auditEvents').collect())).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['cell.verify', 'cell.edit']));

    // One run at a time per review.
    await owner.as.mutation(api.reviews.rerunColumn, { reviewId, columnKey: 'parties' });
    await expect(owner.as.mutation(api.reviews.rerunColumn, { reviewId, columnKey: 'term' })).rejects.toThrow(/409/);
  });
});
