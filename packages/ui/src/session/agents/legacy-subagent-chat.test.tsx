import { describe, expect, mock, test } from 'bun:test';
import { IntlTestProvider } from '../../test-utils/intl';
import { renderToStaticMarkup } from 'react-dom/server';

// The full chat is replaced by an observable node: the test pins what it is handed.
await mock.module('../thread/session-chat', () => ({
  SessionChat: ({ sessionId, readOnly, savedHistoryScope }: { sessionId: string; readOnly: boolean; savedHistoryScope?: string }) => (
    <div data-chat-session={sessionId} data-read-only={String(readOnly)} data-scope={String(savedHistoryScope)} />
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
  });
});
