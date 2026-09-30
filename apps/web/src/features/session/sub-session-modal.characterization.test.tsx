import { describe, expect, mock, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

// The app's Bun tests have no DOM; preserve the real opener/content path and
// replace only the portal and full chat with observable server-renderable nodes.
await mock.module('@/components/ui/modal', () => ({
  Modal: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null,
  ModalContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModalTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
await mock.module('@/features/session/session-chat', () => ({
  SessionChat: ({ sessionId, readOnly }: { sessionId: string; readOnly: boolean }) =>
    <div data-chat-session={sessionId} data-read-only={String(readOnly)} />,
}));
await mock.module('next/navigation', () => ({ useParams: () => ({ id: 'project', sessionId: 'parent' }) }));
const { SubSessionModalContent } = await import('./sub-session-modal-content');

describe('opened sub-session modal', () => {
  test('mounts the child chat read-only under the parent history scope', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <SubSessionModalContent open onOpenChange={() => {}} sessionId="child" title="Child" />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('data-chat-session="child"');
    expect(html).toContain('data-read-only="true"');
    expect(html).toContain('Child');
  });
});
