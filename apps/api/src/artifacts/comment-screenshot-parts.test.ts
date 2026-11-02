import { expect, test } from 'bun:test';
import { screenshotReferences, assertScreenshotBatch, selectScreenshotSendBatch, screenshotReferenceBudget } from './comment-screenshot-parts';

const artifact = { projectId: '11111111-1111-4111-8111-111111111111', artifactId: '22222222-2222-4222-8222-222222222222' };
const commentId = '33333333-3333-4333-8333-333333333333';
const row = { commentId, screenshotKey: `${artifact.projectId}/artifact-comments/${commentId}.webp`, deletedAt: null };

test('queued screenshot references use authenticated Artifact paths and exact original MIME without bytes or tokens', () => {
  const refs = screenshotReferences(artifact, [row], 'https://api.example/v1');
  expect(refs).toEqual([{ type: 'file', mime: 'image/webp', filename: `${commentId}.webp`, url: `https://api.example/v1/projects/${artifact.projectId}/artifacts/${artifact.artifactId}/comments/${commentId}/screenshot`, key: row.screenshotKey }]);
  expect(JSON.stringify(refs)).not.toContain('base64');
  expect(screenshotReferences(artifact, [{ ...row, deletedAt: new Date() }], 'https://api.example')).toEqual([]);
});

test('vision batches reject the native image cap before any image can be dropped', () => {
  expect(() => assertScreenshotBatch(20, 20 * 2 * 1024 * 1024)).not.toThrow();
  expect(() => assertScreenshotBatch(21, 1)).toThrow(expect.objectContaining({ status: 413, code: 'artifact_comment_screenshot_limit', limits: { max_files: 20, max_total_bytes: 104857600, max_screenshot_bytes: 2097152, max_parts_bytes: 12582912 } }));
  expect(() => assertScreenshotBatch(1, 104857601)).toThrow();
});

test('ordered Send batches retain total eligible count and never hide an individually oversized first thread', () => {
  const ids = Array.from({ length: 25 }, (_, index) => `thread-${index}`);
  const counts = new Map(ids.map(id => [id, 1]));
  expect(selectScreenshotSendBatch(ids, counts, true)).toEqual({ send_thread_ids: ids.slice(0, 20), send_thread_count: 25 });
  expect(selectScreenshotSendBatch(ids, counts, false)).toEqual({ send_thread_ids: ids, send_thread_count: 25 });
  counts.set(ids[0]!, 21);
  expect(selectScreenshotSendBatch(ids, counts, true)).toEqual({ send_thread_ids: ids.slice(0, 1), send_thread_count: 25 });
});


test('verified byte metadata enforces the native12MiB serialized cap and selects a safe ordered batch', () => {
  const refs = Array.from({ length: 5 }, (_, index) => ({ ...screenshotReferences(artifact, [row], '')[0]!, key: `key-${index}` }));
  const sizes = new Map(refs.map(ref => [ref.key, 2 * 1024 * 1024]));
  const full = screenshotReferenceBudget(refs, sizes);
  expect(full.partsBytes).toBeGreaterThan(12582912);
  expect(() => assertScreenshotBatch(refs.length, full.bytes, full.partsBytes)).toThrow();
  const small = screenshotReferenceBudget(refs.slice(0, 4), sizes);
  expect(() => assertScreenshotBatch(4, small.bytes, small.partsBytes)).not.toThrow();
  const ids = refs.map(ref => ref.key);
  const counts = new Map(ids.map(id => [id, 1]));
  const budgets = new Map(refs.map(ref => [ref.key, screenshotReferenceBudget([ref], sizes)]));
  expect(selectScreenshotSendBatch(ids, counts, true, budgets)).toEqual({ send_thread_ids: ids.slice(0, 4), send_thread_count: 5 });
});

test('encoded image budgets include the text part and ordered context batches reserve all thread text', () => {
  const refs = Array.from({ length: 4 }, (_, index) => ({ ...screenshotReferences(artifact, [row], '')[0]!, key: `large-${index}` }));
  const sizes = new Map(refs.map(ref => [ref.key, 2 * 1024 * 1024]));
  const text = '界'.repeat(500_000);
  const budget = screenshotReferenceBudget(refs, sizes, text);
  expect(budget.partsBytes).toBeGreaterThan(12582912);
  expect(() => assertScreenshotBatch(4, budget.bytes, budget.partsBytes)).toThrow(expect.objectContaining({ code: 'artifact_comment_screenshot_limit' }));
  const ids = ['images', 'large-text'];
  const imageBudget = screenshotReferenceBudget(refs, sizes);
  expect(selectScreenshotSendBatch(ids, new Map([['images', 4]]), true,
    new Map([['images', imageBudget]]), new Map([['large-text', Buffer.byteLength(JSON.stringify({ type: 'text', text }))]])))
    .toEqual({ send_thread_ids: ['images'], send_thread_count: 2 });
});
