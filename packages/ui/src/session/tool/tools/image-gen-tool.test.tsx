import { toolCallBlock } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ToolPart } from '../../../internal/session-types';
import { TooltipProvider } from '../../../primitives/tooltip';
import { IntlTestProvider } from '../../../test-utils/intl';
import { InTranscriptTurnContext, TurnLiveContext } from '../shared/infrastructure';
import { ImageGenTool } from './image-gen-tool';

// The file read, as the card sees it: still loading by default.
let blob: { blobUrl: string | null; blob: Blob | null; isLoading: boolean; error: string | null } = {
  blobUrl: null, blob: null, isLoading: true, error: null,
};
mock.module('../../../files/runtime/hooks/use-binary-blob', () => ({ useBinaryBlob: () => blob }));

function render(state: Record<string, unknown>, turn?: { live: boolean }) {
  const call = toolCallBlock({
    type: 'tool',
    tool: 'image_gen',
    callID: 'call-img-1',
    state: { input: { action: 'generate', prompt: 'A paper-cutout fox', size: '1536x1024' }, time: { start: Date.now() - 42_000 }, ...state },
  } as unknown as ToolPart);
  return renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          {turn ? (
            <InTranscriptTurnContext.Provider value>
              <TurnLiveContext.Provider value={turn.live}>
                <ImageGenTool call={call} />
              </TurnLiveContext.Provider>
            </InTranscriptTurnContext.Provider>
          ) : (
            <ImageGenTool call={call} />
          )}
        </TooltipProvider>
      </QueryClientProvider>
    </IntlTestProvider>,
  );
}

describe('ImageGenTool', () => {
  test('generating holds the requested aspect with the busy line, elapsed time and the prompt', () => {
    const html = render({ status: 'running' });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aspect-ratio:3 / 2');
    expect(html).toContain('Generating image');
    expect(html).toContain('0:42');
    expect(html).toContain('role="status"'); // SessionDotMatrix
    expect(html).toContain('A paper-cutout fox');
    expect(html).not.toContain('animate-spin');
  });

  test('a completed call loads the image file in the frame', () => {
    const html = render({
      status: 'completed',
      output: JSON.stringify({ path: '/workspace/output/images/fox.png', action: 'generate', size: '1536x1024', model: 'gpt-image-2' }),
    });
    expect(html).toContain('Loading image');
    expect(html).not.toContain('Generating image');
  });

  test('a failure shows the gateway message and suggestion', () => {
    const html = render({ status: 'error', error: 'Image limit reached. Try again in 2 hours.' });
    expect(html).toContain('Image limit reached.');
    expect(html).toContain('Try again in 2 hours.');
    expect(html).not.toContain('aria-busy');
  });

  test('a stopped call says Stopped with no sheen', () => {
    const html = render({ status: 'error', error: 'The operation was aborted.' });
    expect(html).toContain('Stopped');
    expect(html).not.toContain('aria-busy');
    expect(html).not.toContain('Generating image');
  });

  const COMPLETED = {
    status: 'completed',
    output: JSON.stringify({ path: '/workspace/output/images/fox.png', action: 'generate', size: '1536x1024', model: 'gpt-image-2' }),
  };

  test('a waking sandbox (readiness 503) keeps the card loading, not failed', () => {
    blob = { blobUrl: null, blob: null, isLoading: false, error: 'Sandbox not ready (503): the sandbox is starting' };
    try {
      const html = render(COMPLETED);
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('Loading image');
      expect(html).not.toContain('Sandbox not ready');
    } finally {
      blob = { blobUrl: null, blob: null, isLoading: true, error: null };
    }
  });

  test('a real read error is shown in the frame', () => {
    blob = { blobUrl: null, blob: null, isLoading: false, error: 'File not found' };
    try {
      const html = render(COMPLETED);
      expect(html).toContain('File not found');
      expect(html).not.toContain('aria-busy="true"');
    } finally {
      blob = { blobUrl: null, blob: null, isLoading: true, error: null };
    }
  });

  test('a path the file API cannot read shows the path, not an endless loading frame', () => {
    const html = render({ status: 'completed', output: JSON.stringify({ path: 'C:\\images\\fox.png' }) });
    expect(html).toContain('fox.png');
    expect(html).not.toContain('Loading image');
  });

  test('a rate limit names the reset time in words, never the raw seconds or the code', () => {
    const html = render({
      status: 'error',
      error: 'Image generation failed (429): The ChatGPT image limit is reached. Wait for the limit to reset, then retry. Retry after 7200 s. [image_rate_limited]',
    });
    expect(html).toContain('The ChatGPT image limit is reached.');
    expect(html).toContain('Try again in 2 hours.');
    expect(html).not.toContain('7200');
    expect(html).not.toContain('image_rate_limited');
  });

  test('an open call on a turn that ended is stopped; on a live turn it is generating', () => {
    expect(render({ status: 'running' }, { live: false })).toContain('Stopped');
    expect(render({ status: 'running' }, { live: true })).toContain('Generating image');
    // Outside a transcript turn the call's own status decides.
    expect(render({ status: 'running' })).toContain('Generating image');
  });
});
