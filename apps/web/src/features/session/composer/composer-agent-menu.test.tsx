import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider } from '@/features/providers/auth-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { NextIntlClientProvider } from 'next-intl';
import type { ComponentProps } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ComposerCard } from './ComposerCard';
import { AgentSelector } from './agent-selector';
import { Composer } from './composer';
const win = new Window();
const globals = globalThis as Record<string, unknown>;
for (const key of [
  'window',
  'document',
  'navigator',
  'localStorage',
  'HTMLElement',
  'MutationObserver',
  'ResizeObserver',
])
  globals[key] = Reflect.get(win, key);
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const sdk = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({ ...sdk, useRuntimeSessions: () => ({ data: [] }) }));
const noop = () => undefined;
const agents: ComponentProps<typeof Composer>['agents'] = [
  { name: 'kortix', mode: 'primary', description: 'General assistant', permission: [], options: {} },
  { name: 'reviewer', mode: 'primary', description: 'Review assistant', permission: [], options: {} },
];

for (const placement of ['inline', 'below'] as const) {
  test(`slash Switch agent opens the ${placement} picker without selecting; selection remains explicit`, async () => {
    const selected: (string | null | undefined)[] = [];
    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = create(
        <NextIntlClientProvider locale="en" messages={{}} onError={noop}>
          <QueryClientProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
          >
            <AuthProvider>
              <TooltipProvider>
                <Composer
                  onSend={async () => undefined}
                  agents={agents}
                  selectedAgent="kortix"
                  onAgentChange={(agent) => selected.push(agent)}
                  messages={[]}
                  underbarPlacement={placement}
                />
              </TooltipProvider>
            </AuthProvider>
          </QueryClientProvider>
        </NextIntlClientProvider>,
        {
          createNodeMock: (element) =>
            typeof element.type === 'string' ? document.createElement(element.type) : null,
        },
      );
    });
    if (!tree) throw new Error('Composer did not mount');
    const mounted = tree;
    try {
      const card = () => mounted.root.findByType(ComposerCard);
      const picker = () => mounted.root.findByType(AgentSelector);
      const action = card().props.slashActions.find(
        (row: { id: string }) => row.id === 'switch-agent',
      );
      expect(action).toBeDefined();
      await act(async () => card().props.handleSelectAction(action));
      expect(picker().props.open).toBe(true);
      expect(picker().props.selectedAgent).toBe('kortix');
      expect(selected).toEqual([]);
      await act(async () => picker().props.onOpenChange(false));
      expect(picker().props.open).toBe(false);
      expect(selected).toEqual([]);
      await act(async () => card().props.handleSelectAction(action));
      expect(picker().props.open).toBe(true);
      await act(async () => picker().props.onSelect('reviewer'));
      expect(selected).toEqual(['reviewer']);
    } finally {
      await act(async () => mounted.unmount());
    }
  });
}
