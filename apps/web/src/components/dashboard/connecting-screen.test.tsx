/**
 * Characterization for `ConnectingScreen`, written before the unreferenced
 * no-op `useConnectionToasts` export was removed. The screen is the dashboard's
 * loader; these tests pin the precedence contract — explicit caller props beat
 * the runtime-connection store — and the store-driven modes, driven through the
 * real zustand store.
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const passthrough = ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
  createElement('div', props, children);
const translate = Object.assign((key: string) => key, { raw: (key: string) => key });
mock.module('@/i18n/use-translations', () => ({ useTranslations: () => translate }));
mock.module('@/i18n/use-localized-ui-catalog', () => ({
  translateUiCatalogText: (_catalog: unknown, key: string) => key,
}));
mock.module('@/lib/onboarding/use-app-home', () => ({ useAppHome: () => '/projects' }));
mock.module('@phosphor-icons/react', () => ({
  WarningCircleIcon: passthrough,
  ArrowLeftIcon: passthrough,
  ArrowsLeftRightIcon: passthrough,
  PowerIcon: passthrough,
  WifiSlashIcon: passthrough,
}));
mock.module('@/components/ui/button', () => ({ Button: passthrough }));
mock.module('@/components/ui/loading', () => ({ default: passthrough }));
mock.module('@/components/sidebar/kortix-logo', () => ({ KortixLogo: passthrough }));
mock.module('next/link', () => ({ default: passthrough }));

const sdkReact = await import('@kortix/sdk/react');
const useRuntimeConnectionStore = sdkReact.useRuntimeConnectionStore;
const { ConnectingScreen } = await import('./connecting-screen');

afterEach(() => {
  // Reset the fields these tests set, so the next test starts from a quiet
  // connection.
  useRuntimeConnectionStore.setState({
    status: 'connecting',
    wasConnected: false,
    initialCheckDone: false,
    reconnectAttempts: 0,
    disconnectedAt: null,
    healthy: null,
  });
});

async function render(props: NonNullable<Parameters<typeof ConnectingScreen>[0]> = {}) {
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(<ConnectingScreen {...props} />);
  });
  if (!renderer) throw new Error('ConnectingScreen did not render');
  return renderer;
}

/** Host-element tags of the rendered tree — a full-screen shell or a pill. */
function tags(renderer: ReturnType<typeof create>): string[] {
  const out: string[] = [];
  const walk = (node: { type?: unknown; children?: unknown } | null) => {
    if (!node) return;
    if (typeof node.type === 'string') out.push(node.type);
    const children = node.children;
    if (Array.isArray(children)) for (const child of children) walk(child as never);
    else if (children && typeof children === 'object') walk(children as never);
  };
  walk(renderer.toJSON() as never);
  return out;
}

test('explicit error beats a connected, healthy store', async () => {
  useRuntimeConnectionStore.setState({ status: 'connected', healthy: true });
  const renderer = await render({ error: { message: 'boom' } });
  expect(JSON.stringify(renderer.toJSON())).toContain('boom');
  // The store alone would render null for a connected session.
  expect(tags(renderer)).not.toEqual([]);
  await act(async () => renderer.unmount());
});

test('explicit stopped and provisioning beat the store too', async () => {
  useRuntimeConnectionStore.setState({ status: 'connected', healthy: true });
  const stopped = await render({ stopped: { name: 'box' } });
  expect(JSON.stringify(stopped.toJSON())).toContain('box');
  await act(async () => stopped.unmount());

  const provisioning = await render({
    provisioning: { progress: 40, stageLabel: 'Starting' },
  });
  expect(JSON.stringify(provisioning.toJSON())).toContain('Starting');
  await act(async () => provisioning.unmount());
});

test('a connected, healthy store renders nothing (the workspace is up)', async () => {
  useRuntimeConnectionStore.setState({ status: 'connected', healthy: true });
  const renderer = await render({});
  expect(renderer.toJSON()).toBeNull();
  await act(async () => renderer.unmount());
});

test('a mid-session drop renders the floating reconnect pill, not a full screen', async () => {
  useRuntimeConnectionStore.setState({
    status: 'unreachable',
    wasConnected: true,
    initialCheckDone: true,
    disconnectedAt: 1,
  });
  const renderer = await render({});
  // The pill is the small fixed bottom-right host element; the full-screen
  // shell would open with `fixed inset-0`.
  expect(tags(renderer)).not.toContain('a');
  expect(JSON.stringify(renderer.toJSON())).toContain('fixed right-6 bottom-6');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('inset-0');
  await act(async () => renderer.unmount());
});

test('an unreachable store without a prior connection renders the full unreachable view', async () => {
  useRuntimeConnectionStore.setState({ status: 'unreachable', wasConnected: false });
  const renderer = await render({});
  // The full-screen shell (not the floating pill), with the escape link back.
  const html = JSON.stringify(renderer.toJSON());
  expect(html).toContain('inset-0');
  expect(html).toContain('href":"/projects');
  await act(async () => renderer.unmount());
});

test('forceConnecting renders the connecting signal regardless of the store', async () => {
  useRuntimeConnectionStore.setState({ status: 'connected', healthy: true });
  const renderer = await render({ forceConnecting: true });
  expect(tags(renderer)).not.toEqual([]);
  await act(async () => renderer.unmount());
});
