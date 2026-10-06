import { SessionBriefContent, SessionBriefDescription } from '@/features/workspace/project-sidebar/session-brief-hover-card';
import { SessionStatusMark } from '@/features/workspace/project-sidebar/session-status-mark';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * A session whose boot has sat in the starting family past the SDK's
 * `SESSION_STARTING_STUCK_MS` must say so in words and offer the same restart
 * the boot loader does — the dogfood run watched a first session sit on
 * "Status: Starting" for 12+ minutes with no error, no feedback and no retry
 * anywhere in the list surfaces (KRTX-1687). The stuck DECISION is pinned by
 * the SDK's `status-vocabulary.test.ts`; these tests pin that the surfaces
 * carry it.
 */

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      {node}
    </NextIntlClientProvider>,
  );
}

const base = {
  title: 'New session',
  status: 'starting' as const,
  createdAt: '2026-10-06T10:00:00Z',
  source: { kind: 'chat' as const, label: 'Chat', triggerSlug: null },
  changeRequests: [],
};

describe('the stuck boot reaches the pixels', () => {
  test('the hover card names the wedged boot and offers the restart', () => {
    const html = render(
      <SessionBriefContent
        {...base}
        stuck
        projectId="p1"
        onRestart={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain('This is taking longer than usual.');
    expect(html).toContain('Restart session');
    // The restart stays pressable: nothing disables it while the boot hangs.
    expect(html).not.toContain('disabled=""');
  });

  test('a boot inside the threshold renders neither the sentence nor the button', () => {
    const html = render(
      <SessionBriefContent {...base} projectId="p1" onDismiss={() => {}} />,
    );
    expect(html).not.toContain('This is taking longer than usual.');
    expect(html).not.toContain('Restart session');
  });

  test('the screen-reader description carries the sentence too', () => {
    const stuck = render(<SessionBriefDescription id="d1" {...base} stuck />);
    expect(stuck).toContain('Status: Starting.');
    expect(stuck).toContain('This is taking longer than usual.');
    expect(render(<SessionBriefDescription id="d1" {...base} />)).not.toContain(
      'This is taking longer than usual.',
    );
  });
});

describe('the stuck mark stops claiming motion', () => {
  test('a starting spinner animates; a stuck one is a static ring', () => {
    const spinning = render(<SessionStatusMark status="starting" />);
    expect(spinning).toContain('animate-');
    const stuck = render(<SessionStatusMark status="starting" stuck />);
    expect(stuck).not.toContain('animate-');
    // The ring keeps the starting tone: the boot is slow, not failed.
    expect(stuck).toContain('var(--kortix-yellow)');
  });

  test('other statuses ignore the stuck flag', () => {
    expect(render(<SessionStatusMark status="running" stuck />)).toBe(
      render(<SessionStatusMark status="running" />),
    );
  });
});
