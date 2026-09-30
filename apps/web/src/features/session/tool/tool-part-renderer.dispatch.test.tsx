import type { ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ToolSurfaceContext } from './shared/infrastructure';
import { ToolRegistry } from './shared/registry';
import { ToolPartRenderer } from './tool-part-renderer';

/**
 * Characterization tests for tool dispatch (spec KRTX-483 phase 1).
 *
 * They pin the behavior the later phases restructure, and must pass before and
 * after them: a registered tool part renders its REGISTERED component, an
 * unknown tool part falls back to `GenericTool`. Importing the renderer runs
 * its bottom side-effect `import '@/features/session/tool/tools/register'`, so
 * every assertion below drives the real registry — no registration is faked.
 *
 * Harness: static markup (this app has no DOM in tests — no jsdom,
 * no happy-dom, no react-test-renderer), same as `tool-part-renderer.stale.test.tsx`.
 */

const agentStatusPart = {
  type: 'tool',
  tool: 'agent_status',
  callID: 'call-agent-status',
  state: {
    status: 'completed',
    input: {},
    output: [
      '**task-synthetic1** Draft the outline — completed',
      '**task-synthetic2** Fill the sections — in_progress',
    ].join('\n'),
    metadata: {},
  },
} as unknown as ToolPart;

const unknownPart = {
  type: 'tool',
  tool: 'totally-unregistered-probe',
  callID: 'call-unknown',
  state: {
    status: 'completed',
    input: { prompt: 'synthetic probe input' },
    output: 'synthetic probe output',
    metadata: {},
  },
} as unknown as ToolPart;

const render = (part: ToolPart) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
        <ToolSurfaceContext.Provider value="panel">
          <ToolPartRenderer part={part} sessionId="s-synthetic" defaultOpen />
        </ToolSurfaceContext.Provider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

describe('ToolPartRenderer dispatches a registered tool to its registered component', () => {
  test('the registry holds the renderer for the part tool', () => {
    expect(ToolRegistry.get('agent_status')).toBeDefined();
  });

  test('a registered part renders the registered renderer, not the generic fallback', () => {
    const html = render(agentStatusPart);

    // The registered component's trigger title and its computed badge —
    // `GenericTool` renders neither (a fallback title would be the humanized
    // name "Agent Status"; a generic body would show the raw output text).
    expect(html).toContain('Agent status');
    expect(html).toContain('2 tasks');

    // The panel surface is a disclosure; seeded open, the task rows are the body.
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Draft the outline');
    expect(html).toContain('Fill the sections');
  });

  test('the dispatched markup is what the registered component itself renders', () => {
    const Registered = ToolRegistry.get('agent_status');
    if (!Registered) throw new Error('agent_status is not registered');

    const direct = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
          <ToolSurfaceContext.Provider value="panel">
            <Registered part={agentStatusPart} sessionId="s-synthetic" defaultOpen />
          </ToolSurfaceContext.Provider>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

    expect(direct).toContain('Agent status');
    expect(direct).toContain('2 tasks');
    expect(direct).toContain('Draft the outline');
  });
});

describe('ToolPartRenderer falls back to GenericTool for an unknown tool', () => {
  test('nothing is registered under the unknown name', () => {
    expect(ToolRegistry.get('totally-unregistered-probe')).toBeUndefined();
  });

  test('an unknown part renders the generic fallback with the humanized name', () => {
    const html = render(unknownPart);

    // GenericTool's trigger: the humanized leaf of the raw tool name, the
    // primary input as the subtitle, the output in the generic body.
    expect(html).toContain('Totally Unregistered Probe');
    expect(html).toContain('synthetic probe input');
    expect(html).toContain('synthetic probe output');
  });
});
