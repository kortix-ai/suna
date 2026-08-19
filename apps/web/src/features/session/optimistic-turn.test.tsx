import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { OptimisticTurn } from './optimistic-turn';
import { buildOptimisticPromptTextWithUploads } from './uploaded-file-refs';

/** An attached-file card reaches FileContentRenderer, which calls
 *  `useTranslations` and a thumbnail query — so this subtree needs both
 *  ancestors even though nothing asserted here is localized or fetched. */
const render = (el: React.ReactElement) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        {el}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

describe('OptimisticTurn', () => {
  test('shows the prompt the user typed', () => {
    const markup = render(<OptimisticTurn text="ship the thing" />);
    expect(markup).toContain('ship the thing');
  });

  test('offers copy before the server turn exists', () => {
    const markup = render(<OptimisticTurn text="ship the thing" />);
    expect(markup).toContain('aria-label="Copy code"');
  });

  test('waits with a Thinking shimmer — no logomark, no boot copy', () => {
    const markup = render(<OptimisticTurn text="d" />);
    expect(markup).toContain('Thinking');
    // The Kortix logomark used to sit above this row and then vanish the moment
    // a real turn landed. It is gone for good.
    expect(markup).not.toContain('kortix-logomark');
    // None of the boot checklist's step labels may reach the thread.
    for (const label of [
      'Reserving your computer',
      'Loading your workspace',
      'Waking the agent',
      'Connecting',
    ]) {
      expect(markup).not.toContain(label);
    }
  });

  test('the waiting row shimmers rather than counting up', () => {
    const markup = render(<OptimisticTurn text="d" />);
    // bg-clip-text is TextShimmer's fingerprint.
    expect(markup).toContain('bg-clip-text');
    // No elapsed timer before a turn exists — the boot clock and the turn clock
    // are different clocks, and swapping one for the other ran the number
    // backwards across the crossfade.
    expect(markup).not.toContain('tabular-nums');
  });

  test('unfolds upload refs into file cards, never raw XML', () => {
    const text = buildOptimisticPromptTextWithUploads('look at this', [
      { kind: 'remote', url: 'https://x/y', mime: 'image/png', filename: '/workspace/shot.png', isImage: true },
    ]);
    const markup = render(<OptimisticTurn text={text} />);
    expect(markup).toContain('look at this');
    expect(markup).toContain('shot.png');
    expect(markup).not.toContain('<file path=');
    expect(markup).not.toContain('&lt;file path=');
  });

  test('strips reply context out of the sentence and into its own row', () => {
    const markup = render(
      <OptimisticTurn text={'<reply_context>the earlier line</reply_context>fix it'} />,
    );
    expect(markup).toContain('the earlier line');
    expect(markup).toContain('fix it');
    expect(markup).not.toContain('reply_context');
  });

  test('a deferred preview keeps the tile box the chat will fill', () => {
    // deferPreview is the one prop the instant shell sets differently — there is
    // no sandbox yet, so MessageAttachments paints tiles as pending. The outer
    // tile surface must stay identical across the shell → chat crossfade or the
    // thread reflows under the handover.
    const text = buildOptimisticPromptTextWithUploads('with a file', [
      { kind: 'remote', url: 'https://x/y', mime: 'image/png', filename: '/workspace/a.png', isImage: true },
    ]);
    const shell = render(<OptimisticTurn text={text} deferPreview />);
    const chat = render(<OptimisticTurn text={text} />);
    // `rounded-sm border` is what `TILE_SURFACE` (`../attachment-tile`) ships.
    for (const box of ['size-20', 'max-w-[21.5rem]', 'rounded-sm border']) {
      expect(shell).toContain(box);
      expect(chat).toContain(box);
    }
    // Both still open with the same bubble and close with the same waiting row.
    expect(shell.slice(0, shell.indexOf('size-20'))).toBe(
      chat.slice(0, chat.indexOf('size-20')),
    );
    expect(shell).toContain('Thinking');
    expect(chat).toContain('Thinking');
  });

  test('an agent mention renders the same with or without a click target', () => {
    // The instant shell passes the same handlers and agent list the chat does,
    // so a mention must not change treatment across the crossfade. This pins the
    // shared input → shared output guarantee.
    const props = { text: 'ping @builder', agentNames: ['builder'] };
    const shell = render(<OptimisticTurn {...props} onFileClick={() => {}} />);
    const chat = render(<OptimisticTurn {...props} onFileClick={() => {}} />);
    expect(shell).toBe(chat);
    expect(shell).toContain('@builder');
  });
});
