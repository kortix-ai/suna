/**
 * `ProviderSheet` as a user drives it: keys in, frames and HTTP requests out.
 *
 * The SDK writes go to a local `Bun.serve` that records every request (the
 * `main.test.ts` pattern; `mock.module` would leak into other test files).
 * `data` is a prop, so its `refresh` is recorded directly.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { type LlmProviderEntry, buildLlmProviderCatalog } from '@kortix/sdk';
import { testRender } from '@opentui/react/test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';

import { initKortix, resetKortixForTest } from '../../kortix.ts';
import { ProviderSheet } from './provider-sheet.tsx';
import type { ProviderRow } from './providers-model.ts';
import type { ProvidersData } from './use-providers.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = { width: 90, height: 30 };

const CATALOGUE: LlmProviderEntry[] = buildLlmProviderCatalog({
  providers: [
    { id: 'zeta', name: 'Zeta', env: ['ZETA_A', 'ZETA_B'], api: 'https://api.zeta.test/v1', models: [] },
    { id: 'acme', name: 'Acme', env: ['ACME_API_KEY'], api: 'https://api.acme.test/v1', models: [] },
  ],
});
const entry = (id: string): LlmProviderEntry => {
  const found = CATALOGUE.find((item) => item.id === id);
  if (!found) throw new Error(`no ${id} in the test catalogue`);
  return found;
};

interface Recorded {
  method: string;
  path: string;
  body: string;
}

let server: ReturnType<typeof Bun.serve>;
const requests: Recorded[] = [];

/** Records every request; answers a new pooled key like the API does. */
async function record(request: Request): Promise<Response> {
  const url = new URL(request.url);
  requests.push({ method: request.method, path: url.pathname, body: await request.text() });
  if (url.pathname.endsWith('/secret-resources') && request.method === 'POST') {
    return Response.json({ secret_id: 'sec-new', label: 'Work', provider_id: 'acme' });
  }
  return Response.json({ ok: true });
}

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: record });
  resetKortixForTest();
  initKortix({
    name: 'test',
    backendUrl: `http://127.0.0.1:${server.port}/v1`,
    token: 'test-token',
    accountId: 'acc-1',
    userEmail: '',
    source: 'env',
  });
});

afterAll(() => {
  resetKortixForTest();
  server.stop(true);
});

beforeEach(() => {
  requests.length = 0;
});

interface Log {
  toasts: Array<[string, string | undefined]>;
  busy: boolean[];
  refreshed: Array<string | undefined>;
}

function providersData(over: Partial<ProvidersData> = {}): ProvidersData {
  return {
    loading: false,
    error: null,
    catalogue: CATALOGUE,
    managed: null,
    byId: new Map(CATALOGUE.map((item) => [item.id, item])),
    connectedIds: new Set(),
    pooled: false,
    accountId: 'acc-1',
    accounts: [],
    accountsReadAt: 0,
    pooledIds: new Set(),
    disabledProviders: new Set(),
    defaultProvider: undefined,
    viewerId: 'u-me',
    viewerEmail: 'me@example.test',
    members: [
      { userId: 'u-me', email: 'me@example.test', accountRole: 'owner' },
      { userId: 'u-ada', email: 'ada@example.test', accountRole: 'member' },
      { userId: 'u-lin', email: 'lin@example.test', accountRole: 'member' },
    ],
    canWrite: true,
    setProviderEnabled: async () => {},
    accessUpdating: false,
    refresh: async () => {},
    ...over,
  };
}

function row(id: string, status: ProviderRow['status']): ProviderRow {
  const item = entry(id);
  return { id, label: item.label, method: 'key', modelCount: 0, hint: item.hint, status, disabled: false };
}

async function mount(id: string, status: ProviderRow['status'], data: Partial<ProvidersData> = {}) {
  const log: Log = { toasts: [], busy: [], refreshed: [] };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = providersData({
    ...data,
    refresh: async (expect) => {
      log.refreshed.push(expect);
    },
  });
  const rendered = await testRender(
    <QueryClientProvider client={client}>
      <ProviderSheet
        projectId="p-1"
        entry={entry(id)}
        row={row(id, status)}
        data={props}
        focused
        width={SIZE.width}
        height={SIZE.height}
        onToast={(message, kind) => log.toasts.push([message, kind])}
        onBusy={(busy) => log.busy.push(busy)}
      />
    </QueryClientProvider>,
    SIZE,
  );
  await settle(rendered.flush);
  return { ...rendered, log };
}

async function settle(flush: () => Promise<void>, ms = 60): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  await flush();
}

type Mounted = Awaited<ReturnType<typeof mount>>;

async function key(view: Mounted, name: string): Promise<void> {
  await act(async () => {
    if (name === 'return') view.mockInput.pressEnter();
    else if (name === 'escape') view.mockInput.pressEscape();
    else view.mockInput.pressKey(name);
  });
  await settle(view.flush);
}

async function type(view: Mounted, text: string): Promise<void> {
  for (const char of text) await key(view, char);
}

async function paste(view: Mounted, text: string): Promise<void> {
  await act(async () => {
    await view.mockInput.pasteBracketedText(text);
  });
  await settle(view.flush);
}

/** Wait for the write the last key started: its request, then the refresh and toast. */
async function settleWrite(view: Mounted): Promise<void> {
  await settle(view.flush, 150);
}

describe('<ProviderSheet/> project key (`key` sheet)', () => {
  test('K opens the key flow: busy, one masked field per env var, typed and pasted text appended', async () => {
    const view = await mount('zeta', 'none');
    expect(view.captureCharFrame()).toContain('K add key · Esc back');
    await key(view, 'K');
    expect(view.log.busy).toEqual([true]);
    let frame = view.captureCharFrame();
    expect(frame).toContain('API key');
    expect(frame).toContain('Stored encrypted. Kortix never shows it again.');
    expect(frame).toContain('▌ ZETA_A');
    expect(frame).toContain('Enter next field · Esc cancel');

    await type(view, 'ab');
    await paste(view, 'cd\r\nef\n');
    frame = view.captureCharFrame();
    // The paste lost its line breaks: six characters, six bullets, never the text.
    expect(frame).toContain('▌ ZETA_A  ••••••');
    expect(frame).not.toContain('abcdef');
    view.renderer.destroy();
  });

  test('key → save: Enter walks the fields, the last Enter upserts each one, refreshes, toasts and closes', async () => {
    const view = await mount('zeta', 'none');
    await key(view, 'K');
    await type(view, 'aa');
    await key(view, 'return');
    expect(view.captureCharFrame()).toContain('▌ ZETA_B');
    expect(view.captureCharFrame()).toContain('Enter save key · Esc cancel');
    await type(view, 'bb');
    await key(view, 'return');
    await settleWrite(view);

    const writes = requests.filter((request) => request.method !== 'GET');
    expect(writes.map((request) => [request.method, request.path])).toEqual([
      ['POST', '/v1/workspaces/p-1/secrets'],
      ['POST', '/v1/workspaces/p-1/secrets'],
    ]);
    expect(writes.map((request) => [JSON.parse(request.body).name, JSON.parse(request.body).value])).toEqual([
      ['ZETA_A', 'aa'],
      ['ZETA_B', 'bb'],
    ]);
    expect(view.log.refreshed).toEqual(['zeta']);
    expect(view.log.toasts).toEqual([['Zeta connected. /model lists its models.', undefined]]);
    expect(view.log.busy).toEqual([true, false]);
    expect(view.captureCharFrame()).toContain('K add key · Esc back');
    view.renderer.destroy();
  });

  test('an empty field does not advance; Esc cancels without a write', async () => {
    const view = await mount('zeta', 'none');
    await key(view, 'K');
    await key(view, 'return');
    expect(view.captureCharFrame()).toContain('▌ ZETA_A');
    await key(view, 'escape');
    expect(view.log.busy).toEqual([true, false]);
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
    view.renderer.destroy();
  });

  test('confirm → remove: d asks, y deletes every key, refreshes, toasts and closes', async () => {
    const view = await mount('zeta', 'connected', { connectedIds: new Set(['zeta']) });
    await key(view, 'd');
    expect(view.captureCharFrame()).toContain('Remove key?');
    expect(view.captureCharFrame()).toContain('y confirm · Esc cancel');
    await key(view, 'y');
    await settleWrite(view);
    expect(
      requests.filter((request) => request.method !== 'GET').map((request) => [request.method, request.path]),
    ).toEqual([
      ['DELETE', '/v1/workspaces/p-1/secrets/ZETA_A'],
      ['DELETE', '/v1/workspaces/p-1/secrets/ZETA_B'],
    ]);
    expect(view.log.refreshed).toEqual([undefined]);
    expect(view.log.toasts).toEqual([['Zeta disconnected', undefined]]);
    expect(view.log.busy).toEqual([true, false]);
    view.renderer.destroy();
  });

  test('a failed write toasts the error and keeps the flow open', async () => {
    const view = await mount('zeta', 'connected', { connectedIds: new Set(['zeta']) });
    server.reload({
      fetch: async (request) => {
        const url = new URL(request.url);
        requests.push({ method: request.method, path: url.pathname, body: await request.text() });
        return Response.json({ error: 'nope' }, { status: 500 });
      },
    });
    try {
      await key(view, 'd');
      await key(view, 'y');
      await settleWrite(view);
    } finally {
      server.reload({ fetch: record });
    }
    expect(view.log.refreshed).toEqual([]);
    expect(view.log.toasts.map(([, kind]) => kind)).toEqual(['error']);
    expect(view.log.busy).toEqual([true]);
    expect(view.captureCharFrame()).toContain('Remove key?');
    view.renderer.destroy();
  });

  test('unmounting with a flow open releases the keys', async () => {
    const view = await mount('zeta', 'none');
    await key(view, 'K');
    await act(async () => {
      view.renderer.destroy();
    });
    expect(view.log.busy).toEqual([true, false]);
  });
});

describe('<ProviderSheet/> pooled key accounts (`pooled-key` sheet)', () => {
  test('label → access → members → key → save creates a key shared with the picked members', async () => {
    const view = await mount('acme', 'none', { pooled: true });
    expect(view.captureCharFrame()).toContain('Acme API keys');
    expect(view.captureCharFrame()).toContain('No keys yet.');

    await key(view, 'a');
    expect(view.log.busy).toEqual([true]);
    expect(view.captureCharFrame()).toContain('Add key · Acme');
    expect(view.captureCharFrame()).toContain('Label · Enter continue · Esc cancel');
    await type(view, 'Work');
    await key(view, 'return');

    let frame = view.captureCharFrame();
    expect(frame).toContain('Who can use this connection?');
    expect(frame).toContain('● 1 Only you');
    await key(view, 'j');
    expect(view.captureCharFrame()).toContain('● 2 Everyone in this workspace');
    await key(view, 'j');
    frame = view.captureCharFrame();
    expect(frame).toContain('● 3 Specific members');
    expect(frame).toContain('Enter pick members');
    await key(view, 'return');

    frame = view.captureCharFrame();
    expect(frame).toContain('Specific members');
    // The viewer is not listed: they own the connection.
    expect(frame).not.toContain('me@example.test');
    expect(frame).toContain('› [ ] ada@example.test');
    await key(view, ' ');
    await key(view, 'j');
    await key(view, ' ');
    await key(view, ' ');
    frame = view.captureCharFrame();
    expect(frame).toContain('[x] ada@example.test');
    expect(frame).toContain('› [ ] lin@example.test');
    expect(frame).toContain('Enter continue (1 selected)');
    await key(view, 'return');

    frame = view.captureCharFrame();
    expect(frame).toContain('Add key · Acme');
    expect(frame).toContain('▌ ACME_API_KEY');
    await type(view, 'sk1');
    await key(view, 'return');
    await settleWrite(view);

    const writes = requests.filter((request) => request.method !== 'GET');
    expect(writes.map((request) => [request.method, request.path])).toEqual([
      ['POST', '/v1/accounts/acc-1/secret-resources'],
    ]);
    const body = JSON.parse(writes[0]?.body ?? '');
    expect(body).toMatchObject({
      project_id: 'p-1',
      provider_id: 'acme',
      name: 'ACME_API_KEY',
      label: 'Work',
      value: 'sk1',
      consumer: 'llm_gateway',
      strategy: 'broker',
    });
    expect(JSON.stringify(body)).toContain('u-ada');
    expect(JSON.stringify(body)).not.toContain('u-lin');
    expect(view.log.refreshed).toEqual(['acme']);
    expect(view.log.toasts).toEqual([['Secret saved', undefined]]);
    // Label → access → members swap the flow in place; opening the key step signals busy again.
    expect(view.log.busy).toEqual([true, true, false]);
    view.renderer.destroy();
  });

  test('Esc from any step of the add flow returns to the list without a write', async () => {
    const view = await mount('acme', 'none', { pooled: true });
    await key(view, 'a');
    await type(view, 'Work');
    await key(view, 'return');
    await key(view, 'escape');
    expect(view.captureCharFrame()).toContain('Acme API keys');
    expect(view.log.busy).toEqual([true, false]);
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
    view.renderer.destroy();
  });
});
