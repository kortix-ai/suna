import { describe, expect, test } from 'bun:test';

import type { ConnectorDraftInput } from '@kortix/sdk';

import { connectApp, connectionSlugFor, type ConnectAppDeps } from './connect-app';

const gmail = { slug: 'gmail', name: 'Gmail', provider: 'composio' as const };

function deps(overrides: Partial<ConnectAppDeps> = {}) {
  const calls: string[] = [];
  const drafts: ConnectorDraftInput[] = [];
  const base: ConnectAppDeps = {
    create: async (_projectId, draft) => {
      calls.push('create');
      drafts.push(draft);
      return { ok: true };
    },
    start: async () => {
      calls.push('start');
      return { connected: false, connectUrl: 'https://auth.test' };
    },
    finalize: async () => {
      calls.push('finalize');
      return { connected: true };
    },
    // Runs start then finalize, the way the popup flow does.
    runFlow: async (start, finalize) => {
      calls.push('popup');
      await start();
      await finalize();
      return { connected: true };
    },
    ...overrides,
  };
  return { base, calls, drafts };
}

describe('connectApp', () => {
  // The popup must open inside the click, before any request, or the
  // browser blocks it. So the connector is created INSIDE the flow's start.
  test('opens the popup first, then adds the connector, then signs in', async () => {
    const { base, calls, drafts } = deps();

    await connectApp(
      { projectId: 'p1', app: gmail, connectorSlug: 'gmail-r1', created: false },
      base,
    );

    expect(calls).toEqual(['popup', 'create', 'start', 'finalize']);
    expect(drafts.map((d) => [d.slug, d.app, d.provider])).toEqual([
      ['gmail-r1', 'gmail', 'composio'],
    ]);
  });

  // A retry after a closed popup must not leave a second connector behind.
  test('a retry reuses the connector it already added', async () => {
    const { base, calls } = deps();

    await connectApp(
      { projectId: 'p1', app: gmail, connectorSlug: 'gmail-r1', created: true },
      base,
    );

    expect(calls).toEqual(['popup', 'start', 'finalize']);
  });

  test('reports the add as soon as it lands, even if sign-in then fails', async () => {
    let added = false;
    const { base } = deps({
      start: async () => {
        throw new Error('The connection popup closed before authorization completed.');
      },
    });

    await expect(
      connectApp(
        { projectId: 'p1', app: gmail, connectorSlug: 'gmail-r1', created: false },
        base,
        () => {
          added = true;
        },
      ),
    ).rejects.toThrow('popup closed');
    expect(added).toBe(true);
  });

  test('a manifest sync error stops before sign-in', async () => {
    const { base, calls } = deps({
      create: async () => ({
        ok: true,
        sync: { errors: [{ slug: 'gmail-r1', error: 'bad yaml' }] },
      }),
    });

    await expect(
      connectApp({ projectId: 'p1', app: gmail, connectorSlug: 'gmail-r1', created: false }, base),
    ).rejects.toThrow('bad yaml');
    expect(calls).toEqual(['popup']);
  });
});

describe('connectionSlugFor', () => {
  test('keeps the slug a first attempt chose', () => {
    expect(connectionSlugFor(gmail, 'gmail-keep', [], () => 'x')).toBe('gmail-keep');
  });

  test('proposes a fresh slug that the project does not already use', () => {
    let n = 0;
    expect(connectionSlugFor(gmail, undefined, ['gmail-r1'], () => `r${++n}`)).toBe('gmail-r2');
  });
});
