import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import type { MessageWithParts } from '@/ui';
import type { SessionMessageAuthor } from '@kortix/sdk';

import { UserMessage } from './user-message';

const blair: SessionMessageAuthor = { kind: 'member', user_id: 'u2', name: 'Blair', email: 'blair@example.com' };
const lead: SessionMessageAuthor = { kind: 'session', session_id: 's1', name: 'Deploy pipeline', agent: 'release-bot' };

const render = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <UserMessage
          message={
            {
              info: { id: 'message-1', role: 'user' },
              parts: [{ id: 'part-1', messageID: 'message-1', type: 'text', text: 'Looks good to me.' }],
            } as MessageWithParts
          }
          sessionId="session-1"
          ownsPlan={false}
          {...props}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

describe('message author label', () => {
  test('a member author is drawn as an avatar, only when asked to', () => {
    expect(render({ author: blair })).not.toContain('Sent by');
    const shown = render({ author: blair, showAuthor: true });
    expect(shown).toContain('data-slot="avatar"');
    expect(shown).toContain('Sent by Blair');
    expect(shown).not.toContain('data-testid="message-author"');
    expect(shown).toContain('Looks good to me.');
  });

  test('a message from another session names its agent, not the session title', () => {
    const named = render({ author: lead, showAuthor: true });
    expect(named).toContain('release-bot');
    expect(named).not.toContain('Deploy pipeline');
  });
});
