import { describe, expect, test } from 'bun:test';
import {
  ARTIFACT_REANCHOR_READ_UNITS,
  ARTIFACT_TEXT_CONTEXT_MAX,
  ARTIFACT_TEXT_QUOTE_MAX,
  artifactCommentAnchorSchema,
  createArtifactReanchorBudget,
  createArtifactReanchorBudgets,
  reanchorArtifactText,
  type ArtifactCommentAnchor,
  type ArtifactTextAnchor,
} from './artifact-comments';

const anchor = (quote: string, prefix = '', suffix = ''): ArtifactTextAnchor => ({ type: 'text', version: 'v1', quote, prefix, suffix });

describe('artifact comment anchors', () => {
  test('validates text, whole-artifact, point and region selectors', () => {
    const page = { version: 'v1', selector: '#summary', snippet: 'Summary', viewport_width: 1200, scroll: { x: 0, y: 300 } };
    const values: ArtifactCommentAnchor[] = [anchor('A selected sentence'), { type: 'none', version: 'v1' },
      { type: 'point', ...page, offset: { x: 0.5, y: 1 } },
      { type: 'region', ...page, offset: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 } }];
    for (const value of values) {
      expect(artifactCommentAnchorSchema.parse(value)).toEqual(value);
    }
  });

  test('rejects invalid versions, selectors, lengths and geometry', () => {
    const page = { type: 'region', version: 'v1', selector: 'main', snippet: '', viewport_width: 1200, scroll: { x: 0, y: 0 }, offset: { x: 0, y: 0, width: 0.5, height: 0.5 } };
    for (const value of [anchor(''), anchor('x'.repeat(501)), anchor('quote', 'x'.repeat(33)), anchor('quote', '', 'x'.repeat(33)),
      { type: 'none', version: '' }, { ...page, selector: '' }, { ...page, snippet: 'x'.repeat(121) },
      { ...page, viewport_width: Infinity }, { ...page, scroll: { x: 0, y: -1 } },
      { ...page, offset: { x: 0.9, y: 0, width: 0.2, height: 0.5 } },
      { ...page, offset: { x: 0, y: 0, width: 0, height: 0.5 } }, { type: 'none', version: 'v1', comment: 'hidden' }]) {
      expect(artifactCommentAnchorSchema.safeParse(value).success).toBe(false);
    }
  });

  test('rejects NUL and malformed Unicode in every stored anchor string', () => {
    const page = { type: 'point', version: 'v1', selector: 'main', snippet: '', viewport_width: 1200, scroll: { x: 0, y: 0 }, offset: { x: 0, y: 0 } };
    for (const invalid of ['\0', '\uD800', '\uDC00']) {
      for (const value of [
        { type: 'none', version: `v${invalid}` },
        { ...anchor('quote'), quote: `q${invalid}` },
        { ...anchor('quote'), prefix: invalid },
        { ...anchor('quote'), suffix: invalid },
        { ...page, selector: `main${invalid}` },
        { ...page, snippet: invalid },
      ]) {
        expect(artifactCommentAnchorSchema.safeParse(value).success).toBe(false);
      }
    }
    expect(artifactCommentAnchorSchema.safeParse(anchor('A valid 😀 quote')).success).toBe(true);
  });

  test('a text quote holds up to 500 UTF-16 code units and its context stays at 32', () => {
    expect(ARTIFACT_TEXT_QUOTE_MAX).toBe(500);
    expect(ARTIFACT_TEXT_CONTEXT_MAX).toBe(32);
    expect(artifactCommentAnchorSchema.safeParse(anchor('x'.repeat(500), 'p'.repeat(32), 's'.repeat(32))).success).toBe(true);
    expect(artifactCommentAnchorSchema.safeParse(anchor('x'.repeat(501))).success).toBe(false);
  });
});

describe('artifact text re-anchoring', () => {
  test('follows a unique quote after text moves without changing the anchor', () => {
    const value = anchor('Selected sentence', 'Old prefix ', '.');
    expect(reanchorArtifactText('New paragraph. Selected sentence.', value)).toEqual({ start: 15, end: 32, outdated: false });
    expect(value.version).toBe('v1');
  });

  test('uses prefix and suffix to disambiguate repeated quotes', () => {
    expect(reanchorArtifactText('first quote. second quote!', anchor('quote', 'second ', '!'))).toEqual({ start: 20, end: 25, outdated: false });
    expect(reanchorArtifactText('quote and quote', anchor('quote')).outdated).toBe(true);
  });

  test('accepts substitution, insertion and deletion within ten percent', () => {
    for (const text of ['xxabcdefghXjyy', 'xxabcdeXfghijyy', 'xxabcdefgijyy', 'xxabcdefghiyy', 'xxbcdefghijyy', 'xxXbcdefghijyy']) {
      const result = reanchorArtifactText(text, anchor('abcdefghij', 'xx', 'yy'));
      expect(result).toEqual({ start: 2, end: text.length - 2, outdated: false });
    }
  });

  test('marks removed, ambiguous or excessively changed quotes outdated', () => {
    for (const text of ['The sentence was removed.', 'abcXefgYij', 'abcdefghXj and abcdefghYj']) {
      expect(reanchorArtifactText(text, anchor('abcdefghij'))).toEqual({ start: null, end: null, outdated: true });
    }
    expect(reanchorArtifactText('shXrt', anchor('short')).outdated).toBe(true);
  });

  test('does not let a later worse match overwrite a better one', () => {
    expect(reanchorArtifactText('xxabcdefghijklmnopqrsXyy abcXefghijklmnopqrXtyy', anchor('abcdefghijklmnopqrst'))).toEqual({ start: 2, end: 22, outdated: false });
  });

  test('disambiguates repeated exact quotes with bounded context', () => {
    const repeated = 'a'.repeat(1_048_576);
    expect(reanchorArtifactText(`${repeated}L a R`, anchor('a', 'L ', ' R')))
      .toEqual({ start: repeated.length + 2, end: repeated.length + 3, outdated: false });
  });

  test('keeps leading deletions when context selects one of repeated fuzzy quotes', () => {
    const quote = 'abcdefghijklmnopqrstuvwxyz123456';
    const shortened = quote.slice(3);
    expect(reanchorArtifactText(`L${shortened}R -- ${shortened}R`, anchor(quote, 'L', 'R')))
      .toEqual({ start: 1, end: 1 + shortened.length, outdated: false });
  });

  test('finds a contextual fuzzy quote at the end of a 16 MiB document with dense false context candidates', () => {
    const repeated = 'ab'.repeat((16 * 1024 * 1024 - 34) / 2);
    const text = `${repeated}a${'ab'.repeat(16)}a`;
    expect(text.length).toBe(16 * 1024 * 1024);
    expect(reanchorArtifactText(text, anchor(`${'ab'.repeat(15)}Xb`, 'a', 'a')))
      .toEqual({ start: repeated.length + 1, end: repeated.length + 33, outdated: false });
  });
});

describe('re-anchoring budget for one read', () => {
  // Strix: crafted unmatched long quotes on a repetitive document cost ~110 ms each, and a list read
  // re-anchors every thread. One read now shares one budget; fuzzy work past it is outdated.
  const line = 'Revenue grew in the quarter and churn fell again. ';
  const text = line.repeat(460);
  const crafted = anchor(`${line.slice(0, 30)}X${line.slice(31)}${line}${line}${line}`.slice(0, 200));

  test('one crafted long quote stays within the per-anchor cap', () => {
    const budget = createArtifactReanchorBudget();
    reanchorArtifactText(text, crafted, budget);
    // The cap is checked between alignments, so the last band may finish: at most (500 + 50) x 101 cells.
    expect(ARTIFACT_REANCHOR_READ_UNITS - budget.remaining).toBeLessThanOrEqual((1 << 20) + 2 * text.length + 550 * 101);
  });

  test('sixty crafted quotes in one read spend at most the read budget, then come back outdated', () => {
    const budget = createArtifactReanchorBudget();
    const started = performance.now();
    const results = Array.from({ length: 60 }, () => reanchorArtifactText(text, crafted, budget));
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(budget.remaining).toBeLessThanOrEqual(0);
    expect(results.at(-1)).toEqual({ start: null, end: null, outdated: true });
  });

  test('an exact match is cheap: each scan charges an eighth of the text, and a spent budget scans nothing', () => {
    const text = 'Revenue grew. churn fell to 2.1%. Done.';
    const exact = anchor('churn fell to 2.1%');
    const budget = createArtifactReanchorBudget();
    expect(reanchorArtifactText(text, exact, budget)).toEqual({ start: 14, end: 32, outdated: false });
    expect(ARTIFACT_REANCHOR_READ_UNITS - budget.remaining).toBe(2 * Math.ceil(text.length / 8));
    budget.remaining = 0;
    expect(reanchorArtifactText(text, exact, budget)).toEqual({ start: null, end: null, outdated: true });
  });

  test("one author's unmatched quotes spend only their own share: another author's thread still re-anchors (Strix: starvation)", () => {
    const budgetFor = createArtifactReanchorBudgets(['user:a', 'user:b']);
    const placed = 'Revenue grew in the quarter and churn fell to 2.1 percent.';
    const doc = `${text}${placed}`;
    for (let i = 0; i < 60; i++) reanchorArtifactText(doc, crafted, budgetFor('user:a'));
    expect(budgetFor('user:a').remaining).toBeLessThanOrEqual(0);
    expect(reanchorArtifactText(doc, anchor(placed), budgetFor('user:b')).outdated).toBe(false);
    expect(budgetFor('user:a').remaining + budgetFor('user:b').remaining).toBeLessThanOrEqual(ARTIFACT_REANCHOR_READ_UNITS);
  });

  test('many unmatched quotes on a 2 MB document stay within one read budget (Strix: exact scans were unbounded)', () => {
    const big = 'Plain filler sentence for a large document body. '.repeat(40_000);
    const budget = createArtifactReanchorBudget();
    const started = performance.now();
    for (let i = 0; i < 200; i++) reanchorArtifactText(big, anchor(`missing quote number ${i} zz`), budget);
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(budget.remaining).toBeLessThanOrEqual(0);
  });

  test('a spent budget marks a short fuzzy quote outdated instead of scanning the text', () => {
    const budget = createArtifactReanchorBudget();
    budget.remaining = 0;
    expect(reanchorArtifactText('Revenue grew. churn fell to 2.2%. Done.', anchor('churn fell to 2.1% in the quarter'.slice(0, 30)), budget).outdated).toBe(true);
  });
});

describe('long text quotes (33 to 500 code units)', () => {
  const passage = 'The launch review covers pricing, onboarding, support staffing and the billing migration. ' +
    'Each owner confirms the date, the risks and the rollback plan before the train leaves on Thursday.';
  const doc = (body: string) => `# Plan\n\nIntro line.\n\n${body}\n\nOutro line.\n`;
  const span = (text: string, body: string) => ({ start: text.indexOf(body), end: text.indexOf(body) + body.length, outdated: false });

  test('an unchanged long quote resolves to its whole span, and context picks one of two copies', () => {
    expect(passage.length).toBeGreaterThan(160);
    expect(reanchorArtifactText(doc(passage), anchor(passage))).toEqual(span(doc(passage), passage));
    const twice = `Alpha: ${passage}\nBeta: ${passage}\n`;
    expect(reanchorArtifactText(twice, anchor(passage, 'Beta: ', '\n')))
      .toEqual({ start: twice.lastIndexOf(passage), end: twice.lastIndexOf(passage) + passage.length, outdated: false });
    expect(reanchorArtifactText(twice, anchor(passage)).outdated).toBe(true);
  });

  test('an edit inside a long quote within ten percent moves the end with the text', () => {
    const edited = passage.replace('support staffing', 'support hiring').replace('Thursday', 'Friday');
    expect(reanchorArtifactText(doc(edited), anchor(passage, 'Intro line.\n\n', '\n\nOutro line.\n'))).toEqual(span(doc(edited), edited));
  });

  test('an edit in the first words falls back to the end of the quote and still covers the whole span', () => {
    const edited = passage.replace('launch review covers', 'launch plan review now covers');
    expect(reanchorArtifactText(doc(edited), anchor(passage))).toEqual(span(doc(edited), edited));
  });

  test('a decoy copy of the first 32 characters does not capture an edited long quote', () => {
    const edited = passage.replace('launch review covers', 'launch plan review now covers');
    const text = `${passage.slice(0, 40)} is a different sentence.\n\n${edited}\n`;
    expect(reanchorArtifactText(text, anchor(passage))).toEqual(span(text, edited));
  });

  test('a long quote changed by more than ten percent, or longer than 500, is outdated', () => {
    const rewritten = passage.replace('pricing, onboarding, support staffing and the billing migration', 'nothing else');
    expect(reanchorArtifactText(doc(rewritten), anchor(passage))).toEqual({ start: null, end: null, outdated: true });
    const overlong = 'x'.repeat(501);
    expect(reanchorArtifactText(`a ${overlong} b`, anchor(overlong)).outdated).toBe(true);
  });

  test('the whole quote picks the closer of two paragraphs, not the closer opening words', () => {
    const quote = 'Team South revenue grew twelve percent in the third quarter after the regional offices opened and hired four engineers.';
    expect(quote).toHaveLength(119);
    // 1 edit in the opening 32 characters, 10 overall: inside the 11-edit budget, but not the closest paragraph.
    const decoy = quote.replace('South', 'Mouth').replace('four engineers', 'nine designers');
    // 2 edits in the opening 32 characters, 2 overall.
    const edited = quote.replace('Team', 'Tim');
    const text = `# Quarterly notes\n${decoy}\n\n${edited}\n`;
    expect(text.indexOf(edited)).toBe(139);
    expect(reanchorArtifactText(text, anchor(quote))).toEqual({ start: 139, end: 139 + edited.length, outdated: false });
  });

  test('two passages at the same fewest edits are outdated unless exactly one matches the context', () => {
    const quote = 'Team South revenue grew twelve percent in the third quarter after the regional offices opened and hired four engineers.';
    const edited = quote.replace('Team', 'Tim');
    const twice = `Alpha: ${edited}\nBeta: ${edited}\n`;
    expect(reanchorArtifactText(twice, anchor(quote))).toEqual({ start: null, end: null, outdated: true });
    const second = twice.lastIndexOf(edited);
    expect(reanchorArtifactText(twice, anchor(quote, 'Beta: ', '\n'))).toEqual({ start: second, end: second + edited.length, outdated: false });
  });

  test('opening words that match everywhere leave the closing words to decide', () => {
    const quote = `${' '.repeat(40)}return the regional total for the third quarter;`;
    const edited = quote.replace('regional', 'regionel');
    const text = `${' '.repeat(70_000)}\n${edited}\n`;
    expect(reanchorArtifactText(text, anchor(quote))).toEqual({ start: text.indexOf(edited), end: text.indexOf(edited) + edited.length, outdated: false });
  });

  test('a 500 code unit quote resolves exactly and after a small edit', () => {
    const words = Array.from({ length: 160 }, (_, index) => `w${index}`).join(' ');
    const quote = words.slice(0, 500);
    expect(quote).toHaveLength(500);
    expect(reanchorArtifactText(doc(quote), anchor(quote))).toEqual(span(doc(quote), quote));
    const edited = quote.replace('w40 w41', 'w40 inserted w41');
    expect(reanchorArtifactText(doc(edited), anchor(quote))).toEqual(span(doc(edited), edited));
  });
});
