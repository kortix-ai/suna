import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { useSandboxConnectionStore } from '@kortix/sdk/sandbox-connection-store';
import { AppsCard } from './apps-card';

const app = { callID: 'a', name: 'Dashboard', kind: 'app' as const, url: 'http://localhost:3000' };

describe('AppsCard liveness (W8)', () => {
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
