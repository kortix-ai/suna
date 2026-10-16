/**
 * Characterization for `ConnectingScreen`, the auth and routing loader. The
 * props pick the mode (error, stopped, provisioning, else the connecting
 * signal). It reads no connection state: every caller passed
 * `forceConnecting`, so its store-driven pill and Unreachable view never
 * rendered, and were removed (KRTX-261).
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
  PowerIcon: passthrough,
}));
mock.module('@/components/sidebar/kortix-logo', () => ({ KortixLogo: passthrough }));
mock.module('next/link', () => ({ default: passthrough }));

const sdkReact = await import('@kortix/sdk/react');
const useRuntimeConnectionStore = sdkReact.useRuntimeConnectionStore;
const { ConnectingScreen } = await import('./connecting-screen');

afterEach(() => {
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

test('an error renders the full-screen error view with the way back', async () => {
  const renderer = await render({ error: { message: 'boom' } });
  const html = JSON.stringify(renderer.toJSON());
  expect(html).toContain('boom');
  expect(html).toContain('inset-0');
  expect(html).toContain('href":"/projects');
  await act(async () => renderer.unmount());
});

test('stopped and provisioning render their own views', async () => {
  const stopped = await render({ stopped: { name: 'box' } });
  expect(JSON.stringify(stopped.toJSON())).toContain('box');
  await act(async () => stopped.unmount());

  const provisioning = await render({
    provisioning: { progress: 40, stageLabel: 'Starting' },
  });
  expect(JSON.stringify(provisioning.toJSON())).toContain('Starting');
  await act(async () => provisioning.unmount());
});

test('no mode prop renders the connecting signal, named by its stage', async () => {
  const renderer = await render({ overrideStage: 'auth' });
  const signal = renderer.root.findByProps({ role: 'status' });
  expect(signal.props['aria-label']).toBe('Authenticating');
  await act(async () => renderer.unmount());
});

test('a dropped or unreachable runtime does not change the screen', async () => {
  for (const state of [
    { status: 'connected' as const, healthy: true },
    { status: 'connected' as const, healthy: false },
    { status: 'unreachable' as const, wasConnected: true, initialCheckDone: true, disconnectedAt: 1 },
    { status: 'unreachable' as const, wasConnected: false },
  ]) {
    useRuntimeConnectionStore.setState(state);
    const renderer = await render({});
    const html = JSON.stringify(renderer.toJSON());
    // The connecting signal only: no pill, no full-screen Unreachable view.
    expect(renderer.root.findByProps({ role: 'status' }).props['aria-label']).toBe('Connecting');
    expect(html).not.toContain('bottom-6');
    expect(html).not.toContain('href');
    await act(async () => renderer.unmount());
  }
});
