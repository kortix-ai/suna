import { afterEach, describe, expect, test } from 'bun:test';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useRuntimeConnectionStore } from '@kortix/sdk/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppsCard } from './apps-card';

const app = { callID: 'a', name: 'Dashboard', kind: 'app' as const, url: 'http://localhost:3000' };

// `AppsCard`'s "Send to agent" affordance is a `Hint` (Tooltip), which Radix
// requires inside a `TooltipProvider`. The liveness-only tests below don't
// render the affordance (no handler / healthy sandbox), so they skip the
// wrapper; the affordance tests wrap it.
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);

describe('AppsCard liveness (W8)', () => {
  // Restore the store's own default (`status: 'connecting', healthy: null`)
  // so a status this file sets never leaks into another test file's first
  // read of the shared module-scope store.
  afterEach(() => {
    useRuntimeConnectionStore.setState({ status: 'connecting', healthy: null });
  });

  test('healthy sandbox → live pulse', () => {
    useRuntimeConnectionStore.setState({ status: 'connected', healthy: true });
    const html = render(<AppsCard apps={[app]} onOpenApp={() => {}} />);
    expect(html).toContain('animate-ping');
  });

  test('dead sandbox → quiet stopped state, no green pulse lying', () => {
    useRuntimeConnectionStore.setState({ status: 'unreachable', healthy: false });
    const html = render(<AppsCard apps={[app]} onOpenApp={() => {}} />);
    expect(html).not.toContain('animate-ping');
    expect(html).toContain('stopped');
  });

  test('dead sandbox + handler → "Send to agent" affordance on the row', () => {
    useRuntimeConnectionStore.setState({ status: 'unreachable', healthy: false });
    const html = render(<AppsCard apps={[app]} onOpenApp={() => {}} onSendToAgent={() => {}} />);
    // The affordance is a labeled icon button placed as a sibling (not a
    // nested child) of the row's open button — valid HTML, and the row drops
    // its right rounding so the two read as one control.
    expect(html).toContain('aria-label="Send Dashboard to agent"');
    expect(html).toContain('rounded-r-none');
  });

  test('dead sandbox + no handler → no "Send to agent" affordance (omitted, not disabled)', () => {
    useRuntimeConnectionStore.setState({ status: 'unreachable', healthy: false });
    const html = render(<AppsCard apps={[app]} onOpenApp={() => {}} />);
    expect(html).not.toContain('Send to agent');
  });

  test('healthy sandbox → no "Send to agent" affordance even with a handler', () => {
    useRuntimeConnectionStore.setState({ status: 'connected', healthy: true });
    const html = render(<AppsCard apps={[app]} onOpenApp={() => {}} onSendToAgent={() => {}} />);
    expect(html).not.toContain('Send to agent');
  });
});
