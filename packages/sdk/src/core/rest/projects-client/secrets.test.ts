import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  deletePersonalProjectSecret,
  deleteProjectSecret,
  listProjectSecrets,
  pollProjectProviderOAuth,
  promoteProjectSecretToShared,
  setPersonalProjectSecret,
  startProjectProviderOAuth,
  upsertProjectGitCredential,
  upsertProjectSecret,
} from './secrets';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

test('listProjectSecrets hits GET /projects/:id/secrets and returns the parsed body', async () => {
  nextResponse = { status: 200, body: { items: [], required: [], optional: [] } };
  const result = await listProjectSecrets('P1');
  expect(last().url).toContain('/projects/P1/secrets');
  expect(last().method).toBe('GET');
  expect(result).toEqual({ items: [], required: [], optional: [] });
});

test('listProjectSecrets throws when the response is unsuccessful', async () => {
  nextResponse = { status: 500, body: { message: 'boom' } };
  await expect(listProjectSecrets('P1')).rejects.toBeTruthy();
});

test('listProjectSecrets is a silent background read — a 403 never hits the global error sink', async () => {
  // project.secret.read is editor-tier: plain members legitimately 403 from
  // member-visible surfaces (model picker, LLM providers). No global toast.
  const onError = mock(() => {});
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError });
  try {
    nextResponse = { status: 403, body: { message: 'forbidden' } };
    await expect(listProjectSecrets('P1')).rejects.toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  }
});

test('upsertProjectSecret POSTs name/value as the raw body', async () => {
  nextResponse = { status: 200, body: { name: 'FOO' } };
  await upsertProjectSecret('P1', { name: 'FOO', value: 'bar' });
  expect(last().url).toContain('/projects/P1/secrets');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ name: 'FOO', value: 'bar' });
});

test('upsertProjectSecret includes an explicit identifier when given', async () => {
  nextResponse = { status: 200, body: { name: 'FOO' } };
  await upsertProjectSecret('P1', { name: 'FOO', identifier: 'GMAPS-backup', value: 'bar' });
  expect(last().body).toEqual({ name: 'FOO', identifier: 'GMAPS-backup', value: 'bar' });
});

test('startProjectProviderOAuth posts to the provider start endpoint with the sharing intent', async () => {
  nextResponse = {
    status: 200,
    body: { flow_id: 'f1', verification_url: 'https://x', user_code: '123', expires_at: 1, interval_ms: 500 },
  };
  const result = await startProjectProviderOAuth('P1', 'chatgpt', { sharing: { mode: 'project' } });
  expect(last().url).toContain('/projects/P1/oauth/chatgpt/start');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ sharing: { mode: 'project' } });
  expect(result.flow_id).toBe('f1');
});

test('startProjectProviderOAuth sends sharing: undefined when no input is given', async () => {
  nextResponse = { status: 200, body: { flow_id: 'f1', verification_url: 'x', user_code: null, expires_at: 1, interval_ms: 1 } };
  await startProjectProviderOAuth('P1', 'chatgpt');
  expect(last().body).toEqual({ sharing: undefined });
});

test('pollProjectProviderOAuth posts the flow_id and returns the poll result', async () => {
  nextResponse = { status: 200, body: { status: 'pending', next_poll_ms: 2000 } };
  const result = await pollProjectProviderOAuth('P1', 'chatgpt', 'flow-123');
  expect(last().url).toContain('/projects/P1/oauth/chatgpt/poll');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ flow_id: 'flow-123' });
  expect(result).toEqual({ status: 'pending', next_poll_ms: 2000 });
});

test('upsertProjectGitCredential PUTs the token to /git-credential', async () => {
  nextResponse = {
    status: 200,
    body: { configured: true, provider: 'github', git_connection: {} },
  };
  const result = await upsertProjectGitCredential('P1', { token: 'ghp_abc' });
  expect(last().url).toContain('/projects/P1/git-credential');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ token: 'ghp_abc' });
  expect(result.configured).toBe(true);
});

test('deleteProjectSecret DELETEs the encoded secret name', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deleteProjectSecret('P1', 'MY KEY');
  expect(last().url).toContain('/projects/P1/secrets/MY%20KEY');
  expect(last().method).toBe('DELETE');
});

test('setPersonalProjectSecret PUTs to the /personal sub-route', async () => {
  nextResponse = { status: 200, body: { name: 'FOO', mine: { active: true, updated_at: '2026-01-01' } } };
  await setPersonalProjectSecret('P1', 'FOO', { value: 'mine-value', active: true });
  expect(last().url).toContain('/projects/P1/secrets/FOO/personal');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ value: 'mine-value', active: true });
});

test('deletePersonalProjectSecret DELETEs the /personal sub-route', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deletePersonalProjectSecret('P1', 'FOO');
  expect(last().url).toContain('/projects/P1/secrets/FOO/personal');
  expect(last().method).toBe('DELETE');
});

test('deletePersonalProjectSecret encodes special characters in the secret name', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deletePersonalProjectSecret('P1', 'FOO/BAR');
  expect(last().url).toContain('/projects/P1/secrets/FOO%2FBAR/personal');
});

test('promoteProjectSecretToShared POSTs to the /promote-to-shared sub-route with no body', async () => {
  nextResponse = { status: 200, body: { name: 'FOO', configured: true } };
  const result = await promoteProjectSecretToShared('P1', 'FOO');
  expect(last().url).toContain('/projects/P1/secrets/FOO/promote-to-shared');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({});
  expect(result.configured).toBe(true);
});
