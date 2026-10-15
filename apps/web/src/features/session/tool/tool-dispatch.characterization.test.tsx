import '@/features/session/tool/tools/register';
import { ToolPartRenderer } from './tool-part-renderer';
import { ToolRegistry } from './shared/registry';
import type { ToolPart } from '@/ui';
import { toolCallBlock } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

const part = (tool: string) => ({
  type: 'tool', tool, callID: 'characterization',
  state: { status: 'completed', input: { command: 'echo dispatch' }, output: 'dispatch-result', metadata: {} },
}) as unknown as ToolPart;

function render(tool: string) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <ToolPartRenderer call={toolCallBlock(part(tool))} sessionId="child" defaultOpen />
    </NextIntlClientProvider>,
  );
}

describe('tool registry dispatch', () => {
  test('registered bash tool renders its command', () => {
    expect(ToolRegistry.get('bash')).toBeDefined();
    // Text only: once Shiki has loaded in this process (another file highlighted code), the
    // command renders as token spans.
    expect(render('bash').replace(/<[^>]+>/g, '')).toContain('echo dispatch');
  });

  test('unknown tool renders the generic fallback', () => {
    expect(ToolRegistry.get('unregistered/characterization')).toBeUndefined();
    expect(render('unregistered/characterization')).toContain('Characterization');
  });
});
