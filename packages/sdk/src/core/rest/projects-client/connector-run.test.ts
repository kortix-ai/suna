import { beforeEach, expect, mock, test } from 'bun:test';
import { ApiError } from '../../http/api/errors';
import { configureKortix } from '../../http/config';
import {
  ConnectorApprovalPendingError,
  ConnectorCallError,
  paginateConnector,
  runConnector,
} from './connector-run';

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

let requests: Array<{ url: string; body: any }> = [];
let replies: Reply[] = [];

function reply(next: Reply) {
  replies = [next];
}

beforeEach(() => {
  requests = [];
  replies = [];
  configureKortix({ backendUrl: 'http://test.local/v1', getToken: async () => 'token' });
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({ url: request.url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const next = replies.length > 1 ? replies.shift()! : replies[0]!;
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...next.headers },
    });
  }) as unknown as typeof fetch;
});

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

// ── Request shape ───────────────────────────────────────────────────────────

test('run posts connector, action, args, account and approval context to the project route', async () => {
  reply({ body: { ok: true, data: { id: 1 }, binding: 'openapi', upstream_status: 200 } });
  await runConnector('proj/1', 'github', 'get_issue', { number: 7 }, {
    account: ' me ',
    approvalContext: 'reads one issue',
  });
  expect(requests[0]!.url).toBe('http://test.local/v1/connectors/projects/proj%2F1/call');
  expect(requests[0]!.body).toEqual({
    connector: 'github',
    action: 'get_issue',
    args: { number: 7 },
    account: 'me',
    approval_context: 'reads one issue',
  });
});

test('run without a project id uses the token-scoped route', async () => {
  reply({ body: { ok: true, data: [], binding: 'http', upstream_status: 200 } });
  await runConnector(undefined, 'github', 'list_issues');
  expect(requests[0]!.url).toBe('http://test.local/v1/connectors/call');
  expect(requests[0]!.body.args).toEqual({});
});

// ── 200: the unwrapped output ───────────────────────────────────────────────

test('run returns `output` when the server sends it (an unwrapped envelope)', async () => {
  reply({
    body: {
      ok: true,
      data: { provider: 'composio', result: { messages: [1, 2] } },
      output: { messages: [1, 2] },
      binding: 'composio',
      upstream_status: 200,
    },
  });
  expect(await runConnector<object>('p', 'gmail', 'fetch_emails')).toEqual({ messages: [1, 2] });
});

test('run returns `data` when a server that names the binding omits `output`', async () => {
  reply({ body: { ok: true, data: { items: [3] }, binding: 'openapi', upstream_status: 200 } });
  expect(await runConnector<object>('p', 'crm', 'list')).toEqual({ items: [3] });
});

test('run unwraps a Composio envelope from a server that predates `output`', async () => {
  reply({ body: { ok: true, data: { provider: 'composio', requestId: 'r', result: { a: 1 } } } });
  expect(await runConnector<object>('p', 'gmail', 'fetch_emails')).toEqual({ a: 1 });
});

test('run unwraps an MCP JSON-RPC answer from a server that predates `output`', async () => {
  reply({
    body: {
      ok: true,
      data: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'hi' }] } },
    },
  });
  expect(await runConnector<object>('p', 'docs', 'search')).toEqual([{ type: 'text', text: 'hi' }]);
  reply({
    body: {
      ok: true,
      data: { jsonrpc: '2.0', id: 1, result: { structuredContent: { n: 2 }, content: [] } },
    },
  });
  expect(await runConnector<object>('p', 'docs', 'search')).toEqual({ n: 2 });
});

test('run throws when the upstream reported a failure inside a 2xx', async () => {
  reply({
    body: {
      ok: true,
      data: { jsonrpc: '2.0', result: { isError: true, content: [] } },
      output: [],
      binding: 'mcp',
      upstream_status: 200,
      upstream_error: 'tool failed: no such page',
    },
  });
  const error = await rejection(runConnector('p', 'docs', 'fetch'));
  expect(error).toBeInstanceOf(ConnectorCallError);
  expect(error.code).toBe('upstream_error');
  expect(error.reason).toBe('tool failed: no such page');
  expect(error.message).toBe('tool failed: no such page');
  expect(error.binding).toBe('mcp');
  expect(error.upstreamStatus).toBe(200);
  expect(error.status).toBe(200);
  expect(error.connector).toBe('docs');
  expect(error.action).toBe('fetch');
});

// ── 202: approval ───────────────────────────────────────────────────────────

test('run throws ConnectorApprovalPendingError on 202', async () => {
  reply({
    status: 202,
    body: {
      ok: false,
      status: 'pending_approval',
      reason: 'policy_requires_approval',
      execution_id: 'exec-1',
      retryable: true,
      approval_url: 'https://app.test/approvals/exec-1',
      approval_summary: 'Send an email',
      approval_instructions: 'Ask a manager',
    },
  });
  const error = await rejection(runConnector('p', 'gmail', 'send_email', { to: 'a@example.com' }));
  expect(error).toBeInstanceOf(ConnectorApprovalPendingError);
  expect(error).not.toBeInstanceOf(ApiError);
  expect(error.executionId).toBe('exec-1');
  expect(error.approvalUrl).toBe('https://app.test/approvals/exec-1');
  expect(error.approvalSummary).toBe('Send an email');
  expect(error.approvalInstructions).toBe('Ask a manager');
  expect(error.retryable).toBe(true);
  expect(error.reason).toBe('policy_requires_approval');
  expect(error.connector).toBe('gmail');
  expect(error.action).toBe('send_email');
});

// ── 4xx / 5xx: typed errors ─────────────────────────────────────────────────

test('403 connector_not_connected carries connectUrl and hint, and is an ApiError', async () => {
  reply({
    status: 403,
    body: {
      ok: false,
      status: 'denied',
      reason: 'connector_not_connected',
      connector: 'gmail',
      action: 'fetch_emails',
      connect_url: 'https://app.test/connect/tok',
      hint: 'Give the human this link',
    },
  });
  const error = await rejection(runConnector('p', 'gmail', 'fetch_emails'));
  expect(error).toBeInstanceOf(ConnectorCallError);
  expect(error).toBeInstanceOf(ApiError);
  expect(error.name).toBe('ConnectorCallError');
  expect(error.status).toBe(403);
  expect(error.code).toBe('connector_not_connected');
  expect(error.reason).toBe('connector_not_connected');
  expect(error.connectUrl).toBe('https://app.test/connect/tok');
  expect(error.hint).toBe('Give the human this link');
  expect(error.upstreamStatus).toBeNull();
  expect(error.retryAfterSeconds).toBeNull();
  expect(error.details.connect_url).toBe('https://app.test/connect/tok');
});

test('403 account_required lists the available accounts', async () => {
  reply({
    status: 403,
    body: {
      ok: false,
      status: 'denied',
      reason: 'account_required',
      connector: 'gmail',
      available_accounts: ['work', 'personal'],
      default_account: null,
      hint: 'pass account',
    },
  });
  const error = await rejection(runConnector('p', 'gmail', 'fetch_emails'));
  expect(error.code).toBe('account_required');
  expect(error.availableAccounts).toEqual(['work', 'personal']);
});

test('403 with a named account that does not match reports the requested account', async () => {
  reply({
    status: 403,
    body: {
      ok: false,
      status: 'denied',
      reason: 'connector_not_connected',
      requested_account: 'sales',
      available_accounts: ['work'],
    },
  });
  const error = await rejection(runConnector('p', 'gmail', 'fetch_emails', {}, { account: 'sales' }));
  expect(error.requestedAccount).toBe('sales');
  expect(error.availableAccounts).toEqual(['work']);
  expect(error.connectUrl).toBeNull();
});

test('403 credential_not_shared keeps its reason', async () => {
  reply({ status: 403, body: { ok: false, status: 'denied', reason: 'credential_not_shared' } });
  const error = await rejection(runConnector('p', 'crm', 'list'));
  expect(error.code).toBe('credential_not_shared');
  expect(error.availableAccounts).toEqual([]);
});

test('429 reads upstream_status and retry_after_seconds', async () => {
  reply({
    status: 429,
    headers: { 'retry-after': '7' },
    body: {
      ok: false,
      status: 'error',
      reason: 'upstream_429: {"message":"slow down"}',
      binding: 'openapi',
      upstream_status: 429,
      retry_after_seconds: 7,
    },
  });
  const error = await rejection(runConnector('p', 'crm', 'list'));
  expect(error.status).toBe(429);
  expect(error.code).toBe('upstream_429');
  expect(error.upstreamStatus).toBe(429);
  expect(error.retryAfterSeconds).toBe(7);
  expect(error.binding).toBe('openapi');
});

test('503 without a body field reads the Retry-After header', async () => {
  reply({
    status: 503,
    headers: { 'retry-after': '12' },
    body: { ok: false, status: 'error', reason: 'upstream_503', binding: 'http', upstream_status: 503 },
  });
  const error = await rejection(runConnector('p', 'crm', 'list'));
  expect(error.retryAfterSeconds).toBe(12);
});

test('500 with a plain-text reason and no status prefix has upstreamStatus null', async () => {
  reply({
    status: 500,
    body: { ok: false, status: 'error', reason: 'Gmail said: quota exceeded', binding: null, upstream_status: null },
  });
  const error = await rejection(runConnector('p', 'gmail', 'fetch_emails'));
  expect(error.upstreamStatus).toBeNull();
  expect(error.reason).toBe('Gmail said: quota exceeded');
  expect(error.code).toBe('connector_error');
  expect(error.message).toBe('Gmail said: quota exceeded');
});

test('a verbatim upstream body is classified by the upstream status, never by its first word', async () => {
  reply({
    status: 503,
    body: { ok: false, status: 'error', reason: 'maintenance', binding: 'openapi', upstream_status: 503 },
  });
  const error = await rejection(runConnector('p', 'crm', 'list'));
  expect(error.code).toBe('upstream_503');
  expect(error.reason).toBe('maintenance');
  reply({ status: 500, body: { ok: false, status: 'error', reason: 'boom', binding: 'openapi', upstream_status: 500 } });
  expect((await rejection(runConnector('p', 'crm', 'list'))).code).toBe('upstream_500');
});

test('500 from a server that predates upstream_status falls back to the upstream_<n> prefix', async () => {
  reply({ status: 500, body: { ok: false, status: 'error', reason: 'upstream_404: {"error":"gone"}' } });
  const error = await rejection(runConnector('p', 'crm', 'get'));
  expect(error.upstreamStatus).toBe(404);
  expect(error.code).toBe('upstream_404');
});

test('500 upstream_timeout is classified by its leading token', async () => {
  reply({
    status: 500,
    body: { ok: false, status: 'error', reason: 'upstream_timeout: no answer in 60000 ms', upstream_status: null },
  });
  const error = await rejection(runConnector('p', 'crm', 'get'));
  expect(error.code).toBe('upstream_timeout');
});

test('400 {error} bodies become ConnectorCallError with that code', async () => {
  reply({ status: 400, body: { error: 'invalid_json' } });
  const error = await rejection(runConnector('p', 'crm', 'get'));
  expect(error).toBeInstanceOf(ConnectorCallError);
  expect(error.code).toBe('invalid_json');
  expect(error.reason).toBe('invalid_json');
});

test('409 computer_offline keeps the computer state as the code', async () => {
  reply({ status: 409, body: { ok: false, status: 'error', reason: 'computer_offline: the laptop is asleep' } });
  const error = await rejection(runConnector('p', 'my-laptop', 'shell'));
  expect(error.status).toBe(409);
  expect(error.code).toBe('computer_offline');
});

test('an invalid slug or action is rejected before any request', async () => {
  expect(await rejection(runConnector('p', '', 'x'))).toBeInstanceOf(Error);
  expect(await rejection(runConnector('p', 'crm', ' '))).toBeInstanceOf(Error);
  expect(requests).toHaveLength(0);
});

test('timeoutMs bounds the request', async () => {
  globalThis.fetch = mock(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  ) as unknown as typeof fetch;
  const started = Date.now();
  await rejection(runConnector('p', 'crm', 'get', {}, { timeoutMs: 30 }));
  expect(Date.now() - started).toBeLessThan(2_000);
});

// ── Pagination ──────────────────────────────────────────────────────────────

test('paginate yields each page and follows the cursor until next returns undefined', async () => {
  replies = [
    { body: { ok: true, data: { items: [1], next: 'b' }, binding: 'openapi', upstream_status: 200 } },
    { body: { ok: true, data: { items: [2], next: 'c' }, binding: 'openapi', upstream_status: 200 } },
    { body: { ok: true, data: { items: [3], next: null }, binding: 'openapi', upstream_status: 200 } },
  ];
  const pages: unknown[] = [];
  for await (const page of paginateConnector<{ items: number[]; next: string | null }>(
    'p',
    'crm',
    'list',
    { limit: 1 },
    { next: (page, args) => (page.next ? { ...args, after: page.next } : undefined) },
  )) {
    pages.push(page.items);
  }
  expect(pages).toEqual([[1], [2], [3]]);
  expect(requests.map((r) => r.body.args)).toEqual([
    { limit: 1 },
    { limit: 1, after: 'b' },
    { limit: 1, after: 'c' },
  ]);
});

test('paginate stops at maxPages', async () => {
  reply({ body: { ok: true, data: { next: 'again' }, binding: 'openapi', upstream_status: 200 } });
  let count = 0;
  for await (const _page of paginateConnector<{ next: string }>('p', 'crm', 'list', {}, {
    next: (page) => ({ cursor: page.next }),
    maxPages: 2,
  })) {
    count += 1;
  }
  expect(count).toBe(2);
  expect(requests).toHaveLength(2);
});

test('paginate propagates a typed error from a later page', async () => {
  replies = [
    { body: { ok: true, data: { next: 'b' }, binding: 'openapi', upstream_status: 200 } },
    { status: 429, body: { ok: false, status: 'error', reason: 'upstream_429', upstream_status: 429 } },
  ];
  const seen: unknown[] = [];
  const error = await rejection(
    (async () => {
      for await (const page of paginateConnector<{ next: string }>('p', 'crm', 'list', {}, {
        next: (page) => ({ cursor: page.next }),
      })) {
        seen.push(page);
      }
    })(),
  );
  expect(seen).toHaveLength(1);
  expect(error).toBeInstanceOf(ConnectorCallError);
  expect(error.upstreamStatus).toBe(429);
});
