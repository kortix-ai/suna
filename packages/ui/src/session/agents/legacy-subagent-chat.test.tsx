import { describe, expect, mock, test } from 'bun:test';
import { IntlTestProvider } from '../../test-utils/intl';
import { renderToStaticMarkup } from 'react-dom/server';

// The full chat is replaced by an observable node: the test pins what it is handed.
await mock.module('../thread/session-chat', () => ({
  SessionChat: ({ sessionId, readOnly, savedHistoryScope, transparent }: { sessionId: string; readOnly: boolean; savedHistoryScope?: string; transparent?: boolean }) => (
    <div data-chat-session={sessionId} data-read-only={String(readOnly)} data-scope={String(savedHistoryScope)} data-transparent={String(transparent)} />
  ),
}));
const { LegacySubagentChat } = await import('./legacy-subagent-chat');
const { TestUiHost } = await import('../../test-utils/ui-host');

describe('a sub-agent that is not its own project session', () => {
  test('mounts the child chat read-only under the lead session history scope', () => {
    const html = renderToStaticMarkup(
      <IntlTestProvider locale="en" onError={() => {}}>
        <TestUiHost params={{ id: 'project', sessionId: 'parent' }}>
          <LegacySubagentChat sessionId="child" />
        </TestUiHost>
      </IntlTestProvider>,
    );
    expect(html).toContain('data-chat-session="child"');
    expect(html).toContain('data-read-only="true"');
    expect(html).toContain('data-scope="project/parent"');
    // It sits in the side panel's card: the card's color shows, not the chat page's.
    expect(html).toContain('data-transparent="true"');
  });
});
