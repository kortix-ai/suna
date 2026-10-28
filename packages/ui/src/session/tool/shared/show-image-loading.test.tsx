import { toolCallBlock } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ToolPart } from '../../../internal/session-types';
import { TooltipProvider } from '../../../primitives/tooltip';
import { IntlTestProvider } from '../../../test-utils/intl';
import { ShowTool } from '../tools/show-tool';
import { ImageGenPathsContext } from './infrastructure';

function render(node: ReactNode, drawn: ReadonlySet<string> = new Set()) {
  return renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ImageGenPathsContext.Provider value={drawn}>{node}</ImageGenPathsContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>
    </IntlTestProvider>,
  );
}

function show(input: Record<string, unknown>) {
  return toolCallBlock({
    type: 'tool',
    tool: 'show',
    callID: 'call-show-1',
    state: { status: 'completed', input, output: '', metadata: {} },
  } as unknown as ToolPart);
}

const IMAGE = '/workspace/output/images/a.png';

describe('show images', () => {
  test('a show image renders the image frame while its file loads', () => {
    const html = render(<ShowTool call={show({ type: 'image', path: IMAGE })} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading image');
    expect(html).not.toContain(IMAGE);
  });

  test('a show image already drawn by image_gen in the same turn is not drawn again', () => {
    const drawn = new Set(['output/images/a.png']);
    expect(render(<ShowTool call={show({ type: 'image', path: IMAGE })} />, drawn)).toBe('');

    const html = render(
      <ShowTool
        call={show({
          items: [
            { type: 'image', path: IMAGE },
            { type: 'file', path: '/workspace/report.pdf', title: 'report.pdf' },
          ],
        })}
      />,
      drawn,
    );
    expect(html).toContain('report.pdf');
    expect(html).not.toContain('a.png');
  });
});
