import { beforeEach, expect, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  ACP_PERMISSION_POLICY_MAX_KEY_LENGTH,
  ACP_PERMISSION_POLICY_MAX_TOOLS,
  getAcpPermissionPolicy,
  putAcpPermissionPolicy,
} from './acp-permission-policy';

let calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = (async (url: unknown, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
      headers: (opts.headers as Record<string, string>) ?? {},
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
});

const last = () => calls[calls.length - 1];

test('exports the caps mirrored from @kortix/api-contract', () => {
  expect(ACP_PERMISSION_POLICY_MAX_TOOLS).toBe(128);
  expect(ACP_PERMISSION_POLICY_MAX_KEY_LENGTH).toBe(256);
});

test('getAcpPermissionPolicy hits GET /projects/:id/acp/permission-policy and returns the parsed body', async () => {
  nextResponse = { status: 200, body: { autoApprove: 'none', toolDecisions: {} } };
  const result = await getAcpPermissionPolicy('P1');
  expect(last().url).toContain('/projects/P1/acp/permission-policy');
  expect(last().method).toBe('GET');
  expect(result).toEqual({ autoApprove: 'none', toolDecisions: {} });
});

test('getAcpPermissionPolicy sends the authenticated bearer token', async () => {
  nextResponse = { status: 200, body: { autoApprove: 'none', toolDecisions: {} } };
  await getAcpPermissionPolicy('P1');
  expect(last().headers['Authorization']).toBe('Bearer tok');
});

test('getAcpPermissionPolicy throws when the response is unsuccessful', async () => {
  nextResponse = { status: 500, body: { message: 'boom' } };
  await expect(getAcpPermissionPolicy('P1')).rejects.toBeTruthy();
});

test('putAcpPermissionPolicy PUTs the full policy body to the same path', async () => {
  const policy = { autoApprove: 'reads' as const, toolDecisions: { Bash: 'allow' as const } };
  nextResponse = { status: 200, body: policy };
  const result = await putAcpPermissionPolicy('P1', policy);
  expect(last().url).toContain('/projects/P1/acp/permission-policy');
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual(policy);
  expect(result).toEqual(policy);
});

test('putAcpPermissionPolicy sends the authenticated bearer token', async () => {
  const policy = { autoApprove: 'none' as const, toolDecisions: {} };
  nextResponse = { status: 200, body: policy };
  await putAcpPermissionPolicy('P1', policy);
  expect(last().headers['Authorization']).toBe('Bearer tok');
});

test('putAcpPermissionPolicy throws on a 422 (server-side validation failure)', async () => {
  nextResponse = { status: 422, body: { error: 'Invalid ACP permission policy', code: 'invalid_body' } };
  await expect(
    putAcpPermissionPolicy('P1', { autoApprove: 'none', toolDecisions: {} }),
  ).rejects.toBeTruthy();
});

test('putAcpPermissionPolicy throws on a 403 (missing project.customize.write)', async () => {
  nextResponse = { status: 403, body: { message: 'forbidden' } };
  await expect(
    putAcpPermissionPolicy('P1', { autoApprove: 'none', toolDecisions: {} }),
  ).rejects.toBeTruthy();
});
