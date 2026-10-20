import { describe, expect, test } from 'bun:test';
import type { ToolCallBlock } from '@kortix/sdk';
import type { UseSessionResult } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { UiProvider } from '../providers/ui-provider';
import {
  BasicTool,
  SessionBusyIndicator,
  SessionThread,
  ThrottledMarkdown,
  ToolPartRenderer,
  ToolRegistry,
  TurnErrorDisplay,
  UnifiedMarkdown,
  type ToolProps,
} from './index';

// A plain host: UiProvider with no adapters (English catalog) and a QueryClient. Nothing from apps/web.
function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <UiProvider>{node}</UiProvider>
    </QueryClientProvider>,
  );
}

const call = (name: string): ToolCallBlock => ({
  id: 'b1',
  type: 'tool_call',
  call_id: 'c1',
  name,
  kind: 'other',
  input: { query: 'synthetic' },
  status: 'complete',
  result: { content: [{ type: 'text', text: 'done' }], is_error: false },
});

describe('@kortix/ui/session in a plain host', () => {
  test('the entry registers the built-in tool renderers on import', () => {
    expect(ToolRegistry.get('bash')).toBeDefined();
    expect(ToolRegistry.get('read')).toBeDefined();
  });

  test('SessionThread mounts from a useSession result before the runtime has an id', () => {
    const session = { projectId: 'p1', sessionId: 's1', runtimeSessionId: null, stage: 'provisioning' };
    const html = render(<SessionThread session={session as unknown as UseSessionResult} />);
    expect(html).toContain('data-slot="session-thread"');
  });

  test('a host registers its own renderer for a tool name; ToolPartRenderer draws it', () => {
    function LookupRow({ call }: ToolProps) {
      return <BasicTool trigger={`Lookup ${(call.input as { query: string }).query}`} />;
    }
    ToolRegistry.register('acme_lookup', LookupRow);
    expect(render(<ToolPartRenderer call={call('acme_lookup')} />)).toContain('Lookup synthetic');
  });

  test('markdown, busy and error blocks render', () => {
    expect(render(<UnifiedMarkdown content="**bold**" trust="agent" />)).toContain('<strong');
    expect(render(<ThrottledMarkdown content="plain *text*" isStreaming={false} />)).toContain('<em');
    expect(render(<SessionBusyIndicator statusText="Working" />)).toContain('Working');
    expect(render(<TurnErrorDisplay errorText="Model call failed" />)).toContain('Model call failed');
  });
});
