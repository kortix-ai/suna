import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { KIT } from '../../convex/kit/bundle.generated';
import { promptFor } from '../../convex/lib/columns';
import { addMember, lumenTest, org, signedInUser } from './setup';

// Firm workflows, review column edits and document versions. No Kortix call
// runs: fake timers hold every scheduled function (ingest, the run engine).
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function world() {
  const t = lumenTest();
  const orgId = await org(t, 'Example Co');
  const owner = await signedInUser(t, 'owner@example.test');
  const lawyer = await signedInUser(t, 'lawyer@example.test');
  const other = await signedInUser(t, 'other@example.test');
  await addMember(t, orgId, owner.userId, 'owner');
  await addMember(t, orgId, lawyer.userId, 'member');
  await addMember(t, orgId, other.userId, 'member');
  const w = await t.run(async (ctx) => {
    await ctx.db.insert('deployment', { key: 'default', status: 'ready', projectId: 'p', accountId: 'a', driveId: 'd', kitVersion: KIT.version, kitHash: KIT.hash });
    const firmId = await ctx.db.insert('firms', {
      orgId, name: 'Example Legal', practiceTags: [], sizeBand: '2-10', status: 'ready', plan: 'trial', seats: 5, billingStatus: 'none', createdBy: owner.userId,
    });
    const matterId = await ctx.db.insert('matters', {
      firmId, name: 'Project Aster', client: 'Brightwater Example', parties: [], status: 'open', visibility: 'firm',
      driveFolder: `/Lumen/Firms/${firmId}/Matters/m1`, createdBy: owner.userId, updatedAt: 0,
    });
    return { firmId, matterId };
  });
  return { t, owner, lawyer, other, ...w };
}

async function readyDoc(t: ReturnType<typeof lumenTest>, firmId: Id<'firms'>, matterId: Id<'matters'>, name: string, extra: Record<string, unknown> = {}) {
  return t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(['x']));
    const id = await ctx.db.insert('documents', {
      firmId, matterId, storageId, filename: name, mime: 'application/pdf', bytes: 1, status: 'ready', pages: 1, paras: 1,
      driveFile: `x/${name}`, textFile: `x/${name}.md`, uploadedBy: 'u', ...extra,
    });
    await ctx.db.insert('documentParas', { documentId: id, matterId, page: 1, para: 1, text: 'clause' });
    return id;
  });
}

describe('firm workflows', () => {
  test('a private workflow is visible to its author only; a firm workflow to everyone, edited by author or admin', async () => {
    const { owner, lawyer, other, firmId } = await world();
    const priv = await lawyer.as.mutation(api.customWorkflows.save, {
      firmId, type: 'assistant', name: 'Chronology', prompt: 'Build a dated chronology with a citation per line.', visibility: 'private',
    });
    const shared = await lawyer.as.mutation(api.customWorkflows.save, {
      firmId, type: 'tabular', name: 'Lease terms', visibility: 'firm',
      columns: [{ key: 'rent', label: 'Rent', prompt: 'What is the annual rent?', format: 'money' }],
    });
    expect((await lawyer.as.query(api.customWorkflows.list, { firmId })).map((w) => w.name).sort()).toEqual(['Chronology', 'Lease terms']);
    const seen = await other.as.query(api.customWorkflows.list, { firmId });
    expect(seen.map((w) => [w.name, w.canEdit])).toEqual([['Lease terms', false]]);
    // A plain member cannot edit someone else's shared workflow; the owner (an admin) can.
    await expect(other.as.mutation(api.customWorkflows.save, { workflowId: shared, firmId, type: 'tabular', name: 'X', visibility: 'firm', columns: [{ key: 'a', label: 'A', prompt: 'Why?', format: 'text' }] })).rejects.toThrow('403');
    await owner.as.mutation(api.customWorkflows.save, { workflowId: shared, firmId, type: 'tabular', name: 'Lease key terms', visibility: 'firm', columns: [{ key: 'rent', label: 'Rent', prompt: 'What is the annual rent?', format: 'money' }] });
    // A private workflow does not exist for anyone else, the owner included.
    await expect(owner.as.mutation(api.customWorkflows.remove, { workflowId: priv })).rejects.toThrow('404');
    await lawyer.as.mutation(api.customWorkflows.remove, { workflowId: priv });
    expect((await lawyer.as.query(api.customWorkflows.list, { firmId })).map((w) => w.name)).toEqual(['Lease key terms']);
  });

  test('an assistant workflow needs instructions; a tabular one needs valid columns', async () => {
    const { lawyer, firmId } = await world();
    await expect(lawyer.as.mutation(api.customWorkflows.save, { firmId, type: 'assistant', name: 'Empty', prompt: 'short', visibility: 'private' })).rejects.toThrow('400');
    await expect(lawyer.as.mutation(api.customWorkflows.save, { firmId, type: 'tabular', name: 'Bad', columns: [], visibility: 'private' })).rejects.toThrow('400');
  });

  test('"Write it for me" uses the clause library question, or a generic one for the format', () => {
    expect(promptFor('Governing law', 'text')).toBe('Which law governs the agreement?');
    expect(promptFor('Break fee', 'money')).toBe('What does the agreement provide on break fee? Give the amount and the currency. If the agreement is silent, say so.');
  });
});

describe('review columns', () => {
  test('a label edit keeps answers; a question edit re-runs the column but keeps verified cells; delete removes cells', async () => {
    const { t, owner, firmId, matterId } = await world();
    const d1 = await readyDoc(t, firmId, matterId, 'a.pdf');
    const d2 = await readyDoc(t, firmId, matterId, 'b.pdf');
    const { reviewId, runId } = await owner.as.mutation(api.reviews.create, {
      matterId, title: 'Terms', columns: [
        { key: 'law', label: 'Law', prompt: 'Which law governs?', format: 'text' },
        { key: 'cap', label: 'Cap', prompt: 'Is liability capped?', format: 'text' },
      ],
    });
    // The first run finished: both cells answered, one verified by a lawyer.
    await t.run(async (ctx) => {
      await ctx.db.patch(runId, { status: 'succeeded' });
      for (const c of await ctx.db.query('reviewCells').withIndex('by_review', (q) => q.eq('reviewId', reviewId)).collect()) {
        await ctx.db.patch(c._id, { state: 'filled', value: 'England', reviewStatus: c.documentId === d1 && c.columnKey === 'law' ? 'verified' : 'none' });
      }
    });
    expect(await owner.as.mutation(api.reviews.editColumn, { reviewId, columnKey: 'law', label: 'Governing law', prompt: 'Which law governs?', format: 'text' })).toBeNull();
    const rerun = await owner.as.mutation(api.reviews.editColumn, { reviewId, columnKey: 'law', label: 'Governing law', prompt: 'Which law governs the agreement?', format: 'tag', options: ['England', 'New York'] });
    expect(rerun).not.toBeNull();
    const cells = await t.run((ctx) => ctx.db.query('reviewCells').withIndex('by_review', (q) => q.eq('reviewId', reviewId)).collect());
    const law = (doc: Id<'documents'>) => cells.find((c) => c.documentId === doc && c.columnKey === 'law')!;
    expect([law(d1).state, law(d1).value]).toEqual(['filled', 'England']);
    expect([law(d2).state, law(d2).value]).toEqual(['pending', undefined]);
    // A run is filling the column: no second edit until it ends.
    await expect(owner.as.mutation(api.reviews.deleteColumn, { reviewId, columnKey: 'cap' })).rejects.toThrow('409');
    await t.run((ctx) => ctx.db.patch(rerun!, { status: 'succeeded' }));
    await owner.as.mutation(api.reviews.deleteColumn, { reviewId, columnKey: 'cap' });
    const view = await owner.as.query(api.reviews.get, { reviewId });
    expect(view!.columns.map((c) => [c.label, c.format, c.options])).toEqual([['Governing law', 'tag', ['England', 'New York']]]);
    expect(view!.cells.every((c) => c.columnKey === 'law')).toBe(true);
    await expect(owner.as.mutation(api.reviews.deleteColumn, { reviewId, columnKey: 'law' })).rejects.toThrow('400');
  });
});

describe('document versions', () => {
  test('a new version supersedes the old one when it is ready; new work reads the latest, the old stays citable', async () => {
    const { t, owner, firmId, matterId } = await world();
    const v1 = await readyDoc(t, firmId, matterId, 'spa.pdf');
    const v2 = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(['%PDF v2']));
      const firm = (await ctx.db.get(firmId))!;
      const matter = (await ctx.db.get(matterId))!;
      const { insertDocument } = await import('../../convex/documents');
      return insertDocument(ctx, { firm, matter, userId: owner.userId, storageId, filename: 'spa-v2.pdf', versionOf: v1 });
    });
    let docs = (await owner.as.query(api.documents.list, { matterId }))!;
    expect(docs.map((d) => [d.filename, d.version, d.superseded, d.family === v1])).toEqual([
      ['spa-v2.pdf', 2, false, true],
      ['spa.pdf', 1, false, true],
    ]);
    await t.run(async (ctx) => {
      await ctx.db.insert('documentParas', { documentId: v2, matterId, page: 1, para: 1, text: 'clause v2' });
      await ctx.db.patch(v2, { pages: 1, paras: 1 });
    });
    await t.mutation(internal.documents.settle, { documentId: v2, driveFile: 'x/v2.pdf', textFile: 'x/v2.md' });
    docs = (await owner.as.query(api.documents.list, { matterId }))!;
    expect(docs.find((d) => d._id === v1)!.superseded).toBe(true);
    expect((await t.query(internal.documents.matterIndex, { matterId })).map((d) => d.filename)).toEqual(['spa-v2.pdf']);
    // A review with no pick reads the latest version only; an explicit pick may name V1.
    const { reviewId } = await owner.as.mutation(api.reviews.create, { matterId });
    expect((await owner.as.query(api.reviews.get, { reviewId }))!.documents.map((d) => d.filename)).toEqual(['spa-v2.pdf']);
    const old = await owner.as.mutation(api.reviews.create, { matterId, documentIds: [v1] });
    expect((await owner.as.query(api.reviews.get, { reviewId: old.reviewId }))!.documents.map((d) => d.filename)).toEqual(['spa.pdf']);
    // Deleting the latest version makes V1 current again.
    await owner.as.mutation(api.documents.remove, { documentId: v2 });
    docs = (await owner.as.query(api.documents.list, { matterId }))!;
    expect(docs.map((d) => [d.filename, d.superseded])).toEqual([['spa.pdf', false]]);
  });
});

describe('matter visibility and documents', () => {
  test('visibility cannot change while a document is still ingesting (ISO-R2-1); it can once the document is ready', async () => {
    const { t, owner, firmId, matterId } = await world();
    const doc = await readyDoc(t, firmId, matterId, 'race.txt', { status: 'extracting' });
    await expect(owner.as.mutation(api.matters.update, { matterId, visibility: 'restricted' })).rejects.toThrow('409: documents are still being processed');
    expect((await t.run((ctx) => ctx.db.get(matterId)))?.visibility).toBe('firm');
    await t.run((ctx) => ctx.db.patch(doc, { status: 'ready' }));
    await owner.as.mutation(api.matters.update, { matterId, visibility: 'restricted' });
    const m = await t.run((ctx) => ctx.db.get(matterId));
    expect([m?.visibility, m?.folderMoving]).toEqual(['restricted', true]);
  });

  test('the matter document count leaves out earlier versions (PE2E-R2-4, UXR2-4)', async () => {
    const { t, owner, firmId, matterId } = await world();
    await readyDoc(t, firmId, matterId, 'a.pdf');
    await readyDoc(t, firmId, matterId, 'b.pdf', { superseded: true });
    const rows = await owner.as.query(api.matters.list, { firmId });
    expect(rows.find((r) => r._id === matterId)?.documentCount).toBe(1);
  });
});
