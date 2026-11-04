import { describe, expect, test } from 'bun:test';

import { parseGoalLog } from './goal-log';

describe('parseGoalLog', () => {
  test('reads the lines the CLI and SDK write as timed entries, without the title', () => {
    const log = '# Log\n\n- 2026-11-04T17:52:06.850Z Goal created: ship docs\n- 2026-11-04T18:00:00Z active → verifying: all criteria met\n';
    expect(parseGoalLog(log)).toEqual([
      { kind: 'entry', at: '2026-11-04T17:52:06.850Z', text: 'Goal created: ship docs' },
      { kind: 'entry', at: '2026-11-04T18:00:00Z', text: 'active → verifying: all criteria met' },
    ]);
  });

  test('keeps a handover between two entries in place, with its paragraphs', () => {
    const log = '# Log\n\n- 2026-11-04T17:00:00Z Goal created: x\n  more detail\n\n## Handover 2026-11-04T18:00:00Z\n\nFirst paragraph.\n\nSecond paragraph.\n\n- 2026-11-04T19:00:00Z active → verifying: done\n';
    expect(parseGoalLog(log)).toEqual([
      { kind: 'entry', at: '2026-11-04T17:00:00Z', text: 'Goal created: x\nmore detail' },
      { kind: 'text', markdown: '## Handover 2026-11-04T18:00:00Z\n\nFirst paragraph.\n\nSecond paragraph.' },
      { kind: 'entry', at: '2026-11-04T19:00:00Z', text: 'active → verifying: done' },
    ]);
  });

  test('a line without a valid time stays text', () => {
    expect(parseGoalLog('- 2026-13-45T99:99Z nope\n- plain bullet')).toEqual([
      { kind: 'text', markdown: '- 2026-13-45T99:99Z nope\n- plain bullet' },
    ]);
  });

  test('a timestamp inside a fenced code block stays in the block', () => {
    const log = '- 2026-11-04T17:00:00Z Handover\n\n```\n- 2026-11-04T18:00:00Z example line\n```\n- 2026-11-04T19:00:00Z next';
    expect(parseGoalLog(log)).toEqual([
      { kind: 'entry', at: '2026-11-04T17:00:00Z', text: 'Handover' },
      { kind: 'text', markdown: '```\n- 2026-11-04T18:00:00Z example line\n```' },
      { kind: 'entry', at: '2026-11-04T19:00:00Z', text: 'next' },
    ]);
  });

  test('inline code that starts with three backticks is not a fence', () => {
    expect(parseGoalLog('```js``` x\n- 2026-11-04T19:00:00Z next')).toEqual([
      { kind: 'text', markdown: '```js``` x' },
      { kind: 'entry', at: '2026-11-04T19:00:00Z', text: 'next' },
    ]);
  });

  test('a shorter fence inside a longer one does not close it', () => {
    const log = '````md\n```\n- 2026-11-04T18:00:00Z example\n```\n````\n- 2026-11-04T19:00:00Z next';
    expect(parseGoalLog(log)).toEqual([
      { kind: 'text', markdown: '````md\n```\n- 2026-11-04T18:00:00Z example\n```\n````' },
      { kind: 'entry', at: '2026-11-04T19:00:00Z', text: 'next' },
    ]);
  });
});
