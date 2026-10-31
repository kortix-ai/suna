import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import { artifactCommentScreenshotObjects as objects, artifactComments, artifactCommentThreads, artifacts, drives, projects } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { seedProject, removeSeeded, type SeededProject } from '../__tests__/helpers/integration-fixtures';
import { prepareArtifactCommentScreenshot, attachArtifactCommentScreenshot, abandonArtifactCommentScreenshot, cleanupArtifactCommentScreenshots } from './comment-screenshot-objects';
import { screenshotObjectKey } from './comment-screenshot-storage';

describe.skipIf(!process.env.TEST_DATABASE_URL)('screenshot object receipts and uncertain outcomes', () => {
  const seeded: SeededProject[] = [];
  let project: SeededProject, threadId: string, png: string;
  const author = crypto.randomUUID();
  const stored = new Map<string, Uint8Array>();
  let removes = 0, failPut = false, failRemove = false;
  let holdRemove: (() => Promise<void>) | undefined;
  const store = {
    put: async (key: string, image: { bytes: Uint8Array }) => { stored.set(key, image.bytes); if (failPut) throw new Error('Upload outcome unknown'); },
    read: async (key: string) => ({ bytes: stored.get(key)!, mime: 'image/png' as const }),
    remove: async (key: string) => { removes++; if (holdRemove) await holdRemove(); if (failRemove) throw new Error('Transient object outage'); stored.delete(key); },
  };
  beforeEach(async () => {
    removes = 0; failPut = false; failRemove = false; holdRemove = undefined;
    project = await seedProject('screenshot-receipt'); seeded.push(project);
    const [drive] = await db.insert(drives).values({ accountId: project.account_id, projectId: project.project_id, kind: 'project', name: 'Screenshots', platinumVolumeName: `screenshot-${crypto.randomUUID()}` }).returning();
    const [artifact] = await db.insert(artifacts).values({ accountId: project.account_id, projectId: project.project_id, driveId: drive!.driveId, root: 'Screenshots', entry: 'index.html', folder: true, title: 'Screenshot receipt', type: 'html', createdByUserId: author }).returning();
    const [thread] = await db.insert(artifactCommentThreads).values({ artifactId: artifact!.artifactId, projectId: project.project_id, anchor: { type: 'none', version: 'v1' }, anchorVersion: 'v1', createdByUserId: author }).returning();
    threadId = thread!.threadId;
    png = (await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer()).toString('base64');
  });
  afterAll(async () => {
    await removeSeeded(seeded);
    await db.delete(objects).where(inArray(objects.projectId, seeded.map(row => row.project_id)));
    stored.clear();
  });
  async function receipt(key: string) { return (await db.select().from(objects).where(eq(objects.objectKey, key)))[0]; }
  async function attached() {
    const id = crypto.randomUUID();
    const prepared = await prepareArtifactCommentScreenshot(project.project_id, id, png, store);
    await db.transaction(async tx => {
      await tx.insert(artifactComments).values({ commentId: id, threadId, authorUserId: author, body: 'Screenshot feedback', screenshotKey: prepared.objectKey });
      await attachArtifactCommentScreenshot(tx, prepared);
    });
    return prepared;
  }
  const due = (key: string) => db.update(objects).set({ nextAttemptAt: sql`now() - interval '1 second'` }).where(eq(objects.objectKey, key));

  test('a committed attachment survives the caller reporting an uncertain DB outcome', async () => {
    const prepared = await attached();
    await abandonArtifactCommentScreenshot(prepared, store);
    expect((await receipt(prepared.objectKey))?.state).toBe('attached');
    expect((await receipt(prepared.objectKey))?.uploadConfirmed).toBe(true);
    expect((await receipt(prepared.objectKey))?.sizeBytes).toBe(Buffer.from(png, 'base64').byteLength);
    expect(stored.has(prepared.objectKey)).toBe(true);
    expect(removes).toBe(0);
  });

  test('unknown uploads retain a minimal cleanup receipt even after the object is removed', async () => {
    failPut = true;
    const id = crypto.randomUUID(), key = screenshotObjectKey(project.project_id, id, 'png');
    await expect(prepareArtifactCommentScreenshot(project.project_id, id, png, store)).rejects.toThrow();
    expect((await receipt(key))?.uploadConfirmed).toBe(false);
    expect(stored.has(key)).toBe(true);
    await due(key);
    await cleanupArtifactCommentScreenshots({ keys: [key], store });
    const retained = await receipt(key);
    expect(retained?.state).toBe('deleting');
    expect(retained?.uploadConfirmed).toBe(false);
    expect(retained!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(stored.has(key)).toBe(false);
  });

  test('delete failures retain confirmed receipts and a later retry removes only that object', async () => {
    const prepared = await attached();
    await db.update(artifactComments).set({ screenshotKey: null }).where(eq(artifactComments.commentId, prepared.commentId));
    failRemove = true;
    await cleanupArtifactCommentScreenshots({ keys: [prepared.objectKey], store });
    expect((await receipt(prepared.objectKey))?.state).toBe('deleting');
    expect(stored.has(prepared.objectKey)).toBe(true);
    failRemove = false;
    await due(prepared.objectKey);
    await cleanupArtifactCommentScreenshots({ keys: [prepared.objectKey], store });
    expect(await receipt(prepared.objectKey)).toBeUndefined();
    expect(stored.has(prepared.objectKey)).toBe(false);
  });

  test('project cascade retains both attached and orphaned upload deletion scopes', async () => {
    const prepared = await attached();
    failPut = true;
    const key = screenshotObjectKey(project.project_id, crypto.randomUUID(), 'png');
    const id = key.split('/').at(-1)!.slice(0, -4);
    await expect(prepareArtifactCommentScreenshot(project.project_id, id, png, store)).rejects.toThrow();
    await db.delete(projects).where(eq(projects.projectId, project.project_id));
    expect((await receipt(prepared.objectKey))?.state).toBe('deleting');
    expect((await receipt(key))?.state).toBe('deleting');
    await cleanupArtifactCommentScreenshots({ projectId: project.project_id, store });
    expect(stored.has(prepared.objectKey)).toBe(false);
    expect(stored.has(key)).toBe(false);
    expect(await receipt(prepared.objectKey)).toBeUndefined();
    expect((await receipt(key))?.uploadConfirmed).toBe(false);
  });

  test('a cleanup claim blocks a delayed uploader from attaching an object being deleted', async () => {
    const id = crypto.randomUUID(), prepared = await prepareArtifactCommentScreenshot(project.project_id, id, png, store);
    await due(prepared.objectKey);
    let started!: () => void, release!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    holdRemove = async () => { started(); await held; };
    const cleanup = cleanupArtifactCommentScreenshots({ keys: [prepared.objectKey], store });
    try {
      await begun;
      await expect(db.transaction(async tx => {
        await tx.insert(artifactComments).values({ commentId: id, threadId, authorUserId: author, body: 'Late screenshot', screenshotKey: prepared.objectKey });
        await attachArtifactCommentScreenshot(tx, prepared);
      })).rejects.toMatchObject({ status: 503 });
    } finally { release(); await cleanup; }
    expect((await db.select().from(artifactComments).where(eq(artifactComments.commentId, id))).length).toBe(0);
    expect(stored.has(prepared.objectKey)).toBe(false);
  });

  test('two cleanup claimants delete one object once and never erase a live attachment', async () => {
    const prepared = await attached();
    await db.update(objects).set({ state: 'deleting', nextAttemptAt: sql`now()` }).where(eq(objects.objectKey, prepared.objectKey));
    await cleanupArtifactCommentScreenshots({ keys: [prepared.objectKey], store });
    expect(removes).toBe(0);
    expect((await receipt(prepared.objectKey))?.state).toBe('attached');
    await db.update(artifactComments).set({ screenshotKey: null }).where(eq(artifactComments.commentId, prepared.commentId));
    await Promise.all([cleanupArtifactCommentScreenshots({ keys: [prepared.objectKey], store }), cleanupArtifactCommentScreenshots({ keys: [prepared.objectKey], store })]);
    expect(removes).toBe(1);
    expect(await receipt(prepared.objectKey)).toBeUndefined();
  });
});
