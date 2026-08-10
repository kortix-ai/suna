import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  type ApprovalLinkDetails,
  requestWorkspaceConnector,
  requestWorkspaceSecret,
} from './setup-links';

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

test('requestWorkspaceSecret posts names/labels/descriptions/scope to secret-requests', async () => {
  nextResponse = {
    status: 200,
    body: {
      kind: 'secret',
      url: 'https://app.local/secret-intake/tok',
      names: ['STRIPE_KEY'],
      scope: 'runtime',
      expires_at: '2026-01-01',
    },
  };
  const result = await requestWorkspaceSecret('P1', { names: ['STRIPE_KEY'], scope: 'runtime' });
  expect(last().url).toContain('/workspaces/P1/secret-requests');
  expect(last().method).toBe('POST');
  expect(last().body).toMatchObject({ names: ['STRIPE_KEY'], scope: 'runtime' });
  expect(result.url).toContain('/secret-intake/');
});

test('requestWorkspaceSecret throws on failure', async () => {
  nextResponse = { status: 400, body: { message: 'names is required' } };
  await expect(requestWorkspaceSecret('P1', { names: [] })).rejects.toThrow();
});

test('requestWorkspaceConnector posts slug to connect-requests', async () => {
  nextResponse = {
    status: 200,
    body: {
      kind: 'connector',
      url: 'https://app.local/connect/tok',
      slug: 'github',
      app: 'github',
      expires_at: '2026-01-01',
    },
  };
  const result = await requestWorkspaceConnector('P1', { slug: 'github' });
  expect(last().url).toContain('/workspaces/P1/connect-requests');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ slug: 'github', expires_in_minutes: undefined });
  expect(result.slug).toBe('github');
});

test('ApprovalLinkDetails exposes whether every action parameter is reviewable', () => {
  const details: ApprovalLinkDetails = {
    kind: 'approval',
    workspace_id: 'workspace-1',
    workspace_name: 'Inbox automation',
    execution_id: 'execution-1',
    session_id: 'session-1',
    action: 'gmail.send_email',
    connector: 'gmail',
    risk: 'write',
    status: 'pending_approval',
    pending: true,
    args_preview: {
      to: 'customer@example.com',
      subject: 'Delivery update',
      body: 'Your order is ready.',
    },
    args_summary: 'to: customer@example.com · subject: Delivery update',
    review_complete: true,
    policy_source: 'workspace',
    requested_at: '2026-08-03T10:00:00.000Z',
    resolved_at: null,
    expires_at: '2026-08-03T10:15:00.000Z',
  };

  expect(details.review_complete).toBe(true);
});
