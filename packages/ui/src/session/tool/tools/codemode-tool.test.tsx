import { toolCallBlock } from '@kortix/sdk';
import type { ToolPart } from '../../../internal/session-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { IntlTestProvider } from '../../../test-utils/intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { defaultUiMessages as en } from '../../../i18n';
import { CodemodeTool, scriptCalls, scriptResult } from './codemode-tool';

/** The text of rendered markup: tags removed until none remain (one pass can leave a tag behind). */
function textOf(html: string): string {
  let text = html;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previous);
  return text;
}

function render(node: ReactNode) {
  return renderToStaticMarkup(
    <IntlTestProvider locale="en" messages={en} onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>
    </IntlTestProvider>,
  );
}

const CODE = "const a = await tools.bash({ command: 'echo one' }); return a.trim()";

function part(state: Record<string, unknown>): ToolPart {
  return { type: 'tool', tool: 'codemode', callID: 'call-1', state: { input: { code: CODE }, ...state } } as unknown as ToolPart;
}

describe('scriptCalls', () => {
  test('reads pi\'s live record and the session log\'s record at rest as the same rows', () => {
    const live = scriptCalls({ calls: [{ id: 'c/1', name: 'bash', args: '{"command":"echo one"}', status: 'ok', durationMs: 12 }] });
    const atRest = scriptCalls({ calls: [{ call_id: 'c/1', name: 'bash', kind: 'shell', input: { command: 'echo one' }, status: 'complete', duration_ms: 12 }] });
    expect(live).toEqual([{ id: 'c/1', name: 'bash', arg: 'echo one', status: 'ok', durationMs: 12 }]);
    expect(atRest).toEqual(live);
  });

  test('a truncated live argument stays as text; unknown and interrupted calls read as cancelled', () => {
    expect(scriptCalls({ calls: [{ id: 'c/1', name: 'read', args: '{"path":"a very long pa…', status: 'running' }] })[0]).toMatchObject({ arg: '{"path":"a very long pa…', status: 'running' })
    expect(scriptCalls({ calls: [{ call_id: 'c/2', name: 'bash', status: 'interrupted' }, { id: 'c/3', name: 'bash', status: 'odd' }] }).map((c) => c.status)).toEqual(['cancelled', 'cancelled']);
    expect(scriptCalls({})).toEqual([]);
  });

  test('a call the runtime blocked by design reads as refused; any other error stays an error', () => {
    const rows = scriptCalls({
      calls: [
        { id: 'a', name: 'bash', status: 'error', error: 'The project policy denies this bash call.' },
        { id: 'b', name: 'bash', status: 'error', error: 'The user rejected this tool call.' },
        { id: 'c', name: 'task', status: 'error', error: 'Call task directly, not from a script.' },
        { id: 'd', name: 'read', status: 'error', error: 'ENOENT: no such file' },
      ],
    });
    expect(rows.map((c) => c.status)).toEqual(['refused', 'refused', 'refused', 'error']);
  });
});

describe('scriptResult', () => {
  test('drops pi\'s header lines and keeps the output items', () => {
    expect(scriptResult('Script completed\nWall time 0.1 seconds\nOutput:\n==> text 1/2 <==\nhi\n==> text 2/2 <==\n[2]')).toBe('==> text 1/2 <==\nhi\n==> text 2/2 <==\n[2]');
    expect(scriptResult('Script failed\nWall time 0.0 seconds\nOutput:\nScript error:\nboom')).toBe('Script error:\nboom');
    expect(scriptResult('plain')).toBe('plain');
  });
});

describe('CodemodeTool', () => {
  test('a finished script shows its calls, its code and its output', () => {
    const html = render(
      <CodemodeTool
        call={toolCallBlock(
          part({
            status: 'completed',
            output: 'Script completed\nWall time 0.0 seconds\nOutput:\none',
            metadata: { calls: [{ id: 'call-1/1', name: 'bash', args: '{"command":"echo one"}', status: 'ok', durationMs: 12 }] },
          }),
        )}
        defaultOpen
      />,
    );
    expect(html).toContain('Ran script');
    expect(html).toContain('>bash<');
    expect(html).toContain('echo one');
    expect(html).toContain('12 ms');
    expect(html).toContain('one');
    expect(html).not.toContain('Wall time');
    // The script, as text: once Shiki has loaded it renders as token spans.
    expect(textOf(html)).toContain('await tools.bash({ command:');
  });

  test('a failed script shows the verdict, the call that failed and the error', () => {
    const html = render(
      <CodemodeTool
        call={toolCallBlock(
          part({
            status: 'error',
            error: 'Script failed\nWall time 0.0 seconds\nOutput:\nScript error:\nThe project policy denies this bash call.',
            metadata: { calls: [{ id: 'call-1/1', name: 'bash', args: '{"command":"rm -rf ./keep"}', status: 'error', error: 'The project policy denies this bash call.' }] },
          }),
        )}
        defaultOpen
      />,
    );
    expect(html).toContain('Script failed');
    expect(html).toContain('rm -rf ./keep');
    expect(html).toContain('Script error:');
    expect(html.match(/The project policy denies this bash call\./g)).toHaveLength(2);
  });

  test('a closed row summarises the calls by count and name', () => {
    const html = render(
      <CodemodeTool
        call={toolCallBlock(
          part({
            status: 'completed',
            output: 'Script completed\nOutput:\nx',
            metadata: { calls: [{ id: 'a', name: 'bash', status: 'ok' }, { id: 'b', name: 'read', status: 'ok' }, { id: 'c', name: 'bash', status: 'ok' }] },
          }),
        )}
      />,
    );
    expect(html).toContain('3 tool calls · bash · read');
  });

  test('a nested image_gen call reads as its first prompt, not as JSON; the image stays its own card', () => {
    const args = { action: 'generate', prompts: ['A fox in a shuttle', 'An owl in a shuttle', 'A hare in a shuttle'] };
    // pi's live record (JSON text) and the session log's record at rest read the same.
    for (const call of [
      { id: 'img', name: 'image_gen', args: JSON.stringify(args), status: 'ok', durationMs: 42_000 },
      { call_id: 'img', name: 'image_gen', input: args, status: 'complete', duration_ms: 42_000 },
    ]) {
      expect(scriptCalls({ calls: [call] })[0]).toMatchObject({ name: 'image_gen', arg: 'A fox in a shuttle (+2)', status: 'ok' });
    }
    const block = toolCallBlock(
      part({
        status: 'completed',
        output: 'Script completed\nOutput:\nok',
        metadata: { calls: [{ id: 'img', name: 'image_gen', args: JSON.stringify(args), status: 'ok' }, { id: 'b', name: 'bash', status: 'ok' }] },
      }),
    );
    const html = render(<CodemodeTool defaultOpen call={block} />);
    const text = textOf(html);
    expect(text).toContain('A fox in a shuttle (+2)');
    expect(text).not.toContain('"prompts"');
    // The closed row counts the image call as one call.
    expect(render(<CodemodeTool call={block} />)).toContain('2 tool calls · image_gen · bash');
    // The script card lists the call; it draws no image frame.
    expect(html).not.toContain('aria-busy');
    expect(html).not.toContain('<img');
  });
});
