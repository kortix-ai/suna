import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Button } from '@/components/ui/button';
import { useConnectorGateStore } from '@/stores/connector-gate-store';

/**
 * `ConnectAppsStrip`'s Connect button now runs `createConnector` (from
 * `@kortix/sdk`) before it ever opens the gate — see the component's own
 * header comment for why. `mock.module` replaces `@kortix/sdk` for the rest
 * of this file's run, so the real module is spread first (repo convention —
 * see `connect-apps-strip.tsx`'s task brief / CLAUDE.md: "if you mock.module
 * the gate store, spread the real module"). Only `createConnector` is
 * overridden; everything else (`ApiError` included — the component's own
 * `err instanceof ApiError` check needs the SAME class reference the mock
 * throws) stays the genuine export.
 *
 * `@/components/ui/toast` is mocked too, same spread rule — not to assert on
 * toast copy (out of scope here), but because `errorToast`/`warningToast`
 * read `window.innerWidth` (`toast.tsx:206`/`:242`) and this Bun run has no
 * DOM. Without the mock, the failure/sync-error branches this file exists to
 * pin would throw a `ReferenceError` from INSIDE the component's own `catch`,
 * masking the real assertion under an unrelated crash.
 *
 * Both mocks are registered, then the SUT is imported dynamically — same
 * order `session-audit-shared.test.ts` uses — so `connect-apps-strip.tsx`'s
 * own static imports resolve to the mocked bindings rather than ones already
 * captured by an earlier import.
 */
type CreateConnectorCall = { projectId: string; draft: Record<string, unknown> };
let createConnectorCalls: CreateConnectorCall[] = [];
let createConnectorImpl: (
  projectId: string,
  draft: Record<string, unknown>,
) => Promise<{ ok: boolean; sync?: { synced: number; errors: Array<{ slug: string; error: string }> } }> =
  async () => ({ ok: true });

const realSdk = await import('@kortix/sdk');

await mock.module('@kortix/sdk', () => ({
  ...realSdk,
  createConnector: async (projectId: string, draft: Record<string, unknown>) => {
    createConnectorCalls.push({ projectId, draft });
    return createConnectorImpl(projectId, draft);
  },
}));

const realToast = await import('@/components/ui/toast');
const toastCalls: Array<{ kind: 'error' | 'warning'; message: string }> = [];

await mock.module('@/components/ui/toast', () => ({
  ...realToast,
  errorToast: (message: string) => {
    toastCalls.push({ kind: 'error', message });
  },
  warningToast: (message: string) => {
    toastCalls.push({ kind: 'warning', message });
  },
}));

const { ApiError } = realSdk;
const { ConnectAppsStrip, DEFAULT_CONNECTORS } = await import('./connect-apps-strip');

/**
 * `ConnectAppsStrip` holds no hooks of its own (see its header comment on
 * why the gate action is read via `getState()` rather than the
 * `useConnectorGateStore(selector)` hook), so — same as `ContextCard`'s
 * `cardBody` in `context-card.test.tsx` — it can be called directly as a
 * plain function and its returned element tree walked without a DOM.
 */
function strip(projectId: string | undefined): ReactNode {
  return ConnectAppsStrip({ projectId });
}

/**
 * Every `<Button>` element in an unrendered React tree, in document order.
 *
 * Unlike `context-card.test.tsx`'s `buttonsIn` (which matches raw host
 * `<button>` elements), every clickable control here is the `Button` UI
 * component, so `element.type` is that function, never the string
 * `'button'` — matched by identity against the same import this test uses.
 */
function buttonsIn(node: ReactNode, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) buttonsIn(child, found);
    return found;
  }
  if (!isValidElement(node)) return found;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === Button) found.push(element);
  buttonsIn(element.props.children, found);
  return found;
}

/** Every "Connect" row button — never the `asChild` "View all" control,
 *  which has no `onClick` (its click is the plain `<Link>` navigation). */
function connectButtonsIn(node: ReactNode): ReactElement[] {
  return buttonsIn(node).filter((b) => typeof (b.props as { onClick?: unknown }).onClick === 'function');
}

function connectButtonFor(node: ReactNode, slug: string): ReactElement {
  const index = DEFAULT_CONNECTORS.findIndex((c) => c.slug === slug);
  return connectButtonsIn(node)[index];
}

async function clickConnect(node: ReactNode, slug: string): Promise<void> {
  const button = connectButtonFor(node, slug) as ReactElement<{ onClick?: () => Promise<void> }>;
  await button.props.onClick?.();
}

beforeEach(() => {
  useConnectorGateStore.setState({
    isOpen: false,
    projectId: null,
    connectorConnections: [],
    retry: null,
  });
  createConnectorCalls = [];
  createConnectorImpl = async () => ({ ok: true });
  toastCalls.length = 0;
});

describe('ConnectAppsStrip', () => {
  test('renders nothing without a projectId', () => {
    expect(strip(undefined)).toBeNull();
  });

  test('renders one row per default connector, plus the View all control', () => {
    const html = renderToStaticMarkup(<>{strip('proj-1')}</>);
    for (const connector of DEFAULT_CONNECTORS) {
      expect(html).toContain(connector.name);
      expect(html).toContain(connector.value);
    }
    // One real host <button> per "Connect" row. "View all" is `Button
    // asChild` over a `<Link>` — it renders straight through to the link's
    // own `<a>`, so it contributes zero host `<button>` tags here.
    expect(html.match(/<button[^>]*>/g)).toHaveLength(DEFAULT_CONNECTORS.length);
  });

  test('Connect declares the connector (create_only, project-owned), THEN opens the gate for exactly that one, with a no-op retry', async () => {
    const tree = strip('proj-1');
    await clickConnect(tree, 'gmail');

    // The declare call — pinned so a future edit can't skip straight to the
    // gate (the exact regression the review caught: doing that 404s against
    // `reconcileConnection` on a project that has never declared this
    // connector).
    expect(createConnectorCalls).toHaveLength(1);
    expect(createConnectorCalls[0].projectId).toBe('proj-1');
    expect(createConnectorCalls[0].draft).toMatchObject({
      slug: 'gmail',
      name: 'Gmail',
      provider: 'pipedream',
      app: 'gmail',
      authorization_strategy: 'project',
      create_only: true,
    });

    // The declare resolves BEFORE the gate opens — a same-tick synchronous
    // check here would pass even if the two were reordered, so the pinned
    // fact is "the awaited click leaves the gate open", not "it opens
    // eventually".
    const state = useConnectorGateStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.projectId).toBe('proj-1');
    // Exactly one connector — the clicked row's, not the whole default
    // list — is what makes this "in place, no navigation" (task brief).
    expect(state.connectorConnections).toEqual([
      { id: 'gmail', slug: 'gmail', name: 'Gmail', authorization_strategy: 'project' },
    ]);
    expect(state.retry).not.toBeNull();
    expect(() => state.retry?.()).not.toThrow();
  });

  test('a 409 (already declared) is treated as success — the gate still opens', async () => {
    createConnectorImpl = async () => {
      throw new ApiError('Connector slug "gmail" already exists', { status: 409 });
    };

    const tree = strip('proj-1');
    await clickConnect(tree, 'gmail');

    expect(createConnectorCalls).toHaveLength(1);
    const state = useConnectorGateStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.connectorConnections).toEqual([
      { id: 'gmail', slug: 'gmail', name: 'Gmail', authorization_strategy: 'project' },
    ]);
    // No error surfaced for the idempotent path — a 409 here is success, not
    // a failure the user needs to see.
    expect(toastCalls).toEqual([]);
  });

  test('a non-409 declare failure stops short of the gate and surfaces errorToast', async () => {
    createConnectorImpl = async () => {
      throw new ApiError('project not found', { status: 404 });
    };

    const tree = strip('proj-1');
    await clickConnect(tree, 'gmail');

    expect(createConnectorCalls).toHaveLength(1);
    expect(useConnectorGateStore.getState().isOpen).toBe(false);
    expect(toastCalls).toEqual([{ kind: 'error', message: 'project not found' }]);
  });

  test('a sync failure (manifest written, sync failed) stops short of the gate and surfaces warningToast', async () => {
    createConnectorImpl = async () => ({
      ok: true,
      sync: { synced: 0, errors: [{ slug: 'gmail', error: 'upstream app not found' }] },
    });

    const tree = strip('proj-1');
    await clickConnect(tree, 'gmail');

    expect(createConnectorCalls).toHaveLength(1);
    expect(useConnectorGateStore.getState().isOpen).toBe(false);
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].kind).toBe('warning');
    expect(toastCalls[0].message).toContain('upstream app not found');
  });

  test('View all links to the canonical connectors route, never a ?section= deep link', () => {
    const html = renderToStaticMarkup(<>{strip('proj-42')}</>);
    expect(html).toContain('href="/projects/proj-42/connectors"');
    expect(html).not.toContain('section=');
  });
});
