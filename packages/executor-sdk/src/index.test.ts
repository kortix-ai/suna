import { describe, expect, test } from 'bun:test';
import {
  ExecutorClient,
  ExecutorError,
  createExecutorClient,
  type ExecutorConnector,
} from './index';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(text: string, init: { status?: number } = {}): Response {
  return new Response(text, { status: init.status ?? 200 });
}

interface Capture {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

function recordingFetch(response: Response | ((c: Capture) => Response)) {
  const calls: Capture[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const capture: Capture = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(capture);
    return typeof response === 'function' ? response(capture) : response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const SAMPLE_CONNECTORS: ExecutorConnector[] = [
  {
    slug: 'gmail',
    name: 'Gmail',
    provider: 'pipedream',
    status: 'connected',
    actions: [
      {
        path: 'send_email',
        name: 'Send Email',
        description: 'Send an email message',
        risk: 'write',
        inputSchema: { type: 'object' },
      },
      {
        path: 'list_messages',
        name: 'List Messages',
        description: '',
        risk: 'read',
        inputSchema: { type: 'object' },
      },
    ],
  },
  {
    slug: 'stripe',
    name: 'Stripe',
    provider: 'openapi',
    status: 'connected',
    actions: [
      {
        path: 'create_charge',
        name: 'Create Charge',
        description: 'Charge a customer card',
        risk: 'destructive',
        inputSchema: {},
      },
    ],
  },
];

describe('ExecutorClient constructor', () => {
  test('throws when apiUrl is blank', () => {
    expect(() => new ExecutorClient({ apiUrl: '   ', token: 't' })).toThrow('apiUrl is required');
  });

  test('throws when token is blank', () => {
    expect(() => new ExecutorClient({ apiUrl: 'https://api.example.com', token: '  ' })).toThrow(
      'token is required',
    );
  });

  test('createExecutorClient returns an ExecutorClient instance', () => {
    const client = createExecutorClient({ apiUrl: 'https://api.example.com', token: 't' });
    expect(client).toBeInstanceOf(ExecutorClient);
  });
});

describe('ExecutorClient url normalization', () => {
  test('appends /v1 when missing', async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ connectors: [] }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    await client.connectors();
    expect(calls[0].url).toBe('https://api.example.com/v1/executor/connectors');
  });

  test('does not double-append /v1 when already present', async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ connectors: [] }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com/v1', token: 't', fetchImpl: impl });
    await client.connectors();
    expect(calls[0].url).toBe('https://api.example.com/v1/executor/connectors');
  });

  test('strips trailing slashes before appending /v1', async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ connectors: [] }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com///', token: 't', fetchImpl: impl });
    await client.connectors();
    expect(calls[0].url).toBe('https://api.example.com/v1/executor/connectors');
  });
});

describe('ExecutorClient routing', () => {
  test('uses legacy flat catalog path when no projectId', async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ connectors: [] }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    await client.connectors();
    expect(calls[0].url).toEndWith('/v1/executor/connectors');
  });

  test('uses project-explicit catalog path when projectId set', async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ connectors: [] }));
    const client = new ExecutorClient({
      apiUrl: 'https://api.example.com',
      token: 't',
      projectId: 'proj-123',
      fetchImpl: impl,
    });
    await client.connectors();
    expect(calls[0].url).toEndWith('/v1/executor/projects/proj-123/catalog');
  });

  test('url-encodes the projectId in the path', async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ connectors: [] }));
    const client = new ExecutorClient({
      apiUrl: 'https://api.example.com',
      token: 't',
      projectId: 'a/b c',
      fetchImpl: impl,
    });
    await client.connectors();
    expect(calls[0].url).toContain('/projects/a%2Fb%20c/catalog');
  });

  test('blank projectId falls back to legacy flat routes', async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ connectors: [] }));
    const client = new ExecutorClient({
      apiUrl: 'https://api.example.com',
      token: 't',
      projectId: '   ',
      fetchImpl: impl,
    });
    await client.connectors();
    expect(calls[0].url).toEndWith('/v1/executor/connectors');
  });

  test('call uses project-explicit call path when projectId set', async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ ok: true }));
    const client = new ExecutorClient({
      apiUrl: 'https://api.example.com',
      token: 't',
      projectId: 'p1',
      fetchImpl: impl,
    });
    await client.call('gmail', 'send_email');
    expect(calls[0].url).toEndWith('/v1/executor/projects/p1/call');
  });

  test('call uses legacy flat call path when no projectId', async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ ok: true }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    await client.call('gmail', 'send_email');
    expect(calls[0].url).toEndWith('/v1/executor/call');
  });
});

describe('ExecutorClient request', () => {
  test('sends bearer authorization and json content-type headers', async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ connectors: [] }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 'secret-token', fetchImpl: impl });
    await client.connectors();
    expect(calls[0].headers.get('Authorization')).toBe('Bearer secret-token');
    expect(calls[0].headers.get('Content-Type')).toBe('application/json');
  });

  test('defaults to GET when no method given', async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ connectors: [] }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    await client.connectors();
    expect(calls[0].method).toBe('GET');
  });

  test('serializes the body as JSON on call', async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ ok: true }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    await client.call('gmail', 'send_email', { to: 'a@b.com' });
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body!)).toEqual({
      connector: 'gmail',
      action: 'send_email',
      args: { to: 'a@b.com' },
    });
  });

  test('defaults args to an empty object on call', async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ ok: true }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    await client.call('gmail', 'send_email');
    expect(JSON.parse(calls[0].body!).args).toEqual({});
  });

  test('omits the body on GET requests', async () => {
    const { impl, calls } = recordingFetch(jsonResponse({ connectors: [] }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    await client.connectors();
    expect(calls[0].body).toBeUndefined();
  });

  test('throws ExecutorError carrying status and parsed body on non-ok', async () => {
    const { impl } = recordingFetch(jsonResponse({ reason: 'forbidden' }, { status: 403 }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    let caught: unknown;
    try {
      await client.request('/anything');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecutorError);
    const error = caught as ExecutorError;
    expect(error.status).toBe(403);
    expect(error.message).toBe('forbidden');
    expect(error.body).toEqual({ reason: 'forbidden' });
    expect(error.name).toBe('ExecutorError');
  });

  test('prefers reason then error then message for the error string', async () => {
    const { impl } = recordingFetch(jsonResponse({ error: 'boom' }, { status: 500 }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    await expect(client.request('/x')).rejects.toThrow('boom');
  });

  test('falls back to HTTP status when error body has no known fields', async () => {
    const { impl } = recordingFetch(jsonResponse({ unrelated: 1 }, { status: 502 }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    await expect(client.request('/x')).rejects.toThrow('HTTP 502');
  });

  test('falls back to HTTP status when error body is not an object', async () => {
    const { impl } = recordingFetch(textResponse('plain error', { status: 400 }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    await expect(client.request('/x')).rejects.toThrow('HTTP 400');
  });

  test('returns null body for an empty successful response', async () => {
    const { impl } = recordingFetch(textResponse('', { status: 200 }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    const result = await client.request('/x');
    expect(result).toBeNull();
  });

  test('returns the raw text when the success body is not valid json', async () => {
    const { impl } = recordingFetch(textResponse('not json', { status: 200 }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    const result = await client.request<string>('/x');
    expect(result).toBe('not json');
  });

  test('strips a leading /v1/ from the path to avoid duplication', async () => {
    const { impl, calls } = recordingFetch(jsonResponse({}));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    await client.request('/v1/some/thing');
    expect(calls[0].url).toBe('https://api.example.com/v1/some/thing');
  });

  test('prefixes a path that lacks a leading slash', async () => {
    const { impl, calls } = recordingFetch(jsonResponse({}));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    await client.request('some/thing');
    expect(calls[0].url).toBe('https://api.example.com/v1/some/thing');
  });
});

describe('ExecutorClient connectors and tools', () => {
  test('returns the connectors array from the catalog body', async () => {
    const { impl } = recordingFetch(jsonResponse({ connectors: SAMPLE_CONNECTORS }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    const connectors = await client.connectors();
    expect(connectors).toHaveLength(2);
    expect(connectors[0].slug).toBe('gmail');
  });

  test('returns an empty array when the catalog omits connectors', async () => {
    const { impl } = recordingFetch(jsonResponse({}));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    expect(await client.connectors()).toEqual([]);
  });

  test('flattens connector actions into namespaced tool matches', async () => {
    const { impl } = recordingFetch(jsonResponse({ connectors: SAMPLE_CONNECTORS }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    const tools = await client.tools();
    expect(tools.map((t) => t.tool)).toEqual([
      'gmail.send_email',
      'gmail.list_messages',
      'stripe.create_charge',
    ]);
    expect(tools[0].connector).toBe('gmail');
    expect(tools[0].action).toBe('send_email');
    expect(tools[0].risk).toBe('write');
  });

  test('falls back to action name when description is empty', async () => {
    const { impl } = recordingFetch(jsonResponse({ connectors: SAMPLE_CONNECTORS }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    const tools = await client.tools();
    const listTool = tools.find((t) => t.tool === 'gmail.list_messages')!;
    expect(listTool.description).toBe('List Messages');
  });
});

describe('ExecutorClient discover', () => {
  test('returns all tools when query is empty', async () => {
    const { impl } = recordingFetch(jsonResponse({ connectors: SAMPLE_CONNECTORS }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    expect(await client.discover()).toHaveLength(3);
  });

  test('matches against tool name and description case-insensitively', async () => {
    const { impl } = recordingFetch(jsonResponse({ connectors: SAMPLE_CONNECTORS }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    const matches = await client.discover('EMAIL');
    expect(matches.map((m) => m.tool)).toEqual(['gmail.send_email']);
  });

  test('matches on description text', async () => {
    const { impl } = recordingFetch(jsonResponse({ connectors: SAMPLE_CONNECTORS }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    const matches = await client.discover('charge');
    expect(matches.map((m) => m.tool)).toEqual(['stripe.create_charge']);
  });

  test('returns an empty array when nothing matches', async () => {
    const { impl } = recordingFetch(jsonResponse({ connectors: SAMPLE_CONNECTORS }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    expect(await client.discover('nonexistent-xyz')).toEqual([]);
  });

  test('respects the limit option', async () => {
    const { impl } = recordingFetch(jsonResponse({ connectors: SAMPLE_CONNECTORS }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    const matches = await client.discover('', { limit: 2 });
    expect(matches).toHaveLength(2);
  });

  test('defaults the limit to 20', async () => {
    const many: ExecutorConnector[] = [
      {
        slug: 'big',
        name: 'Big',
        provider: 'http',
        status: 'connected',
        actions: Array.from({ length: 30 }, (_, i) => ({
          path: `a${i}`,
          name: `A${i}`,
          description: 'thing',
          risk: 'read',
          inputSchema: {},
        })),
      },
    ];
    const { impl } = recordingFetch(jsonResponse({ connectors: many }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    expect(await client.discover('')).toHaveLength(20);
  });
});

describe('ExecutorClient describe', () => {
  test('returns the matching tool', async () => {
    const { impl } = recordingFetch(jsonResponse({ connectors: SAMPLE_CONNECTORS }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    const tool = await client.describe('stripe.create_charge');
    expect(tool?.connector).toBe('stripe');
    expect(tool?.risk).toBe('destructive');
  });

  test('returns null for an unknown tool', async () => {
    const { impl } = recordingFetch(jsonResponse({ connectors: SAMPLE_CONNECTORS }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    expect(await client.describe('does.not.exist')).toBeNull();
  });
});

describe('ExecutorClient call result', () => {
  test('returns the parsed call result body', async () => {
    const { impl } = recordingFetch(jsonResponse({ ok: true, data: { id: 'msg_1' }, risk: 'write' }));
    const client = new ExecutorClient({ apiUrl: 'https://api.example.com', token: 't', fetchImpl: impl });
    const result = await client.call<{ id: string }>('gmail', 'send_email', { to: 'x' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: 'msg_1' });
    expect(result.risk).toBe('write');
  });
});

describe('ExecutorError', () => {
  test('extends Error and stores status and body', () => {
    const err = new ExecutorError('nope', 418, { teapot: true });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('nope');
    expect(err.status).toBe(418);
    expect(err.body).toEqual({ teapot: true });
    expect(err.name).toBe('ExecutorError');
  });
});
