import type { ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { PtySpawnTool } from './pty-spawn-tool';

/**
 * The spawn row follows `bash`'s rule: the trigger keeps what the open card
 * does not say.
 *
 * The card prints the command under a `$`, so an open row that also carried it
 * in the subtitle said it twice — and the trigger's copy is truncated to one
 * line, so a long invocation disagreed with the full text directly beneath it.
 * A model-supplied `Title` is different: the card never repeats it, so it
 * stays.
 */

/** Just the trigger row — the card below renders the command too, so a
 *  whole-document match could not tell the two apart. */
function triggerRegion(html: string): string {
  const start = html.indexOf('data-component="tool-trigger"');
  if (start < 0) throw new Error('no [data-component="tool-trigger"] in the rendered row');
  const body = html.indexOf('class="overflow-hidden text-xs"', start);
  return html.slice(start, body < 0 ? undefined : body);
}

const COMMAND = 'npm run dev -- --port 3000';

function part(output: string, input: Record<string, unknown> = { command: COMMAND }): ToolPart {
  return {
    type: 'tool',
    tool: 'pty_spawn',
    callID: 'call-1',
    state: { status: 'completed', input, output, metadata: {} },
  } as unknown as ToolPart;
}

const spawned = (fields: Record<string, string>) =>
  `<pty_spawned>\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n</pty_spawned>`;

describe('PtySpawnTool trigger drops the command once the card is showing it', () => {
  test('closed, the command is the row — open, it is the card', () => {
    const p = part(spawned({ Command: COMMAND, Status: 'running', PID: '4210' }));

    expect(triggerRegion(renderToStaticMarkup(<PtySpawnTool part={p} />))).toContain(COMMAND);

    const open = renderToStaticMarkup(<PtySpawnTool part={p} defaultOpen />);
    expect(triggerRegion(open)).not.toContain(COMMAND);
    // Still on screen, one line down, under the `$`.
    expect(open).toContain(COMMAND);
    // And the row still says what it is.
    expect(triggerRegion(open)).toContain('Started terminal');
  });

  test('a model-supplied Title survives — the card never repeats it', () => {
    const p = part(spawned({ Title: 'Dev server', Command: COMMAND, Status: 'running' }));
    const open = renderToStaticMarkup(<PtySpawnTool part={p} defaultOpen />);

    expect(triggerRegion(open)).toContain('Dev server');
    // The command still belongs to the card alone.
    expect(triggerRegion(open)).not.toContain(COMMAND);
  });

  test('the process meta stays in the card, open or not', () => {
    // Nothing here is repeated by the trigger, so nothing here is hidden.
    const open = renderToStaticMarkup(
      <PtySpawnTool
        part={part(spawned({ Command: COMMAND, Status: 'running', PID: '4210', ID: 'pty_a1b2' }))}
        defaultOpen
      />,
    );

    expect(open).toContain('pty_a1b2');
    expect(open).toContain('PID 4210');
    expect(open).toContain('running');
  });
});
