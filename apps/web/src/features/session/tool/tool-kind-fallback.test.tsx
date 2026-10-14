import '@/features/session/tool/tools/register';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FOREIGN_TOOL_CALLS } from '@/features/session/tool/foreign-tool-calls';
import { patchFilesFromText } from '@/features/session/tool/shared/patch-helpers';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolPartRenderer } from '@/features/session/tool/tool-part-renderer';
import type { ToolCallBlock } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Session Log Plan P5.3: the registry looks up the tool name, then the session-log block
 * `kind`. A tool from another harness (a Codex `exec_command`, a Claude Code `LS`) renders
 * with its kind's renderer, and the renderer reads the foreign input shape.
 */

const render = (call: ToolCallBlock) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ToolPartRenderer call={call} defaultOpen />
        </TooltipProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );

/** Block kind → the registered name whose renderer draws it. */
const KIND_RENDERER: Array<[kind: string, name: string]> = [
  ['shell', 'bash'],
  ['read', 'read'],
  ['write', 'write'],
  ['edit', 'edit'],
  ['patch', 'apply-patch'],
  ['list', 'list'],
  ['glob', 'glob'],
  ['grep', 'grep'],
  ['web_fetch', 'webfetch'],
  ['web_search', 'websearch'],
  ['todo', 'todowrite'],
  ['task', 'task'],
  ['question', 'question'],
];

describe('an unknown tool name renders with its block kind', () => {
  for (const [kind, name] of KIND_RENDERER) {
    test(`kind ${kind} → the ${name} renderer`, () => {
      expect(ToolRegistry.get(name)).toBeDefined();
      expect(ToolRegistry.get('ForeignTool', kind)).toBe(ToolRegistry.get(name)!);
    });
  }

  test('a known name wins over the kind', () => {
    expect(ToolRegistry.get('bash', 'read')).toBe(ToolRegistry.get('bash')!);
  });

  test('a kind with no renderer keeps the generic fallback', () => {
    for (const kind of ['mcp', 'plan', 'other', 'harness_specific', undefined]) {
      expect(ToolRegistry.get('ForeignTool', kind)).toBeUndefined();
    }
  });
});

describe('a session with foreign tool names renders no generic fallback', () => {
  /** What each call's own renderer shows from the foreign input. */
  const SHOWS: Record<string, string[]> = {
    'codex-exec': ['cat hello.txt'],
    'codex-shell': ['bash -lc ls -la'],
    'codex-patch': ['notes.txt', 'plan.md'],
    'codex-plan': ['Read the registry', 'Map the block kind', 'Walk the debug page'],
    'codex-spawn': ['List the files in the workspace'],
    'codex-question': ['Which files should the patch touch?'],
    'cc-ls': ['index.ts', 'util.ts'],
    'cc-edit': ['util.ts', '>+1<', '>−1<'],
    'cc-multiedit': ['index.ts'],
    'cc-grep': ['pattern=TODO', 'include=*.ts', 'index.ts'],
    'cc-agent': ['List files'],
    'cc-question': ['Which notation should the card use?'],
  };

  test('the fixture covers every call', () => {
    expect(FOREIGN_TOOL_CALLS.map((c) => c.id).sort()).toEqual(Object.keys(SHOWS).sort());
  });

  for (const call of FOREIGN_TOOL_CALLS) {
    test(`${call.name} (${call.kind}) renders with a registered renderer`, () => {
      expect(ToolRegistry.get(call.name, call.kind)).toBeDefined();
      const html = render(call);
      for (const text of SHOWS[call.id]!) expect(html).toContain(text.replace(/&/g, '&amp;'));
    });
  }
});

describe('the codex and claude-code golden sessions', () => {
  const FIXTURES = join(import.meta.dir, '../../../../../../packages/api-contract/src/__tests__/fixtures/session-log');
  const toolCalls = (value: unknown): ToolCallBlock[] =>
    Array.isArray(value)
      ? value.flatMap(toolCalls)
      : value && typeof value === 'object'
        ? (value as { type?: unknown }).type === 'tool_call'
          ? [value as ToolCallBlock]
          : Object.values(value).flatMap(toolCalls)
        : [];

  for (const harness of ['codex', 'claude-code']) {
    test(`every ${harness} tool call has a renderer and renders`, () => {
      const calls = toolCalls(JSON.parse(readFileSync(join(FIXTURES, `${harness}.v2.json`), 'utf8')));
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect({ name: call.name, renderer: ToolRegistry.get(call.name, call.kind) !== undefined }).toEqual({ name: call.name, renderer: true });
        expect(render(call).length).toBeGreaterThan(0);
      }
    });
  }
});

describe('patchFilesFromText', () => {
  test('reads each file of a Begin Patch text with its change', () => {
    const text = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '*** Move to: b.txt',
      '@@ intro',
      ' keep',
      '-old',
      '+new',
      '*** Add File: c.md',
      '+# C',
      '*** Delete File: d.txt',
      '*** End Patch',
      '',
    ].join('\n');
    expect(patchFilesFromText(text)).toEqual([
      { relativePath: 'a.txt', type: 'move', movePath: 'b.txt', before: 'keep\nold\n', after: 'keep\nnew\n', additions: 1, deletions: 1 },
      { relativePath: 'c.md', type: 'add', before: '', after: '# C\n', additions: 1, deletions: 0 },
      { relativePath: 'd.txt', type: 'delete', before: undefined, after: undefined, additions: 0, deletions: 0 },
    ]);
  });
});
