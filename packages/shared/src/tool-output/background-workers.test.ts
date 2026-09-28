import { describe, expect, test } from 'bun:test';
import { parseBackgroundWorkers } from './background-workers';
import { chooser, within } from './testing';

// The mobile worker-list parser (agents-session.ts; web
// session-list-background-tool.tsx holds the same regex), verbatim, kept ONLY
// as the parity oracle.
interface LegacyWorker {
  id: string;
  status: string;
  project: string;
  prompt: string;
}

function legacyParseBackgroundWorkers(output: string): LegacyWorker[] {
  if (!output) return [];
  const entries: LegacyWorker[] = [];
  const re = /\*\*(ses_\S+)\*\*.*?status:\s*(\w+).*?project:\s*(\S+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    entries.push({ id: m[1], status: m[2], project: m[3], prompt: '' });
  }
  return entries;
}

const CR = '\r';
const LS = String.fromCharCode(0x2028);
const ROWS = [
  '- **ses_abc123** · status: running · project: /workspace/app · prompt: fix it',
  '**ses_x** status: done project: p',
  '**SES_y**Status:idle.PROJECT:q',
  '**ses_a**b** status: ok project: x',
  '**ses_z** status: activeproject: y',
  '**ses_w** status: a status: b project: c',
  '**ses_v** status: x project:',
];
const NOISE = [
  '**',
  '*',
  ' ',
  '\t',
  '\n',
  CR,
  LS,
  'status:',
  'project:',
  'ses_',
  'x',
  ':',
  '**ses_q**',
];

/** Real worker rows with up to three noise insertions, one to three per output. */
function workers(c: ReturnType<typeof chooser>): string {
  let text = '';
  for (let line = 0, n = c.pick([1, 2, 3]); line < n; line++) {
    let row = c.pick(ROWS);
    for (let k = 0, m = c.pick([0, 1, 2, 3]); k < m; k++) {
      const at = Math.floor(c.next() * (row.length + 1));
      row = row.slice(0, at) + c.pick(NOISE) + row.slice(at);
    }
    text += row + c.pick(['\n', '\n', ' ', CR]);
  }
  return text;
}

describe('parseBackgroundWorkers', () => {
  test('returns what the regex parser returned on 3000 random worker lists', () => {
    const c = chooser(71);
    let found = 0;
    for (let i = 0; i < 3000; i++) {
      const text = workers(c);
      const expected = legacyParseBackgroundWorkers(text);
      expect(parseBackgroundWorkers(text)).toEqual(expected);
      if (expected.length > 0) found++;
    }
    expect(found).toBeGreaterThan(600);
  });

  test('reads a real list', () => {
    expect(parseBackgroundWorkers(`${ROWS[0]}\n${ROWS[1]}`)).toEqual([
      { id: 'ses_abc123', status: 'running', project: '/workspace/app', prompt: '' },
      { id: 'ses_x', status: 'done', project: 'p', prompt: '' },
    ]);
  });
});

describe('no worker list can freeze the renderer', () => {
  within('30k "**ses_" starts and no status (240k characters)', () =>
    parseBackgroundWorkers('**ses_x '.repeat(30_000)),
  );
  within('one id holding 80k "**" choices', () =>
    parseBackgroundWorkers(`**ses_${'x**'.repeat(80_000)} status: a`),
  );
  within('20k statuses that never reach a project, on one line', () =>
    parseBackgroundWorkers(`**ses_a** ${'status: a '.repeat(20_000)}`),
  );
  within('10k starts, each before the same 10k failing statuses', () =>
    parseBackgroundWorkers(`${'**ses_a** '.repeat(10_000)}${'status: a '.repeat(10_000)}`),
  );
});
