import { TurnLiveContext } from '@/features/session/tool/shared/infrastructure';
import type { ToolPart } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolPartRenderer } from './tool-part-renderer';

/**
 * The shape a tool call has for the frames between "the call exists" and "its
 * first argument chunk arrived": `pending`, empty `input`, no streamed `raw`.
 *
 * A leftover part from a run that died has this EXACT shape too, which is the
 * whole problem — nothing on the part separates them.
 */
const inputless = {
  id: 'p1',
  type: 'tool',
  tool: 'write',
  callID: 'c1',
  state: { status: 'pending', input: {} },
} as unknown as ToolPart;

const render = (part: ToolPart, turnLive: boolean) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <TurnLiveContext.Provider value={turnLive}>
          <ToolPartRenderer part={part} sessionId="s1" defaultOpen />
        </TurnLiveContext.Provider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

describe('an input-less pending call is read by the TURN, not by the part', () => {
  // The reported bug, exactly: the transcript rendered "No content received"
  // over a `write` while the SDK status line, reading that same part, rendered
  // "Making changes..." (`packages/sdk/src/core/turns/state.ts`). One part, two
  // views, opposite verdicts — a working session that looked frozen.
  test('while the turn is live the row does not announce that nothing came', () => {
    const html = render(inputless, true);

    expect(html).not.toContain('No content received');
  });

  test('and it reads as present tense, because the call has not finished', () => {
    const html = render(inputless, true);

    expect(html).toContain('Writing');
  });

  test('once the turn is over the same part IS stale, and says so', () => {
    // A restored session is full of these. The row must settle rather than
    // promise content that can no longer arrive.
    const html = render(inputless, false);

    expect(html).toContain('No content received');
  });

  test('and a settled leftover reads in the past tense, not as still running', () => {
    const html = render(inputless, false);

    expect(html).toContain('Wrote');
    expect(html).not.toContain('Writing');
  });
});
