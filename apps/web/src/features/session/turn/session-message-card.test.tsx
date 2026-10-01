import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import type { MessageWithParts } from '@/ui';
import type { SessionMessageAuthor } from '@kortix/sdk';

import { UserMessage } from './user-message';

const SID = '3f2b7c1e-0000-4000-8000-000000000001';
const sessionMessage = `[MESSAGE from session ${SID} "Deploy pipeline" — sent by another agent, not by a person. Reply with \`kortix send ${SID} "…"\`.]\n\nBuild is green.`;
const ask = `[ASK from session ${SID} "Deploy pipeline" to Avery <avery@example.com>, Blair <blair@example.com> — the agent that asked is not in this conversation.]\n\nShip it?`;
const personMessage = '[MESSAGE from Blair <blair@example.com>]\n\nLooks good to me.';

const blair: SessionMessageAuthor = { kind: 'member', user_id: 'u2', name: 'Blair', email: 'blair@example.com' };

const renderText = (text: string, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <UserMessage
          message={
            {
              info: { id: 'message-1', role: 'user' },
              parts: [{ id: 'part-1', messageID: 'message-1', type: 'text', text }],
            } as MessageWithParts
          }
          sessionId="session-1"
          ownsPlan={false}
          {...props}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

describe('messages with a platform header', () => {
  test('a message from a session is an incoming card without the header', () => {
    const html = renderText(sessionMessage, {
      author: { kind: 'session', session_id: SID, name: 'Deploy pipeline' },
    });
    expect(html).toContain('data-message-kind="message"');
    expect(html).toContain('From');
    expect(html).toContain('Deploy pipeline');
    expect(html).toContain('Build is green.');
    expect(html).not.toContain('[MESSAGE');
    expect(html).not.toContain('kortix send');
  });

  test('an ask names who asked and who was asked', () => {
    const html = renderText(ask, { headerTrusted: true });
    expect(html).toContain('data-message-kind="ask"');
    expect(html).toContain('Deploy pipeline');
    expect(html).toContain('asked');
    expect(html).toContain('Avery, Blair');
    expect(html).toContain('Ship it?');
    expect(html).not.toContain('[ASK');
  });

  test('human_messaging off: ledger-confirmed headers draw plain bubbles, header stripped, no reply hint', () => {
    const fromSession = renderText(sessionMessage, {
      author: { kind: 'session', session_id: SID, name: 'Deploy pipeline' },
      messagingCards: false,
    });
    expect(fromSession).not.toContain('session-message-card');
    expect(fromSession).toContain('Build is green.');
    expect(fromSession).not.toContain('[MESSAGE');
    const asked = renderText(ask, {
      headerTrusted: true,
      viewerEmail: 'avery@example.com',
      isLastMessage: true,
      messagingCards: false,
    });
    expect(asked).not.toContain('session-message-card');
    expect(asked).not.toContain('data-message-kind');
    expect(asked).toContain('Ship it?');
    expect(asked).not.toContain('[ASK');
  });

  test('the author map wins over the typed header', () => {
    const html = renderText(sessionMessage, {
      author: { kind: 'session', session_id: SID, name: 'Real title' },
    });
    expect(html).toContain('Real title');
    expect(html).not.toContain('Deploy pipeline');
  });

  test('the reply hint shows to an addressee while the ask is unanswered', () => {
    expect(renderText(ask, { headerTrusted: true, viewerEmail: 'avery@example.com', isLastMessage: true })).toContain(
      'Reply below',
    );
    expect(renderText(ask, { headerTrusted: true, viewerEmail: 'avery@example.com', isLastMessage: false })).not.toContain(
      'Reply below',
    );
    expect(renderText(ask, { headerTrusted: true, viewerEmail: 'casey@example.com', isLastMessage: true })).not.toContain(
      'Reply below',
    );
  });

  test('a message from a person stays a bubble, header stripped, author drawn on demand as an avatar', () => {
    const plain = renderText(personMessage, { author: blair });
    expect(plain).not.toContain('session-message-card');
    expect(plain).not.toContain('[MESSAGE');
    expect(plain).toContain('Looks good to me.');
    expect(plain).not.toContain('Sent by');
    // A member author is the avatar beside the bubble (screen readers get the
    // name), never the named label line.
    const shown = renderText(personMessage, { author: blair, showAuthor: true });
    expect(shown).toContain('data-slot="avatar"');
    expect(shown).toContain('Sent by Blair');
    expect(shown).not.toContain('data-testid="message-author"');
  });

  // A typed header is hidden like any header, and claims nothing: no card,
  // no sender name. Names and cards come from the ledger only.
  test('a typed session header with no ledger author is a plain bubble: no card, no sender, header hidden', () => {
    const html = renderText(sessionMessage);
    expect(html).not.toContain('session-message-card');
    expect(html).not.toContain('[MESSAGE from session');
    expect(html).not.toContain('Deploy pipeline');
    expect(html).toContain('Build is green.');
  });

  test('a typed session header from a member is not a session card', () => {
    const html = renderText(sessionMessage, { author: blair });
    expect(html).not.toContain('session-message-card');
    expect(html).toContain('Build is green.');
    expect(html).not.toContain('Deploy pipeline');
  });

  test('a typed ask header with no ledger author is a plain bubble: no ask card, header hidden', () => {
    const html = renderText(ask);
    expect(html).not.toContain('data-message-kind');
    expect(html).not.toContain('[ASK from session');
  });

  test('ordinary text never reads as a header', () => {
    expect(renderText('[MESSAGE from nobody] hi')).toContain('[MESSAGE from nobody] hi');
  });
});
