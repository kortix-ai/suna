import { beforeEach, expect, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import * as recovery from './change-request-recovery';

const calls: { url: string; body: unknown }[] = [];
let originStatus = 200;
let archived = false;
let promptStatus = 200;
let promptCode = 'forbidden';
beforeEach(() => {
  calls.length = 0; originStatus = 200; archived = false; promptStatus = 200; promptCode = 'forbidden';
  configureKortix({ backendUrl: 'https://recovery.test/v1', getToken: async () => 'test', fetch: async (input, init) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const status = url.endsWith('/prompts') ? promptStatus : init?.method === 'POST' ? 201 : originStatus;
    return new Response(JSON.stringify(status >= 400 ? { error: 'refused', ...(status === 403 ? { code: promptCode } : {}) } : url.endsWith('/origin') ? { session_id: 'origin', branch_name: 'head', runtime_status: archived ? 'archived' : 'stopped' } : { session_id: 'child' }), { status, headers: { 'content-type': 'application/json' } });
  } });
});
const target = { crId: 'change', number: 12, title: 'Synthetic', headRef: 'head', baseRef: 'dev', originSessionId: 'origin' };
const blocker = { kind: 'merge_conflict' as const, conflicts: ['README.md'] };
test('queues recovery on the existing origin without creating a session', async () => {
  expect(await recovery.recoverChangeRequest('project', target, blocker)).toBe('origin');
  expect(calls.map(c => c.url)).toEqual(['https://recovery.test/v1/projects/project/sessions/origin', 'https://recovery.test/v1/projects/project/sessions/origin/prompts']);
  expect(calls[1].body).toMatchObject({ delivery: 'queue', remint_on_delivery: true });
  expect(JSON.stringify(calls[1].body)).toContain('Do not open a replacement change request');
});
test('creates a linked child for an archived visible origin', async () => {
  archived = true;
  expect(await recovery.recoverChangeRequest('project', target, blocker)).toBe('child');
  expect(calls[1].body).toMatchObject({ parent_session_id: 'origin', base_ref: 'head', metadata: { origin_session_id: 'origin' } });
});
test('an invisible origin becomes a metadata-linked root, never a private parent', async () => {
  originStatus = 404;
  await recovery.recoverChangeRequest('project', target, blocker);
  expect(calls[1].body).toMatchObject({ metadata: { origin_session_id: 'origin' } });
  expect(calls[1].body).not.toHaveProperty('parent_session_id');
});
test('no origin preserves root creation', async () => {
  await recovery.recoverChangeRequest('project', { ...target, originSessionId: null }, blocker);
  expect(calls).toHaveLength(1);
  expect(calls[0].body).not.toHaveProperty('parent_session_id');
});
test('network and server failures never create a duplicate recovery', async () => {
  originStatus = 500;
  await expect(recovery.recoverChangeRequest('project', target, blocker)).rejects.toThrow();
  expect(calls).toHaveLength(1);
});
test('prompt failure does not create a replacement after ambiguous delivery', async () => {
  promptStatus = 500;
  await expect(recovery.recoverChangeRequest('project', target, blocker)).rejects.toThrow();
  expect(calls).toHaveLength(2);
});

test('a definitive prompt permission refusal selects a child, not another root', async () => {
  promptStatus = 403;
  await recovery.recoverChangeRequest('project', target, blocker);
  expect(calls).toHaveLength(3);
  expect(calls[2].body).toMatchObject({ parent_session_id: 'origin' });
});
test('manifest origin recovery updates the same request without applying it', async () => {
  await recovery.recoverChangeRequest('project', target, { kind: 'manifest_invalid', issues: [], manifestFilename: 'kortix.yaml' });
  expect(JSON.stringify(calls[1].body)).toContain('Do not open a replacement change request or apply');
  expect(JSON.stringify(calls[1].body)).toContain('safely check out that source branch');
});

test('SSO and MFA refusal are not converted into new recovery sessions', async () => {
  promptStatus = 403;
  promptCode = 'sso_required';
  await expect(recovery.recoverChangeRequest('project', target, blocker)).rejects.toThrow();
  expect(calls).toHaveLength(2);
});
