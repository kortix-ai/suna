import { describe, expect, mock, test } from 'bun:test';
import { IntlTestProvider } from '../../test-utils/intl';
import { renderToStaticMarkup } from 'react-dom/server';

// The app's Bun tests have no DOM; preserve the real opener/content path and
// replace only the portal and full chat with observable server-renderable nodes.
const uiModalMock = () => ({
  Modal: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null,
  ModalContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModalTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
});
await mock.module('../../primitives/modal', uiModalMock);
await mock.module('../../primitives/modal', uiModalMock);
await mock.module('./session-chat', () => ({
  SessionChat: ({
    sessionId,
    readOnly,
    savedHistoryScope,
  }: {
    sessionId: string;
    readOnly: boolean;
    savedHistoryScope?: string;
  }) => (
    <div data-chat-session={sessionId} data-read-only={String(readOnly)} data-scope={String(savedHistoryScope)} />
  ),
}));
const { SubSessionModalContent } = await import('./sub-session-modal-content');
const { TestUiHost } = await import('../../test-utils/ui-host');

describe('opened sub-session modal', () => {
  test('mounts the child chat read-only under the parent history scope', () => {
    const html = renderToStaticMarkup(
      <IntlTestProvider locale="en" onError={() => {}}>
        <TestUiHost params={{ id: 'project', sessionId: 'parent' }}>
          <SubSessionModalContent open onOpenChange={() => {}} sessionId="child" title="Child" />
        </TestUiHost>
      </IntlTestProvider>,
    );
    expect(html).toContain('data-chat-session="child"');
    expect(html).toContain('data-read-only="true"');
    expect(html).toContain('data-scope="project/parent"');
    expect(html).toContain('Child');
  });
});
