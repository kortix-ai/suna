import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

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
  // The warm-box gap, measured in a real browser on 2026-09-04: the transcript
  // mounted at +6s, the queued row stood in for the prompt, and it drew the
  // text alone — three attached files, no tiles, no word about an upload.
  test('draws every attachment as a pending tile with the upload line', () => {
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
            uploadStatus: { state: 'uploading' },
          },
        ]}
      />,
    );
    expect(markup).toContain('REPRO after');
    expect(markup).toContain('tiny.png');
    expect(markup).toContain('logo.svg');
    expect(markup).toContain('doc.pdf');
    expect(markup).toContain('Uploading 3 files');
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

  test('a text-only row is unchanged', () => {
    const markup = render(<QueuedPromptBubbles queued={[{ id: 'p3', text: 'plain' }]} />);
    expect(markup).toContain('plain');
    expect(markup).not.toContain('Uploading');
  });
});
