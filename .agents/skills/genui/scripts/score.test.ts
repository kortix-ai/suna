import { describe, expect, test } from 'bun:test';

import { scoreReply, summarize, type EvalCase } from './score';

const UI: EvalCase = { id: 'u1', expect: 'ui', prompt: 'Compare A and B' };
const PROSE: EvalCase = { id: 'p1', expect: 'prose', prompt: 'hi' };
const NO_DATA: EvalCase = { id: 'n1', expect: 'either', prompt: 'Chart my revenue', forbid: ['BarChart', 'LineChart', 'PieChart'] };

const GOOD = 'Here.\n\n```openui\nroot = Stack([b])\nb = Badge("ok")\n```';
const BAD = 'Here.\n\n```openui\nroot = Stack([l])\nl = Link("x", "javascript:alert(1)")\n```';
const CHART = '```openui\nroot = Stack([c])\nc = BarChart(["a"], [s], "made up")\ns = Series("S", [1])\n```';

describe('scoreReply', () => {
  test('counts valid blocks and components', () => {
    expect(scoreReply(UI, GOOD)).toMatchObject({ blocks: 1, validBlocks: 1, components: ['Badge', 'Stack'], underuse: false });
  });
  test('an invalid block is counted but not valid, with its issue codes', () => {
    const score = scoreReply(UI, BAD);
    expect(score.validBlocks).toBe(0);
    expect(score.issues).toContain('url:Link');
  });
  test('UI on a prose case is overuse; no UI on a UI case is underuse', () => {
    expect(scoreReply(PROSE, GOOD).overuse).toBe(true);
    expect(scoreReply(UI, 'Just text.').underuse).toBe(true);
  });
  test('a chart without data is a forbidden component', () => {
    expect(scoreReply(NO_DATA, CHART).forbidden).toEqual(['BarChart']);
  });
});

describe('summarize', () => {
  test('applies the go/no-go gate', () => {
    const cases = [UI, PROSE];
    const pass = summarize('m', cases, [scoreReply(UI, GOOD), scoreReply(PROSE, 'Hello!')], [100, 300]);
    expect(pass).toMatchObject({ validRate: 1, overuseRate: 0, underuseRate: 0, go: true, medianCompletionTokens: 300 });
    const fail = summarize('m', cases, [scoreReply(UI, BAD), scoreReply(PROSE, GOOD)], [100]);
    expect(fail.go).toBe(false);
  });
});
