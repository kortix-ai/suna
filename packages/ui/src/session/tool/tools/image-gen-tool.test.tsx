import { toolCallBlock } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ToolPart } from '../../../internal/session-types';
import { TooltipProvider } from '../../../primitives/tooltip';
import { IntlTestProvider } from '../../../test-utils/intl';
import { ImageGenTool } from './image-gen-tool';

function render(state: Record<string, unknown>) {
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
          <ImageGenTool call={call} />
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
});
