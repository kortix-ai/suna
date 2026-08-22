import { installDom, uninstallDom } from './dom';
import { flush } from './flush';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * `flush()` probes React's own scheduler. pnpm keeps `scheduler` out of
 * `apps/web/node_modules`, so the fixture resolves it from `react-dom`'s real
 * path; a second copy would have an always-empty queue and `flush()` would
 * resolve before React rendered. These tests pin the single instance and the
 * cascade shapes the harnesses depend on.
 */

beforeAll(() => installDom());
afterAll(() => uninstallDom());

function Cascade({ seen }: { seen: string[] }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    // commit → setTimeout(0) hop → setState → commit → frame → setState.
    if (n === 0) setTimeout(() => setN(1), 0);
    if (n === 1) requestAnimationFrame(() => setN(2));
  }, [n]);
  seen.push(`render:${n}`);
  return <p>{n}</p>;
}

describe('flush', () => {
  test('react-dom and the fixture share ONE scheduler module', () => {
    const loaded = Object.keys(require.cache).filter((k) => /\/scheduler\/cjs\//.test(k));
    expect(loaded).toHaveLength(1);
  });

  test('resolves only after an effect → setTimeout(0) → setState → frame cascade committed', async () => {
    const seen: string[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    root.render(<Cascade seen={seen} />);
    await flush();
    expect(container.textContent).toBe('2');
    expect(seen).toEqual(['render:0', 'render:1', 'render:2']);
    root.unmount();
    await flush();
    expect(container.textContent).toBe('');
    container.remove();
  });
});
