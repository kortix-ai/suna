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
  test('a closer glued to the last statement still closes the block, as the hosts render it', () => {
    expect(scoreReply(UI, 'Here.\n\n```openui\nroot = Stack([b])\nb = Badge("ok")```\n\nMore prose.')).toMatchObject({ blocks: 1, validBlocks: 1, issues: [] });
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

describe('empty replies', () => {
  const UI_TWO: EvalCase = { id: 'u2', expect: 'ui', prompt: 'Compare C and D' };

  test('an empty or whitespace reply is an error, not prose', () => {
    expect(scoreReply(PROSE, '  \n')).toMatchObject({ error: 'empty reply', issues: ['empty reply'], overuse: false });
    expect(scoreReply(UI, '').underuse).toBe(false);
  });

  test('errored cases leave the overuse and underuse denominators', () => {
    const result = summarize('m', [UI, UI_TWO], [scoreReply(UI, 'Just text.'), scoreReply(UI_TWO, '')], [100]);
    expect(result.underuseRate).toBe(1);
    expect(result.errorCount).toBe(1);
  });

  test('any errored case fails the gate even when every rate passes', () => {
    const result = summarize('m', [UI, PROSE], [scoreReply(UI, GOOD), scoreReply(PROSE, '')], [100]);
    expect(result).toMatchObject({ errorCount: 1, validRate: 1, overuseRate: 0, underuseRate: 0, go: false });
  });
});

describe('richness', () => {
  const RICH: EvalCase = {
    id: 'r1',
    expect: 'ui',
    prompt: 'Guide me',
    context: 'image_search: station -> https://example.com/img/station.jpg',
    rich: { blocks: 2, needs: ['Steps'] },
  };
  const PREFACE = 'This sentence is the prose before the block.';
  const BADGE = '```openui\nroot = Stack([b])\nb = Badge("ok")\n```';
  const STEP = (url: string) => `s = Steps([a])\na = Step("Go to the station", "Take the train.", "${url}")`;
  const STEPS_AND_LIST = `\`\`\`openui\nroot = Stack([s, c])\n${STEP('https://example.com/img/station.jpg')}\nc = Checklist("Pack", ["Passport"])\n\`\`\``;

  test('a block after 20 or more prose characters counts as interleaved', () => {
    const reply = [PREFACE, BADGE, PREFACE, BADGE, PREFACE, BADGE].join('\n\n');
    expect(scoreReply(UI, reply)).toMatchObject({ blocks: 3, interleaved: 3, thin: false });
    expect(scoreReply(UI, `${BADGE}\n\n${BADGE}`).interleaved).toBe(0);
  });

  test('a heading is not prose: a heading-only section is not interleaved', () => {
    expect(scoreReply(UI, `## 5. After you land in City B\n\n${BADGE}`).interleaved).toBe(0);
    expect(scoreReply(UI, `## 5. After you land in City B\n\n${PREFACE}\n\n${BADGE}`).interleaved).toBe(1);
  });

  test('one block that holds every component is thin on a case that asks for 2 blocks', () => {
    expect(scoreReply(RICH, `${PREFACE}\n\n${STEPS_AND_LIST}`)).toMatchObject({ blocks: 1, interleaved: 1, thin: true });
    expect(scoreReply(RICH, `${PREFACE}\n\n${STEPS_AND_LIST}\n\n${PREFACE}\n\n${BADGE}`).thin).toBe(false);
    expect(scoreReply(RICH, `${PREFACE}\n\n${BADGE}\n\n${PREFACE}\n\n${BADGE}`).thin).toBe(true);
  });

  test('a Step image counts toward images; one not in the case context is foreign', () => {
    const own = scoreReply(RICH, `${PREFACE}\n\n${STEPS_AND_LIST}`);
    expect(own).toMatchObject({ images: 1, foreignImages: 0 });
    expect(own.proseShare).toBeGreaterThan(0);
    expect(own.proseShare).toBeLessThan(1);
    const copied = scoreReply(RICH, `\`\`\`openui\nroot = Stack([s])\n${STEP('https://example.com/photos/station.jpg')}\n\`\`\``);
    expect(copied).toMatchObject({ images: 1, foreignImages: 1, proseShare: 0 });
  });

  test('a prose section of more than 6 sentences in a reply with blocks is long prose; list items count as sentences', () => {
    const long = `## Flights\n\n${'Book early. '.repeat(4)}\n\n- Pick one ticket\n- Keep 3 hours\n- Check bags through`;
    expect(scoreReply(UI, `${PREFACE}\n\n${BADGE}\n\n${long}`).longProse).toBe(1);
    // A heading starts a new section: two sections of 4 sentences are not long.
    expect(scoreReply(UI, `${PREFACE}\n\n${BADGE}\n\n## A\n\n${'One. '.repeat(4)}\n\n## B\n\n${'Two. '.repeat(4)}`).longProse).toBe(0);
    // A reply with no blocks is a prose answer: its length is not a missed block.
    expect(scoreReply(UI, long).longProse).toBe(0);
    expect(summarize('m', [UI], [scoreReply(UI, `${PREFACE}\n\n${BADGE}\n\n${long}`)], [100])).toMatchObject({ longProseCount: 1 });
  });

  test('long prose ignores code, tables, link-only lines, and abbreviations', () => {
    const at = (text: string) => scoreReply(UI, `${PREFACE}\n\n${BADGE}\n\n${text}`).longProse;
    expect(at('```sh\necho a. b. c. d. e. f. g.\n```')).toBe(0);
    expect(at('| a. | b. |\n|---|---|\n| c. | d. |\n| e. | f. |\n| g. | h. |')).toBe(0);
    expect(at('## Sources\n\n' + Array.from({ length: 7 }, (_, i) => `- [Source ${i}](https://example.com/${i})`).join('\n'))).toBe(0);
    expect(at('Use e.g. a taxi. Or i.e. a bus. Ask Mr. Smith. See Dr. Who. Visit St. Mark. Done.')).toBe(0);
    // A "#1 pick" line is not a heading: it does not split a section.
    expect(at('#1 pick is here. One. Two. Three. Four. Five. Six.')).toBe(1);
  });

  test('summarize fails the gate on 1 foreign image and on a thin rate of 0.5', () => {
    const RICH_TWO: EvalCase = { ...RICH, id: 'r2' };
    const full = `${PREFACE}\n\n${STEPS_AND_LIST}\n\n${PREFACE}\n\n${BADGE}`;
    const pass = summarize('m', [RICH, RICH_TWO], [scoreReply(RICH, full), scoreReply(RICH_TWO, full)], [100]);
    expect(pass).toMatchObject({ thinRate: 0, foreignImageCount: 0, go: true });
    const thin = summarize('m', [RICH, RICH_TWO], [scoreReply(RICH, full), scoreReply(RICH_TWO, `${PREFACE}\n\n${STEPS_AND_LIST}`)], [100]);
    expect(thin).toMatchObject({ thinRate: 0.5, go: false });
    const foreign = full.replace('img/station', 'photos/station');
    const copied = summarize('m', [RICH, RICH_TWO], [scoreReply(RICH, foreign), scoreReply(RICH_TWO, full)], [100]);
    expect(copied).toMatchObject({ thinRate: 0, foreignImageCount: 1, go: false });
  });
});
