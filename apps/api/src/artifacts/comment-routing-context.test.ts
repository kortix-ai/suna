import { expect, test } from 'bun:test';
import { artifactCommentSendBatch, unaddressedArtifactThreadIds } from './comment-routing-context';

const thread = (id: string, mentions: unknown[] = []) => ({ thread_id: id, status: 'open' as const, created_by_session_id: null,
  comments: [{ comment_id: `root-${id}`, thread_id: id, deleted_at: null, mentions }] });
const event = (id: string, origin?: string) => ({ data: { thread_id: id, session_id: 'writer', recipient_key: 'session:writer', delivery_key: `delivery-${id}`,
  ...(origin ? { origin_comment_id: origin } : {}) } });

test('Send context exposes the first 100 eligible IDs and the full remaining count', () => {
  const ids = Array.from({ length: 101 }, (_, index) => `thread-${index}`);
  expect(artifactCommentSendBatch(ids)).toEqual({ send_thread_ids: ids.slice(0, 100), send_thread_count: 101 });
  expect(artifactCommentSendBatch(ids.slice(0, 100))).toEqual({ send_thread_ids: ids.slice(0, 100), send_thread_count: 100 });
  expect(artifactCommentSendBatch([])).toEqual({ send_thread_ids: [], send_thread_count: 0 });
  expect(ids).toHaveLength(101);
});

test('only open live-root threads without an agent context enter the Send batch', () => {
  const rows = [thread('plain'), { ...thread('resolved'), status: 'resolved' as const }, { ...thread('agent'), created_by_session_id: 'writer' },
    { ...thread('deleted'), comments: [{ ...thread('deleted').comments[0]!, deleted_at: '2026-01-01' }] }];
  expect(unaddressedArtifactThreadIds(rows, [], [], [])).toEqual(['plain']);
});

test('manual routes remain addressed, while edited-away automatic origins and dead-lettered delivery become eligible again', () => {
  const rows = [thread('manual'), thread('removed'), thread('dead'), thread('valid', [{ kind: 'session', session_id: 'writer' }])];
  const events = [event('manual'), event('removed', 'root-removed'), event('dead'), event('valid', 'root-valid')];
  const commands = [{ status: 'dead_lettered', idempotencyKey: 'delivery-dead', payload: {} }];
  expect(unaddressedArtifactThreadIds(rows, events, [], commands)).toEqual(['removed', 'dead']);
});

test('current pending targets count, skipped or canceled targets do not resurrect recipients', () => {
  const rows = [thread('pending', [{ kind: 'agent', agent_name: 'writer' }]), thread('removed'), thread('skipped'), thread('before-plan', [{ kind: 'agent', agent_name: 'writer' }])];
  const job = (id: string, status = 'pending') => ({ status: 'queued', payload: { threadIds: [id], commentId: `root-${id}`,
    targets: [{ recipientKey: 'agent:writer', status, key: `delivery-${id}`, implicit: false }] } });
  expect(unaddressedArtifactThreadIds(rows, [], [job('pending'), job('removed'), job('skipped', 'skipped'),
    { status: 'queued', payload: { threadIds: ['before-plan'], commentId: 'root-before-plan' } }], [])).toEqual(['removed', 'skipped']);
});

test('a failed pending-first command overrides a successful create receipt and another Artifact origin cannot address this thread', () => {
  const rows = [thread('failed'), thread('foreign')];
  const commands = [{ status: 'dead_lettered', idempotencyKey: 'pending-first', payload: { artifactCommentDelivery: { target_key: 'delivery-failed' } } },
    { status: 'succeeded', idempotencyKey: 'delivery-failed', payload: {} }];
  expect(unaddressedArtifactThreadIds(rows, [event('failed'), event('foreign', 'root-unrelated')], [], commands)).toEqual(['failed', 'foreign']);
});
