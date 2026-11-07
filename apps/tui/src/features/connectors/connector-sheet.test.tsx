/**
 * `ConnectorSheet` as a user drives it: keys in, frames and HTTP requests out.
 *
 * The SDK writes go to a local `Bun.serve` that records every request (the
 * `main.test.ts` pattern; `mock.module` would leak into other test files).
 * `data` is a prop, so its `refresh` is recorded directly.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AdminConnector, Connection } from '@kortix/sdk';
import { testRender } from '@opentui/react/test-utils';
import { act } from 'react';

import { initKortix, resetKortixForTest } from '../../kortix.ts';
import { ConnectorSheet } from './connector-sheet.tsx';
import type { ProjectConnectorRow } from './connectors-model.ts';
import type { ConnectorsData } from './use-connectors.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SIZE = { width: 100, height: 30 };

const CONNECTOR: AdminConnector = {
  slug: 'linear-ab12cd',
  name: 'Linear',
  provider: 'mcp',
  status: 'active',
  credentialMode: 'shared',
  authorizationStrategy: 'project',
  sensitive: false,
  actions: [],
  authSecret: 'LINEAR_TOKEN',
  secretSet: true,
};

const ACCOUNT: Connection = {
  connection_id: 'c-1',
  connector_alias: 'linear-ab12cd',
  owner_type: 'member',
  owner_id: 'u-me',
  label: 'Linear',
  status: 'active',
  is_default: true,
  metadata: {},
  authorized: true,
};

interface Recorded {
  method: string;
  path: string;
  body: string;
}

let server: ReturnType<typeof Bun.serve>;
const requests: Recorded[] = [];

/** Records every request and answers it. */
async function record(request: Request): Promise<Response> {
  const url = new URL(request.url);
  requests.push({ method: request.method, path: url.pathname, body: await request.text() });
  return Response.json({ ok: true });
}

/** Records every request and fails it after `ms`: a write still pending when the test acts. */
const failAfter = (ms: number) => async (request: Request) => {
  await record(request);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return Response.json({ error: 'nope' }, { status: 500 });
};

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

const writes = () =>
  requests.filter((request) => request.method !== 'GET').map((request) => [request.method, request.path]);

interface Log {
  toasts: Array<[string, string | undefined]>;
  busy: boolean[];
  refreshes: number;
  removed: number;
}

function connectorsData(over: Partial<ConnectorsData> = {}): ConnectorsData {
  return {
    loading: false,
    error: null,
    connectors: [CONNECTOR],
    connections: [ACCOUNT],
    catalog: [],
    catalogTotal: 0,
    catalogLoading: false,
    catalogHasMore: false,
    loadMoreCatalog: () => {},
    accountId: 'acc-1',
    projectName: 'Demo',
    viewerId: 'u-me',
    viewerEmail: 'me@example.test',
    canWrite: true,
    canManageConnections: true,
    candidates: [
      { kind: 'member', id: 'u-ada', label: 'ada@example.test' },
      { kind: 'group', id: 'g-eng', label: 'Engineering' },
    ],
    refresh: async () => {},
    ...over,
  };
}

async function mount(accounts: Connection[] = [ACCOUNT]) {
  const log: Log = { toasts: [], busy: [], refreshes: 0, removed: 0 };
  const row: ProjectConnectorRow = {
    kind: 'connector',
    id: `c:${CONNECTOR.slug}`,
    slug: CONNECTOR.slug,
    name: CONNECTOR.name,
    connector: CONNECTOR,
    tone: 'connected',
    accounts,
  };
  const rendered = await testRender(
    <ConnectorSheet
      projectId="p-1"
      row={row}
      data={connectorsData({
        connections: accounts,
        refresh: async () => {
          log.refreshes += 1;
        },
      })}
      focused
      width={SIZE.width}
      height={SIZE.height}
      webBaseUrl="http://127.0.0.1:9"
      addRequest={false}
      onAddRequestHandled={() => {}}
      onToast={(message, kind) => log.toasts.push([message, kind])}
      onBusy={(busy) => log.busy.push(busy)}
      onRemoved={() => {
        log.removed += 1;
      }}
    />,
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

describe('<ConnectorSheet/> credential', () => {
  test('credential → save: x opens a masked field, typed and pasted text append, Enter saves, refreshes, toasts and closes', async () => {
    const view = await mount();
    expect(view.captureCharFrame()).toContain('› Linear · Default');
    await key(view, 'x');
    expect(view.log.busy).toEqual([true]);
    let frame = view.captureCharFrame();
    expect(frame).toContain('Set credential · Linear');
    expect(frame).toContain('type or paste · Enter save · Esc cancel');

    await type(view, 'ab');
    await paste(view, 'cd\r\nef\n');
    frame = view.captureCharFrame();
    // The paste lost its line breaks: six characters, six bullets, never the text.
    expect(frame).toContain('▌ LINEAR_TOKEN  ••••••');
    expect(frame).not.toContain('abcdef');

    await key(view, 'return');
    await settle(view.flush, 150);
    expect(writes()).toEqual([['PUT', '/v1/workspaces/p-1/connections/c-1/credential']]);
    expect(requests.filter((request) => request.method === 'PUT').map((request) => JSON.parse(request.body))).toEqual([
      { value: 'abcdef' },
    ]);
    expect(view.log.refreshes).toBe(1);
    expect(view.log.toasts).toEqual([['Saved as Linear', undefined]]);
    expect(view.log.busy).toEqual([true, false]);
    expect(view.captureCharFrame()).toContain('Accounts · 1');
    view.renderer.destroy();
  });

  test('Esc cancels the credential without a write; an empty value does not save', async () => {
    const view = await mount();
    await key(view, 'x');
    await key(view, 'return');
    expect(view.captureCharFrame()).toContain('Set credential · Linear');
    await key(view, 'escape');
    expect(view.log.busy).toEqual([true, false]);
    expect(writes()).toEqual([]);
    view.renderer.destroy();
  });

  test('a failed write refreshes, toasts the error and keeps the flow open', async () => {
    const view = await mount();
    server.reload({ fetch: failAfter(0) });
    try {
      await key(view, 'x');
      await type(view, 'tok');
      await key(view, 'return');
      await settle(view.flush, 150);
    } finally {
      server.reload({ fetch: record });
    }
    expect(view.log.refreshes).toBe(1);
    expect(view.log.toasts.map(([, kind]) => kind)).toEqual(['error']);
    expect(view.log.busy).toEqual([true]);
    expect(view.captureCharFrame()).toContain('Set credential · Linear');
    view.renderer.destroy();
  });

  test('a paste while the save is pending is dropped: the field keeps what was typed', async () => {
    const view = await mount();
    server.reload({ fetch: failAfter(300) });
    try {
      await key(view, 'x');
      await type(view, 'ab');
      await key(view, 'return');
      expect(view.captureCharFrame()).toContain('Saving credential…');
      await paste(view, 'cd');
      await settle(view.flush, 400);
    } finally {
      server.reload({ fetch: record });
    }
    expect(view.log.toasts.map(([, kind]) => kind)).toEqual(['error']);
    expect(view.captureCharFrame()).toContain('▌ LINEAR_TOKEN  ••');
    expect(view.captureCharFrame()).not.toContain('▌ LINEAR_TOKEN  •••');
    view.renderer.destroy();
  });
});

describe('<ConnectorSheet/> sign-in', () => {
  test('unmounting during a sign-in aborts it: its late failure toasts nothing', async () => {
    const view = await mount();
    server.reload({ fetch: failAfter(200) });
    try {
      await key(view, 's');
      expect(view.captureCharFrame()).toContain('Connect Linear');
      expect(view.captureCharFrame()).toContain('Starting authorization…');
      expect(writes()).toEqual([['POST', '/v1/workspaces/p-1/connections/c-1/oauth2/discover-resource']]);
      await act(async () => {
        view.renderer.destroy();
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      server.reload({ fetch: record });
    }
    // Unmount releases the keys; the aborted sign-in then ends its step, which releases them again.
    expect(view.log.busy).toEqual([true, false, false]);
    expect(view.log.toasts).toEqual([]);
  });
});

describe('<ConnectorSheet/> confirm', () => {
  test('confirm → remove: D asks, y removes the connector, refreshes, toasts, closes and hands back', async () => {
    const view = await mount();
    await key(view, 'D');
    expect(view.captureCharFrame()).toContain('Remove Linear');
    expect(view.captureCharFrame()).toContain('y confirm · Esc cancel');
    await key(view, 'y');
    await settle(view.flush, 150);
    expect(writes()).toEqual([['DELETE', '/v1/connectors/workspaces/p-1/connectors/linear-ab12cd']]);
    expect(view.log.refreshes).toBe(1);
    expect(view.log.toasts).toEqual([['Linear removed', undefined]]);
    expect(view.log.removed).toBe(1);
    expect(view.log.busy).toEqual([true, false]);
    view.renderer.destroy();
  });

  test('confirm → disconnect: d asks, y revokes the account', async () => {
    const view = await mount();
    await key(view, 'd');
    expect(view.captureCharFrame()).toContain('Disconnect "Linear"?');
    await key(view, 'y');
    await settle(view.flush, 150);
    expect(writes()).toEqual([['PUT', '/v1/workspaces/p-1/connections/c-1/revoke']]);
    expect(view.log.toasts).toEqual([['Disconnected', undefined]]);
    expect(view.log.busy).toEqual([true, false]);
    view.renderer.destroy();
  });
});

describe('<ConnectorSheet/> add account', () => {
  test('label → access → pick: a names the account, j/j picks "specific", Enter lists the candidates to mark', async () => {
    const view = await mount();
    await key(view, 'a');
    expect(view.log.busy).toEqual([true]);
    let frame = view.captureCharFrame();
    expect(frame).toContain('Add a Linear account');
    expect(frame).toContain('Name · Enter continue · Esc cancel');
    await key(view, 'return');

    frame = view.captureCharFrame();
    expect(frame).toContain('Who can use it');
    expect(frame).toContain('● 1');
    await key(view, 'j');
    await key(view, 'j');
    frame = view.captureCharFrame();
    expect(frame).toContain('● 3');
    expect(frame).toContain('Enter pick');
    await key(view, 'return');

    frame = view.captureCharFrame();
    expect(frame).toContain('Specific people, groups, or agents');
    expect(frame).toContain('› [ ] ada@example.test');
    expect(frame).toContain('[ ] Engineering');
    await key(view, ' ');
    await key(view, 'j');
    await key(view, ' ');
    await key(view, ' ');
    frame = view.captureCharFrame();
    expect(frame).toContain('[x] ada@example.test');
    expect(frame).toContain('› [ ] Engineering');
    expect(frame).toContain('Enter continue (1 selected)');
    await key(view, 'escape');
    expect(view.captureCharFrame()).toContain('Accounts · 1');
    expect(view.log.busy).toEqual([true, false]);
    expect(writes()).toEqual([]);
    view.renderer.destroy();
  });

  test('an access step without the manage permission keeps "Only you"', async () => {
    const view = await mount();
    await act(async () => {
      view.renderer.destroy();
    });
    const limited = await testRender(
      <ConnectorSheet
        projectId="p-1"
        row={{
          kind: 'connector',
          id: `c:${CONNECTOR.slug}`,
          slug: CONNECTOR.slug,
          name: CONNECTOR.name,
          connector: CONNECTOR,
          tone: 'connected',
          accounts: [ACCOUNT],
        }}
        data={connectorsData({ canManageConnections: false })}
        focused
        width={SIZE.width}
        height={SIZE.height}
        webBaseUrl="http://127.0.0.1:9"
        addRequest
        onAddRequestHandled={() => {}}
        onToast={() => {}}
        onBusy={() => {}}
        onRemoved={() => {}}
      />,
      SIZE,
    );
    await settle(limited.flush);
    // `addRequest` opens Add account once.
    expect(limited.captureCharFrame()).toContain('Add a Linear account');
    await act(async () => {
      limited.mockInput.pressEnter();
    });
    await settle(limited.flush);
    await act(async () => {
      limited.mockInput.pressKey('j');
    });
    await settle(limited.flush);
    const frame = limited.captureCharFrame();
    expect(frame).toContain('● 1');
    expect(frame).toContain("Sharing an account needs permission to manage the workspace's connections.");
    limited.renderer.destroy();
  });

  test('unmounting with a flow open releases the keys', async () => {
    const view = await mount();
    await key(view, 'a');
    await act(async () => {
      view.renderer.destroy();
    });
    expect(view.log.busy).toEqual([true, false]);
  });
});
