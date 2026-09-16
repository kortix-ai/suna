import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useOpenCodeLocal, type OpenCodeLocal } from './use-opencode-local';
import type { Config } from '@opencode-ai/sdk/v2/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('Pi composer reasoning survives remount, isolates sessions, and clears unsupported choices', async () => {
  const config: Config = {
    model: 'kortix/pinned', default_agent: 'reviewer',
    provider: { kortix: { models: { pinned: { variants: { none: {}, low: {}, high: {} } } } } },
  };
  let latest!: OpenCodeLocal;
  let view: ReactTestRenderer | undefined;
  const firstId = 'reasoning-' + crypto.randomUUID();
  function Probe(props: { sessionId: string; config?: Config }) {
    latest = useOpenCodeLocal({ runtime: 'pi-worker', ...props });
    return null;
  }
  try {
    await act(async () => { view = create(createElement(Probe, { sessionId: firstId, config })); });
    expect(latest.model.variant.list).toEqual(['none', 'low', 'high']);
    expect(latest.model.variant.current).toBeUndefined();
    await act(async () => { latest.model.variant.set('high'); });
    expect(latest.model.variant.current).toBe('high');
    await act(async () => { latest.model.variant.set('unsupported'); });
    expect(latest.model.variant.current).toBe('high');
    await act(async () => { view!.unmount(); });
    await act(async () => { view = create(createElement(Probe, { sessionId: firstId, config })); });
    expect(latest.model.variant.current).toBe('high');
    await act(async () => { view!.update(createElement(Probe, { sessionId: firstId + '-other', config })); });
    expect(latest.model.variant.current).toBeUndefined();
    await act(async () => { view!.update(createElement(Probe, { sessionId: firstId, config: { model: config.model } })); });
    expect(latest.model.variant.list).toEqual([]);
    expect(latest.model.variant.current).toBeUndefined();
    await act(async () => { view!.update(createElement(Probe, { sessionId: firstId, config })); });
    await act(async () => { latest.model.variant.set(undefined); });
    expect(latest.model.variant.current).toBeUndefined();
  } finally {
    await act(async () => { view?.unmount(); });
  }
});
