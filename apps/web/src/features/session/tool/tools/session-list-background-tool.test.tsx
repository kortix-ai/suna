import type { ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SessionListBackgroundTool } from './session-list-background-tool';

// Characterization: `session_list` rows were scraped with an inline copy of
// the shared parser's regex. These tests pin what a person sees — the worker
// rows on well-formed lists, the fallbacks around them, and the parse cost on
// adversarial output — so the shared bounded parser can replace the inline
// copy without changing any of it. The goldens were recorded from the inline
// regex before the swap (see KRTX-1756).

function makePart(output: string, status = 'completed'): ToolPart {
  return {
    type: 'tool',
    tool: 'session_list',
    callID: 'call-1',
    state: { status, input: {}, output, metadata: {} },
  } as unknown as ToolPart;
}

const TWO_ROWS = [
  '- **ses_abc123def456** · status: running · project: /workspace/app · prompt: fix it',
  '**ses_x** status: done project: p',
].join('\n');

describe('SessionListBackgroundTool renders the worker rows', () => {
  test('a normal list shows every row and the count', () => {
    const html = renderToStaticMarkup(<SessionListBackgroundTool part={makePart(TWO_ROWS)} defaultOpen />);

    // The row is the id's last 12 characters, the project, and the status.
    expect(html).toContain('bc123def456');
    expect(html).toContain('/workspace/app');
    expect(html).toContain('running');
    expect(html).toContain('ses_x');
    expect(html).toContain('done');
    expect(html).toContain('2 workers');
  });

  test('odd rows keep their shape: case-insensitive keys, a glued project, ** inside an id', () => {
    const odd = [
      '**SES_y**Status:idle.PROJECT:q_river',
      '**ses_z** status: activeproject: yosemite',
      `**ses_${'x**'.repeat(6)} status: running project: /app`,
    ].join('\n');
    const html = renderToStaticMarkup(<SessionListBackgroundTool part={makePart(odd)} defaultOpen />);

    expect(html).toContain('SES_y');
    expect(html).toContain('idle');
    expect(html).toContain('q_river');
    expect(html).toContain('ses_z');
    expect(html).toContain('active');
    expect(html).toContain('yosemite');
    // `\S+` is greedy: the id ends at the last `**` of its run.
    expect(html).toContain('**x**x**x**x');
    expect(html).toContain('running');
    expect(html).toContain('/app');
  });

  test('rows split by the other line terminators keep their rows: CR, U+2028, U+2029', () => {
    // The legacy `.` excluded every JavaScript line terminator, not only \n:
    // a row cannot swallow the next one across CR, LS or PS, and a terminator
    // inside a row ends that row. The shared parser pins the same rule
    // (packages/shared scan.ts isLineTerminator); these goldens keep the
    // component honest about it too.
    const byKind = ['**ses_cr1** status: running project: /w/cr', '**ses_ls1** status: idle project: /w/ls', '**ses_ps1** status: done project: /w/ps'].join('\r\u2028\u2029');
    const html = renderToStaticMarkup(<SessionListBackgroundTool part={makePart(byKind)} defaultOpen />);

    expect(html).toContain('ses_cr1');
    expect(html).toContain('running');
    expect(html).toContain('/w/cr');
    expect(html).toContain('ses_ls1');
    expect(html).toContain('idle');
    expect(html).toContain('/w/ls');
    expect(html).toContain('ses_ps1');
    expect(html).toContain('done');
    expect(html).toContain('3 workers');

    // A terminator inside a row cuts it: the broken row renders nothing, the
    // next complete row still does.
    const cut = '**ses_cut1** \rstatus: running project: /w/cut\n**ses_ok1** status: done project: /w/ok';
    const cutHtml = renderToStaticMarkup(<SessionListBackgroundTool part={makePart(cut)} defaultOpen />);

    expect(cutHtml).not.toContain('ses_cut1');
    expect(cutHtml).toContain('ses_ok1');
    expect(cutHtml).toContain('1 workers');
  });

  test('no output at all and completed says there were no background sessions', () => {
    // `noWorkers` sits behind the truthy-output branch: the empty state is the
    // answer only when the output itself is empty.
    const open = renderToStaticMarkup(<SessionListBackgroundTool part={makePart('')} defaultOpen />);
    expect(open).toContain('No background sessions');

    // Closed, the trigger still says what happened.
    const closed = renderToStaticMarkup(<SessionListBackgroundTool part={makePart('')} />);
    expect(closed).toContain('none');
  });

  test('a completed run whose output says nothing parseable shows the raw output, not the empty state', () => {
    const html = renderToStaticMarkup(
      <SessionListBackgroundTool part={makePart('all workers finished')} defaultOpen />,
    );

    expect(html).toContain('all workers finished');
    expect(html).not.toContain('No background sessions');
  });

  test('a ses_ mention that parses to no rows falls back to the raw output', () => {
    const html = renderToStaticMarkup(
      <SessionListBackgroundTool part={makePart('**ses_gone** status: lost')} defaultOpen />,
    );

    expect(html).toContain('ses_gone');
    expect(html).toContain('lost');
    expect(html).not.toContain('No background sessions');
  });
});

describe('SessionListBackgroundTool cannot be frozen by its output', () => {
  test('thousands of ** pairs and statuses that never reach a project parse linearly and row-less', () => {
    // 1000 `**ses_a**` starts, each able to reach 1000 `status: a` keys with
    // no `project:` behind any of them: the old inline regex retried the whole
    // remaining output for every start and ran for seconds on this payload.
    const pathological = `${'**ses_a** '.repeat(1000)}${'status: a '.repeat(1000)}`;

    const started = performance.now();
    const html = renderToStaticMarkup(<SessionListBackgroundTool part={makePart(pathological)} defaultOpen />);
    const elapsed = performance.now() - started;

    expect(html).toContain('status: a');
    expect(elapsed).toBeLessThan(2500);
  }, 30_000);
});
