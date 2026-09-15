import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { projectQueuedBehindFirst } from '../queue-projection';
import { adoptSentAttachmentPreviews } from '../sent-attachment-previews';
import { QueuedPromptBubbles } from './queued-prompt-bubbles';

const render = (el: React.ReactElement) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        {el}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

describe('QueuedPromptBubbles attachments', () => {
  test('an accepted completed attachment stays stable while delivery is pending', () => {
    const markup = render(
      <QueuedPromptBubbles
        queued={[
          {
            id: 'accepted-file',
            text: 'Use this file',
            attachments: [{ filename: 'brief.pdf', mime: 'application/pdf' }],
          },
        ]}
      />,
    );

    expect(markup).toContain('brief.pdf');
    expect(markup).not.toContain('animate-spinner-orbit');
    expect(markup).not.toContain('<button');
  });

  // The warm-box gap, measured in a real browser on 2026-09-04: the transcript
  // mounted at +6s, the queued row stood in for the prompt, and it drew the
  // text alone — three attached files, no tiles, no word about an upload.
  test('draws every accepted attachment as a stable tile', () => {
    const markup = render(
      <QueuedPromptBubbles
        queued={[
          {
            id: 'p1',
            text: 'REPRO after',
            attachments: [
              { filename: 'tiny.png', mime: 'image/png' },
              { filename: 'logo.svg', mime: 'image/svg+xml' },
              { filename: 'doc.pdf', mime: 'application/pdf' },
            ],
          },
        ]}
      />,
    );
    expect(markup).toContain('REPRO after');
    expect(markup).toContain('tiny.png');
    expect(markup).toContain('logo.svg');
    expect(markup).toContain('doc.pdf');
    expect(markup).not.toContain('animate-spinner-orbit');
    expect(markup).not.toContain('Uploading');
  });

  test('a failed row names the failure instead of spinning', () => {
    const markup = render(
      <QueuedPromptBubbles
        queued={[]}
        failed={[
          {
            id: 'p2',
            text: 'x',
            lastError: 'photo.jpg — upload failed (503)',
            attachments: [{ filename: 'photo.jpg', mime: 'image/jpeg' }],
            uploadStatus: { state: 'failed', message: 'photo.jpg — upload failed (503)' },
          },
        ]}
      />,
    );
    expect(markup).toContain('photo.jpg — upload failed (503)');
    expect(markup).not.toContain('Uploading');
  });

  test('a text-only shell send kept failed still states its reason with Retry', () => {
    const markup = render(
      <QueuedPromptBubbles
        queued={[
          {
            id: 'shell-extra-2',
            text: 'text two',
            attachments: [],
            uploadStatus: { state: 'failed', message: 'checkConnection', onRetry: () => {} },
          },
        ]}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('checkConnection');
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Retry<\/button>/);
  });

  test('a warm-claim queued bubble draws the picture it was sent with, and no spinner', () => {
    adoptSentAttachmentPreviews([
      {
        kind: 'local',
        uploadId: 'upload-warm',
        file: new File(['x'], 'warm.png', { type: 'image/png' }),
        localUrl: 'blob:warm-claim',
        isImage: true,
      },
    ]);
    const markup = render(
      <QueuedPromptBubbles
        queued={[
          {
            id: 'warm',
            text: 'look',
            attachments: [{ id: 'upload-warm', filename: 'warm.png', mime: 'image/png' }],
          },
        ]}
      />,
    );

    expect(markup.match(/<img [^>]*src="blob:warm-claim"/g)).toHaveLength(1);
    expect(markup.match(/<li class="contents"/g)).toHaveLength(1);
    expect(markup).not.toContain('animate-spinner-orbit');
    expect(markup).not.toContain('Upload');
  });

  // A shell extra send is painted on Enter; the next inbox poll lists its durable row, whose
  // attachments carry `filename`/`mime` only. The bubble key (`row.id`) and the tile key
  // (`attachment:<id>`, from `attachments[].id`) must not change between the two frames.
  test('a shell extra send keeps its bubble, tile identity and picture when its durable row lands', () => {
    adoptSentAttachmentPreviews([
      {
        kind: 'local',
        uploadId: 'upload-extra',
        file: new File(['x'], 'extra.png', { type: 'image/png' }),
        localUrl: 'blob:shell-extra',
        isImage: true,
      },
    ]);
    const extra = {
      id: 'shell-extra-1',
      text: 'second',
      attachments: [{ id: 'upload-extra', filename: 'extra.png', mime: 'image/png' }],
    };
    const firstRow = { prompt_id: 'row-1', text: 'first', attachments: [] };
    const durableRow = {
      prompt_id: 'row-2',
      text: 'second',
      attachments: [{ filename: 'extra.png', mime: 'image/png' }],
    };
    const beforePoll = projectQueuedBehindFirst([firstRow], [extra]);
    const afterPoll = projectQueuedBehindFirst([firstRow, durableRow], [extra]);

    for (const rows of [beforePoll, afterPoll]) {
      expect(rows.map((row) => row.id)).toEqual(['shell-extra-1']);
      expect(rows[0].attachments.map((file) => file.id)).toEqual(['upload-extra']);
      const markup = render(<QueuedPromptBubbles queued={rows} />);
      expect(markup.match(/data-queued-prompt-id="shell-extra-1"/g)).toHaveLength(1);
      expect(markup.match(/<img [^>]*src="blob:shell-extra"/g)).toHaveLength(1);
      expect(markup.match(/<li class="contents"/g)).toHaveLength(1);
      expect(markup).not.toContain('animate-spinner-orbit');
    }
  });

  // The chat draws an attachment-only queued prompt (`queuedPromptMessages`). The boot shell
  // must draw the same row, or it pops in only after the crossfade.
  test('an attachment-only row behind the first prompt is queued in the boot shell too', () => {
    const firstRow = { prompt_id: 'row-1', text: 'first', attachments: [] };
    const filesOnly = {
      prompt_id: 'row-2',
      text: '',
      attachments: [{ filename: 'shot.png', mime: 'image/png' }],
    };
    const rows = projectQueuedBehindFirst([firstRow, filesOnly], []);

    expect(rows.map((row) => row.id)).toEqual(['row-2']);
    const markup = render(<QueuedPromptBubbles queued={rows} />);
    expect(markup.match(/data-queued-prompt-id="row-2"/g)).toHaveLength(1);
    expect(markup.match(/<li class="contents"/g)).toHaveLength(1);
  });

  test('a text-only row is unchanged', () => {
    const markup = render(<QueuedPromptBubbles queued={[{ id: 'p3', text: 'plain' }]} />);
    expect(markup).toContain('plain');
    expect(markup).not.toContain('Uploading');
  });
});
