import '../tool/tools/register';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test } from 'bun:test';
import { toolCallBlock } from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ToolPart } from '../../internal/session-types';
import { ChainOfThoughtStep } from '../../primitives/chain-of-thought';
import { TooltipProvider } from '../../primitives/tooltip';
import { IntlTestProvider } from '../../test-utils/intl';
import { ToolRegistry } from '../tool/shared/registry';
import { StepBody } from './burst-step-body';

const call = (id: string, tool: string) =>
  toolCallBlock({ id, type: 'tool', tool, callID: `call_${id}`, state: { status: 'completed', output: 'x', input: { filePath: '/w/a.md' } } } as unknown as ToolPart);

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <IntlTestProvider locale="en" onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ChainOfThoughtStep open>{node}</ChainOfThoughtStep>
        </TooltipProvider>
      </QueryClientProvider>
    </IntlTestProvider>,
  );

test('a read call renders as a file chip until a host registers its own read row', () => {
  const step = { kind: 'block' as const, key: 'k', block: call('1', 'read') };
  expect(render(<StepBody step={step} running={false} sessionId="s1" disableNavigation />)).toContain('aria-label="Open a.md"');
  expect(ToolRegistry.replaced('read')).toBe(false);

  ToolRegistry.register('read', () => <div data-testid="host-read-row" />);
  expect(ToolRegistry.replaced('read')).toBe(true);
  expect(render(<StepBody step={step} running={false} sessionId="s1" disableNavigation />)).toContain('data-testid="host-read-row"');

  const group = { kind: 'group' as const, key: 'g', blocks: [call('2', 'read'), call('3', 'read')], family: 'explore' as never, label: 'Read', status: 'done' as const };
  const markup = render(<StepBody step={group} running={false} sessionId="s1" disableNavigation />);
  expect(markup).not.toContain('aria-label="Open a.md"');
  expect(markup).toContain('data-testid="host-read-row"');
});
