import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { KIT } from '../../convex/kit/bundle.generated';
import { addMember, lumenTest, org, signedInUser } from './setup';

// Kortix, faked at the SDK edge: an in-memory Drive and scripted sessions. Each
// test scripts what "the agent" writes when its session starts or is prompted.
type Session = { id: string; agent: string; inputPath: string; sends: string[] };
const fake = vi.hoisted(() => {
  const drive = new Map<string, { data: string; mtime: number }>();
  const sessions: Session[] = [];
  const stopped: string[] = [];
  const script = {
    onStart: (_s: Session) => {},
    onSend: (_s: Session, _text: string) => {},
    turn: (_s: Session): { turns: unknown[]; last_ended?: { ended_at: string; end_reason: string; error?: { name: string; message: string } } } =>
      ({ turns: [{}] }),
  };
  let clock = 0;
  const write = (path: string, value: unknown) => drive.set(path, { data: typeof value === 'string' ? value : JSON.stringify(value), mtime: ++clock });
  return { drive, sessions, stopped, script, write };
});

vi.mock('@kortix/sdk', () => ({
  createProjectSession: async (_pid: string, input: { agent_name: string; initial_prompt: string }) => {
    const inputPath = /Input: (\S+)/.exec(input.initial_prompt)![1].replace('/drives/company', '/Company');
    const s = { id: `sess_${fake.sessions.length + 1}`, agent: input.agent_name, inputPath, sends: [] };
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
  fake.stopped.length = 0;
  fake.script.onStart = () => {};
  fake.script.onSend = () => {};
  fake.script.turn = () => ({ turns: [{}] });
});
afterEach(() => vi.useRealTimers());

const PARA = (i: number) => `${i}.1 The clause of document ${i} that answers every column.`;

/** A ready firm (kit current) with one matter of `n` ready documents, each with one paragraph. */
async function world(n: number) {
  const t = lumenTest();
  const orgId = await org(t, 'Example Co');
  const owner = await signedInUser(t, 'owner@example.com');
  await addMember(t, orgId, owner.userId, 'owner');
  const w = await t.run(async (ctx) => {
    const firmId = await ctx.db.insert('firms', {
      orgId, name: 'Example & Co. Legal', practiceTags: [], sizeBand: '2-10', status: 'ready', kortixProjectId: 'proj_1',
      kortixDriveId: 'drive_1', kitVersion: KIT.version, kitHash: KIT.hash, plan: 'trial', seats: 5, billingStatus: 'none', createdBy: owner.userId,
    });
    const matterId = await ctx.db.insert('matters', {
      firmId, name: 'Project Aster', client: 'Brightwater Example Holdings', parties: [], status: 'open', visibility: 'firm',
      driveFolder: '/Company/Lumen/Matters/m1', createdBy: 'user_owner', updatedAt: 0,
    });
    const docs: Id<'documents'>[] = [];
    for (let i = 1; i <= n; i++) {
      const storageId = await ctx.storage.store(new Blob(['x']));
      const id = await ctx.db.insert('documents', {
        firmId, matterId, storageId, filename: `doc-${i}.pdf`, mime: 'application/pdf', bytes: 1, status: 'ready', pages: 1, paras: 1,
        driveFile: `/Company/Lumen/Matters/m1/Docs/d${i}.pdf`, textFile: `/Company/Lumen/Matters/m1/Text/d${i}.md`, uploadedBy: 'user_owner',
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

describe('run engine: fan-out, validation, repair, nudge, relaunch, limits', () => {
  test('a 6-document review fans out into 2 batches, fills 48 cells with verified citations, and succeeds', async () => {
    const { t, matterId, docs } = await world(6);
    fake.script.onStart = writeAll;
    const { runId, reviewId } = await startReview(t, matterId, docs);
    await finish(t);
    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run?.status).toBe('succeeded');
    expect(fake.sessions.map((s) => s.agent)).toEqual(['lumen-extractor', 'lumen-extractor']);
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
    expect(fake.sessions[0].agent).toBe('lumen-counsel');
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
