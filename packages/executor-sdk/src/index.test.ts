import { describe, expect, test } from 'bun:test';
import {
  createExecutorClient,
  ExecutorClient,
  ExecutorError,
  type ExecutorConnector,
} from './index';

type Recorded = {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
};

function harness(reply: (call: Recorded) => { status?: number; body?: unknown }) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = request.method === 'GET' ? '' : await request.clone().text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const call: Recorded = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body,
    };
    calls.push(call);
    const result = reply(call);
    return Response.json(result.body ?? {}, { status: result.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const catalog: { connectors: ExecutorConnector[] } = {
  connectors: [
    {
      slug: 'gmail',
      name: 'Gmail',
      provider: 'pipedream',
      status: 'active',
      actions: [
        {
          path: 'send_email',
          name: 'Send email',
          description: 'Send an email',
          risk: 'write',
          inputSchema: { type: 'object' },
        },
      ],
    },
  ],
};

describe('final Executor compatibility adapter', () => {
  test('preserves constructor validation and factory identity', () => {
    expect(() => new ExecutorClient({ apiUrl: '', token: 'token' })).toThrow('apiUrl is required');
    expect(() => new ExecutorClient({ apiUrl: 'https://api.test', token: '' })).toThrow('token is required');
    expect(createExecutorClient({ apiUrl: 'https://api.test', token: 'token' })).toBeInstanceOf(
      ExecutorClient,
    );
  });

  test('maps the flat session-token surface to @kortix/sdk Connector routes', async () => {
    const { calls, fetchImpl } = harness((call) =>
      call.url.endsWith('/call')
        ? { body: { ok: true, data: { id: 'message-1' } } }
        : { body: catalog },
    );
    const client = createExecutorClient({
      apiUrl: 'https://api.test',
      token: 'agent-token',
      fetchImpl,
    });

    expect((await client.connectors())[0]?.slug).toBe('gmail');
    expect((await client.tools())[0]?.tool).toBe('gmail.send_email');
    expect((await client.discover('send email'))[0]?.tool).toBe('gmail.send_email');
    expect((await client.describe('gmail.send_email'))?.action).toBe('send_email');
    expect(await client.call('gmail', 'send_email', { to: 'agent@example.com' })).toEqual({
      ok: true,
      data: { id: 'message-1' },
    });

    expect(calls[0]?.url).toBe('https://api.test/v1/connectors/catalog');
    expect(calls.at(-1)?.url).toBe('https://api.test/v1/connectors/call');
    expect(calls.at(-1)?.headers.get('authorization')).toBe('Bearer agent-token');
    expect(calls.at(-1)?.body).toEqual({
      connector: 'gmail',
      action: 'send_email',
      args: { to: 'agent@example.com' },
    });
  });

  test('maps project-explicit calls and attachment uploads to @kortix/sdk', async () => {
    const { calls, fetchImpl } = harness((call) =>
      call.url.endsWith('/attachments')
        ? {
            body: {
              attachment_id: 'attachment-1',
              filename: 'note.txt',
              content_type: 'text/plain',
              content_disposition: 'attachment',
              size: 4,
              expires_at: '2026-08-06T00:00:00.000Z',
            },
          }
        : { body: catalog },
    );
    const client = createExecutorClient({
      apiUrl: 'https://api.test/v1/',
      token: 'user-token',
      workspaceId: 'project/1',
      fetchImpl,
    });

    await client.connectors();
    const attachment = await client.uploadAttachment(new TextEncoder().encode('note'), {
      filename: 'note.txt',
      contentType: 'text/plain',
    });

    expect(attachment.attachment_id).toBe('attachment-1');
    expect(calls[0]?.url).toBe(
      'https://api.test/v1/connectors/projects/project%2F1/catalog',
    );
    expect(calls[1]?.url).toBe(
      'https://api.test/v1/connectors/projects/project%2F1/attachments',
    );
  });

  test('accepts canonical workspaceId and prefers it over deprecated workspaceId', async () => {
    const { calls, fetchImpl } = harness(() => ({ body: catalog }));
    const client = createExecutorClient({
      apiUrl: 'https://api.test',
      token: 'user-token',
      workspaceId: 'workspace/1',
      workspaceId: 'stale-project',
      fetchImpl,
    });

    await client.connectors();

    expect(calls[0]?.url).toBe(
      'https://api.test/v1/connectors/projects/workspace%2F1/catalog',
    );
  });

  test('preserves ExecutorError for failed SDK calls', async () => {
    const { fetchImpl } = harness(() => ({
      status: 404,
      body: { reason: 'connector_not_found' },
    }));
    const client = createExecutorClient({
      apiUrl: 'https://api.test',
      token: 'agent-token',
      fetchImpl,
    });

    try {
      await client.call('gmail', 'send_email');
      throw new Error('expected call to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutorError);
      expect((error as ExecutorError).status).toBe(404);
      expect((error as ExecutorError).message).toBe('connector_not_found');
      expect((error as ExecutorError).body).toMatchObject({ reason: 'connector_not_found' });
    }
  });

  test('keeps request() as a deprecated route-remapping escape hatch', async () => {
    const { calls, fetchImpl } = harness(() => ({ body: catalog }));
    const client = createExecutorClient({
      apiUrl: 'https://api.test',
      token: 'agent-token',
      fetchImpl,
    });

    expect(await client.request<{ connectors: ExecutorConnector[] }>('/executor/connectors')).toEqual(
      catalog,
    );
    expect(calls[0]?.url).toBe('https://api.test/v1/connectors/catalog');
  });

  test('preserves the legacy approval_execution_id call field', async () => {
    const { calls, fetchImpl } = harness(() => ({ body: { ok: true } }));
    const client = createExecutorClient({
      apiUrl: 'https://api.test',
      token: 'agent-token',
      workspaceId: 'project/1',
      fetchImpl,
    });

    await client.call('gmail', 'send_email', { to: 'agent@example.com' }, {
      approvalExecutionId: 'approval-1',
    });

    expect(calls[0]?.url).toBe(
      'https://api.test/v1/connectors/projects/project%2F1/call',
    );
    expect(calls[0]?.body).toEqual({
      connector: 'gmail',
      action: 'send_email',
      args: { to: 'agent@example.com' },
      approval_execution_id: 'approval-1',
    });
  });
});
