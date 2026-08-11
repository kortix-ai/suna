import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { chipClass } from '@/features/session/mention-chip';
import type { MessageWithParts } from '@/ui';

import { UserMessage } from './user-message';

const message = {
  info: { id: 'message-1', role: 'user' },
  parts: [{ id: 'part-1', messageID: 'message-1', type: 'text', text: 'ship the thing' }],
} as MessageWithParts;

const render = (rewindDisabled: boolean) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <UserMessage
          message={message}
          sessionId="session-1"
          ownsPlan={false}
          onRewind={() => {}}
          rewindDisabled={rewindDisabled}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

/** A user message carrying arbitrary text + the props under test. */
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

describe('UserMessage actions', () => {
  test('keeps copy available while rewind is disabled', () => {
    const markup = render(true);
    expect(markup).toContain('aria-label="Copy code"');
    expect(markup).not.toContain('aria-label="Edit message and rewind session"');
  });
});

describe('UserMessage renders the composer chip, not its own treatment', () => {
  // The whole point of `mention-chip.tsx`: whatever the composer draws, this
  // draws. Asserting against the live `chipClass()` (rather than a pasted class
  // string) is what makes these tests fail if the two ever diverge again.
  test('a file mention is a chip carrying the shared surface class', () => {
    const markup = renderText('open @src/index.ts now');
    expect(markup).toContain('aria-label="file mention: src/index.ts"');
    expect(markup).toContain(chipClass('file').split(' ')[0]);
    expect(markup).toContain('@src/index.ts');
    // The old treatment, gone: underlined text pretending to be a chip.
    expect(markup).not.toContain('decoration-foreground/30');
  });

  test('a known agent name renders as an agent chip, not bold text', () => {
    const markup = renderText('ask @build about it', { agentNames: ['build'] });
    expect(markup).toContain('aria-label="agent mention: build"');
  });

  test('an email address does not become a chip', () => {
    const markup = renderText('mail me at jay@kortix.com');
    expect(markup).not.toContain('aria-label="file mention: kortix.com"');
  });
});

describe('UserMessage renders a /command exactly as the composer does', () => {
  const commandProps = { commandInfo: { name: 'webapp', args: 'explain me this skill' } };

  test('the command is an inline chip with the command tint', () => {
    const markup = renderText('<expanded template body>', commandProps);
    expect(markup).toContain('aria-label="command: /webapp"');
    expect(markup).toContain('/webapp');
    // The command tint is the visual difference from a mention. Both halves
    // matter — see `chipClass`'s twMerge note.
    expect(markup).toContain('bg-primary/[0.08]');
  });

  test('the args are body text beside the chip, not a muted 12px sub-line', () => {
    const markup = renderText('<expanded template body>', commandProps);
    expect(markup).toContain('explain me this skill');
    // The old card's chrome, gone: bordered panel, terminal icon, mono name.
    expect(markup).not.toContain('bg-muted/40');
    expect(markup).not.toContain('font-mono text-sm');
  });

  test('the expanded template body is never shown — only the args are', () => {
    const markup = renderText('THE-WHOLE-TEMPLATE-FILE', commandProps);
    expect(markup).not.toContain('THE-WHOLE-TEMPLATE-FILE');
  });

  test('a command with no args renders the chip alone', () => {
    const markup = renderText('THE-WHOLE-TEMPLATE-FILE', {
      commandInfo: { name: 'webapp' },
    });
    expect(markup).toContain('aria-label="command: /webapp"');
    expect(markup).not.toContain('THE-WHOLE-TEMPLATE-FILE');
  });
});
