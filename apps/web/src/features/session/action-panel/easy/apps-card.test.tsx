import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { useSandboxConnectionStore } from '@kortix/sdk/sandbox-connection-store';
import { AppsCard } from './apps-card';

const app = { callID: 'a', name: 'Dashboard', kind: 'app' as const, url: 'http://localhost:3000' };

describe('AppsCard liveness (W8)', () => {
  // Restore the store's own default (`status: 'connecting', healthy: null`)
  // so a status this file sets never leaks into another test file's first
  // read of the shared module-scope store.
  afterEach(() => {
    useSandboxConnectionStore.setState({ status: 'connecting', healthy: null });
  });

  test('healthy sandbox → live pulse', () => {
    useSandboxConnectionStore.setState({ status: 'connected', healthy: true });
    const html = renderToStaticMarkup(<AppsCard apps={[app]} onOpenApp={() => {}} />);
    expect(html).toContain('animate-ping');
  });

  test('dead sandbox → quiet stopped state, no green pulse lying', () => {
    useSandboxConnectionStore.setState({ status: 'unreachable', healthy: false });
    const html = renderToStaticMarkup(<AppsCard apps={[app]} onOpenApp={() => {}} />);
    expect(html).not.toContain('animate-ping');
    expect(html).toContain('stopped');
  });
});
