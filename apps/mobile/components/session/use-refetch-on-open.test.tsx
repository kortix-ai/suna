import { describe, expect, test } from 'bun:test';
import React from 'react';
import { act, create } from 'react-test-renderer';

import { useRefetchOnOpen } from './use-refetch-on-open';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// State set from a timer inside one long act() renders only when act exits, so
// wait in short acts to let each fetch's renders land (as they do on a device).
const settle = async (ms: number) => {
  for (let waited = 0; waited < ms; waited += 5) await act(async () => { await sleep(5); });
};

// Mirrors the drawer: a refetch flips `isFetching` (two renders per fetch) and
// the callback identity changes on every render, like a callback built from
// whole query objects.
function Harness({ open, onFetch }: { open: boolean; onFetch: () => void }) {
  const [, setFetching] = React.useState(false);
  const refetchAll = async () => {
    onFetch();
    setFetching(true);
    await sleep(2);
    setFetching(false);
  };
  useRefetchOnOpen(open, refetchAll, 5);
  return null;
}

describe('useRefetchOnOpen', () => {
  test('fetches once per open even when the callback changes every render', async () => {
    let fetches = 0;
    const onFetch = () => { fetches += 1; };
    let tree: ReturnType<typeof create>;
    await act(async () => { tree = create(<Harness open={false} onFetch={onFetch} />); });
    await settle(40);
    expect(fetches).toBe(0);
    await act(async () => { tree.update(<Harness open onFetch={onFetch} />); });
    await settle(120);
    expect(fetches).toBe(1);
    await act(async () => { tree.update(<Harness open={false} onFetch={onFetch} />); });
    await act(async () => { tree.update(<Harness open onFetch={onFetch} />); });
    await settle(60);
    expect(fetches).toBe(2);
  });
});
