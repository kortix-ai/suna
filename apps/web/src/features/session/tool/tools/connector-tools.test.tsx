import type { ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import { ConnectorCallTool, ConnectorDescribeTool } from './connector-tools';

// Task 20: the connector cards stacked every section they had — request args,
// response, input schema — open at once. The status line and the RESULT are
// the answer; the JSON that went in is provenance.

const HARDCODED_UI_MESSAGES = {
  hardcodedUi: {
    autoFeaturesSessionToolRenderersJsxTextInputSchema878a1df6: 'Input schema',
  },
};

function withProviders(node: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={HARDCODED_UI_MESSAGES} onError={() => {}}>
      {node}
    </NextIntlClientProvider>
  );
}

function makePart(tool: string, input: Record<string, unknown>, output: string): ToolPart {
  return {
    type: 'tool',
    tool,
    callID: 'call-1',
    state: { status: 'completed', input, output, metadata: {} },
  } as unknown as ToolPart;
}

describe('ConnectorCallTool', () => {
  const part = makePart(
    'kortix-connectors_call',
    { connector: 'slack', action: 'post_message', args: { channel: '#launch' } },
    JSON.stringify({ ok: true, status: 'ok', data: { ts: '1723.44' } }),
  );

  test('the outcome and the response stay; the request arguments fold', () => {
    const html = renderToStaticMarkup(withProviders(<ConnectorCallTool part={part} defaultOpen />));

    // What happened, and what came back.
    expect(html).toContain('slack.post_message');
    expect(html).toContain('OK');
    expect(html).toContain('Response');
    expect(html).toContain('1723.44');

    // What went in.
    expect(html).toContain('Request');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('#launch');
  });

  test('panel surface: same split behind the disclosure row', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ToolSurfaceContext.Provider value="panel">
          <ConnectorCallTool part={part} defaultOpen />
        </ToolSurfaceContext.Provider>,
      ),
    );

    expect(html).toContain('1723.44');
    expect(html).not.toContain('#launch');
  });
});

describe('ConnectorDescribeTool', () => {
  test('the action and its description stay; the JSON schema folds', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <ConnectorDescribeTool
          part={makePart(
            'kortix-connectors_describe',
            { tool: 'slack.post_message' },
            JSON.stringify({
              tool: 'slack.post_message',
              description: 'Post a message to a channel.',
              inputSchema: { type: 'object', properties: { thread_ts: { type: 'string' } } },
            }),
          )}
          defaultOpen
        />,
      ),
    );

    expect(html).toContain('slack.post_message');
    expect(html).toContain('Post a message to a channel.');

    expect(html).toContain('Input schema');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('thread_ts');
  });
});
