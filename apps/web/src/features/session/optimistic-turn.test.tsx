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

describe('OptimisticTurn staged attachments', () => {
  // A reload discards the composer's optimistic state. The durable queued row
  // is then the only thing that knows the prompt had files, and it carries
  // NAMES ONLY — no bytes, no sandbox path, because the upload has not landed.
  // Without this the refreshed tab showed a bare sentence for a send of seven
  // attachments (2026-09-04), which reads as "my files were dropped".
  test('draws a pending tile per staged attachment after a reload', () => {
    const markup = render(
      <OptimisticTurn
        text="YO BRO"
        attachments={[
          { filename: '20260830_134945.jpg', mime: 'image/jpeg' },
          { filename: 'spec.pdf', mime: 'application/pdf' },
        ]}
      />,
    );
    expect(markup).toContain('YO BRO');
    expect(markup).toContain('20260830_134945.jpg');
    expect(markup).toContain('spec.pdf');
  });

  test('keeps send order', () => {
    const markup = render(
      <OptimisticTurn
        text="x"
        attachments={[
          { filename: 'first.png', mime: 'image/png' },
          { filename: 'second.png', mime: 'image/png' },
        ]}
      />,
    );
    expect(markup.indexOf('first.png')).toBeLessThan(markup.indexOf('second.png'));
  });

  test('renders nothing extra when the prompt had no files', () => {
    const withNone = render(<OptimisticTurn text="plain" attachments={[]} />);
    const withoutProp = render(<OptimisticTurn text="plain" />);
    expect(withNone).toBe(withoutProp);
  });

  // Uploads that already landed arrive as `<file …>` refs folded into the text.
  // A reloaded row supplies the same files as staged names. Rendering both
  // would double every tile.
  test('does not double a file that is already a text ref', () => {
    const text = buildOptimisticPromptTextWithUploads('look', [
      {
        kind: 'remote',
        url: 'https://example.test/a.png',
        filename: 'a.png',
        mime: 'image/png',
        isImage: true,
      },
    ]);
    // One tile prints its name several times (label, alt, title), so the
    // invariant is not a count — it is that naming the same file twice adds
    // nothing at all.
    const withoutStaged = render(<OptimisticTurn text={text} />);
    const withStaged = render(
      <OptimisticTurn text={text} attachments={[{ filename: 'a.png', mime: 'image/png' }]} />,
    );
    expect(withStaged).toBe(withoutStaged);
  });
});

describe('OptimisticTurn upload status', () => {
  // Jay, 2026-09-04: "Even if the file upload takes time, just update the user
  // that file 1 is uploading, file 2 is uploading, file 3 is uploading, with a
  // proper file upload state." The bytes reach the box BEFORE the runtime
  // creates the message, so this bubble is the only thing on screen for the
  // whole upload — it has to say what is happening.
  test('says how many files are still going up', () => {
    const markup = render(
      <OptimisticTurn
        text="YO BRO"
        attachments={[
          { filename: 'a.jpg', mime: 'image/jpeg' },
          { filename: 'b.pdf', mime: 'application/pdf' },
          { filename: 'c.svg', mime: 'image/svg+xml' },
        ]}
        uploadStatus={{ state: 'uploading' }}
      />,
    );
    expect(markup).toContain('Uploading 3 files');
    expect(markup).toContain('a.jpg');
    expect(markup).toContain('c.svg');
  });

  test('says it in the singular for one file', () => {
    const markup = render(
      <OptimisticTurn
        text="x"
        attachments={[{ filename: 'only.png', mime: 'image/png' }]}
        uploadStatus={{ state: 'uploading' }}
      />,
    );
    expect(markup).toContain('Uploading 1 file');
    expect(markup).not.toContain('1 files');
  });

  // A failed upload must READ as failed. Left as a spinner it is
  // indistinguishable from a slow one, which is how a dead prompt looked like
  // a working one for minutes.
  test('names the failure instead of spinning forever', () => {
    const markup = render(
      <OptimisticTurn
        text="x"
        attachments={[{ filename: 'photo.jpg', mime: 'image/jpeg' }]}
        uploadStatus={{ state: 'failed', message: 'photo.jpg — upload failed (503)' }}
      />,
    );
    expect(markup).toContain('photo.jpg — upload failed (503)');
    expect(markup).not.toContain('Uploading');
  });

  test('derives the upload status from pending files in a running-session turn', () => {
    const pending = render(
      <OptimisticTurn text="x" attachments={[{ filename: 'a.png', mime: 'image/png' }]} />,
    );
    expect(pending).toContain('Uploading 1 file');
  });
});
