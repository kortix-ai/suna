import type { ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import { SessionGetTool } from './session-get-tool';

// Task 20: `session_get` answers with a session — its id, when it ran, what it
// was doing. The TRANSCRIPT is the heaviest thing it can render and it used to
// hang off a hand-rolled `useState` collapsible with no `aria-expanded`. It is
// now a standard `Disclosure`, still closed, and the todos above it keep their
// own (open) one.

const HARDCODED_UI_MESSAGES = {
  hardcodedUi: {
    componentsSessionToolRenderers: {
      line5824JsxTextMsgs: 'msgs, ',
      line5856JsxTextNoMessagesInThisSession: 'No messages in this session',
    },
  },
};

function withProviders(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={HARDCODED_UI_MESSAGES} onError={() => {}}>
      {node}
    </NextIntlClientProvider>
  );
}

function makePart(output: string): ToolPart {
  return {
    type: 'tool',
    tool: 'session_get',
    callID: 'call-1',
    state: {
      status: 'completed',
      input: { session_id: 'ses_abc' },
      output,
      metadata: {},
    },
  } as unknown as ToolPart;
}

const SESSION_OUTPUT = `=== SESSION: Ship the pricing page ===
ID: ses_abc
Created: 2026-08-01 09:00
Updated: 2026-08-01 11:30
Changes: 4 files
Todos:
[completed] Draft the copy
[in_progress] Wire the checkout
Storage: 12 MB
=== CONVERSATION (18 msgs, 6 tool calls) ===
Assistant: I rewrote the hero section and pushed it.
=== COMPRESSION ===
Compressed 4 older turns.`;

describe('SessionGetTool folds the transcript', () => {
  test('the session line and its todos stay visible; the conversation does not', () => {
    const html = renderToStaticMarkup(
      withProviders(<SessionGetTool part={makePart(SESSION_OUTPUT)} defaultOpen />),
    );

    // The answer: which session, when, what it changed, what it is doing.
    expect(html).toContain('ses_abc');
    expect(html).toContain('4 files');
    expect(html).toContain('Draft the copy');
    expect(html).toContain('Wire the checkout');

    // The transcript is announced by its trigger and held behind it.
    expect(html).toContain('Conversation');
    expect(html).toContain('18');
    expect(html).not.toContain('I rewrote the hero section');
  });

  test('both collapsibles are real disclosures — state on the trigger, not a bare button', () => {
    const html = renderToStaticMarkup(
      withProviders(<SessionGetTool part={makePart(SESSION_OUTPUT)} defaultOpen />),
    );

    // Todos open, conversation closed: two triggers, two different states, and
    // `aria-expanded` on both. The hand-rolled buttons had neither.
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-expanded="false"');
  });

  test('panel surface: the row is closed, so neither section renders at all', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <SessionGetTool part={makePart(SESSION_OUTPUT)} />
        </ToolSurfaceContext.Provider>,
      ),
    );

    expect(html).toContain('Ship the pricing page');
    expect(html).not.toContain('Draft the copy');
    expect(html).not.toContain('I rewrote the hero section');
  });
});
