import { expect, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { setRuntimeCapabilities } from '../browser/stores/sandbox-connection-store';
import { useHasSessionDesktop } from './use-has-session-desktop';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test('undefined until the daemon answers, then whether it lists machine.desktop', () => {
  let value: boolean | undefined;
  function Probe() { value = useHasSessionDesktop(); return null; }
  act(() => { setRuntimeCapabilities(null); create(React.createElement(Probe)); });
  expect(value).toBeUndefined();
  act(() => setRuntimeCapabilities(['file.import', 'session.subagents']));
  expect(value).toBe(false);
  act(() => setRuntimeCapabilities(['file.import', 'machine.desktop', 'session.subagents']));
  expect(value).toBe(true);
});
