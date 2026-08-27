import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useSessionStartGiveUp } from './use-session-start-give-up';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useSessionStartGiveUp', () => {
  let renderer: ReactTestRenderer | null = null;

  afterEach(async () => {
    if (!renderer) return;
    await act(async () => renderer?.unmount());
    renderer = null;
  });

  test('a first request that never settles reaches the bounded give-up verdict', async () => {
    let givenUp = false;

    function Probe() {
      givenUp = useSessionStartGiveUp({
        identity: 'project-1:session-1',
        enabled: true,
        hasData: false,
        hasError: false,
        isFetching: true,
        budgetMs: 10,
      });
      return null;
    }

    await act(async () => {
      renderer = create(createElement(Probe));
    });
    expect(givenUp).toBe(false);

    await act(async () => {
      await Bun.sleep(30);
    });
    expect(givenUp).toBe(true);
  });

  test('a later successful response clears the deadline and verdict', async () => {
    let givenUp = false;

    function Probe({ hasData }: { hasData: boolean }) {
      givenUp = useSessionStartGiveUp({
        identity: 'project-1:session-1',
        enabled: true,
        hasData,
        hasError: false,
        isFetching: !hasData,
        budgetMs: 10,
      });
      return null;
    }

    await act(async () => {
      renderer = create(createElement(Probe, { hasData: false }));
    });
    await act(async () => {
      await Bun.sleep(30);
    });
    expect(givenUp).toBe(true);

    await act(async () => {
      renderer?.update(createElement(Probe, { hasData: true }));
    });
    expect(givenUp).toBe(false);

    await act(async () => {
      await Bun.sleep(20);
    });
    expect(givenUp).toBe(false);
  });
});
