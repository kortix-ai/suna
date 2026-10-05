/** The pure parts of Capture Intelligence: masking, moments, episode placement, clustering, variants, stats. */
import { describe, expect, test } from 'bun:test';
import { buildMoments, chunkMoments, maskText, momentLines, normalizeVerb, placeEpisodes, signatureOf, type Moment } from './episodes';
import { agglomerate, describeCluster, differingSteps, editDistance, percentile, sequenceSimilarity, words } from './mining';

const t0 = Date.UTC(2026, 8, 1, 9);
const frame = (s: number, app: string, title: string, text = '') => ({ frameId: `f${s}`, ts: new Date(t0 + s * 1000), app, title, url: null, text });
const action = (s: number, app: string, title: string, kind: string, extra: Record<string, unknown> = {}) => ({
  actionId: `a${s}`, ts: new Date(t0 + s * 1000), kind, app, window: title, description: kind === 'typewrite' ? `Type "${extra.text}"` : kind, target: (extra.target as Record<string, unknown>) ?? null, screenshot: (extra.screenshot as string) ?? null,
});

describe('maskText', () => {
  test('emails, phone numbers, IBANs and long digit runs leave; order numbers and prices stay', () => {
    expect(maskText('Reply to alex.12@customer.example about SO-123456, 42.50 EUR')).toBe('Reply to <email> about SO-123456, 42.50 EUR');
    expect(maskText('call +49 30 1234 5678 today')).toBe('call <phone> today');
    expect(maskText('IBAN DE89 3704 0044 0532 0130 00 ok')).toBe('IBAN <iban> ok');
    expect(maskText('tracking TRK123456789')).toBe('tracking TRK<number>');
  });
});

describe('moments', () => {
  test('one moment per stretch of the same app and window; silence over a minute splits; actions describe what was done', () => {
    const moments = buildMoments(
      [frame(0, 'Helpdesk', 'Ticket 1', 'Damaged box'), frame(10, 'Helpdesk', 'Ticket 1'), frame(20, 'ERP', 'Orders'), frame(200, 'ERP', 'Orders')],
      [action(1, 'Helpdesk', 'Ticket 1', 'click', { target: { name: 'Open' } }), action(21, 'ERP', 'Orders', 'typewrite', { text: 'SO-1' }), action(22, 'ERP', 'Orders', 'screenshot', { screenshot: 'sha256-x.jpg' })],
    );
    expect(moments.map((m) => [m.n, m.app, (m.end - m.start) / 1000, m.did])).toEqual([
      [1, 'Helpdesk', 10, ['click "Open"']],
      [2, 'ERP', 2, ['Type "SO-1"']],
      [3, 'ERP', 0, []],
    ]);
    expect(moments[0]!.text).toBe('Damaged box');
    expect(moments[1]!.screenshot).toBe('sha256-x.jpg');
    const lines = momentLines(moments, new Map([['sha256-x.jpg', 1]]));
    expect(lines).toContain('(idle 3 min)');
    expect(lines).toContain('[shot 1]');
  });

  test('chunks hold at most the limit and cut at the widest gap of the last third', () => {
    const ms: Moment[] = Array.from({ length: 10 }, (_, i) => ({ n: i + 1, start: i * 10_000 + (i >= 8 ? 600_000 : 0), end: i * 10_000 + 5_000 + (i >= 8 ? 600_000 : 0), app: 'A', title: '', url: null, text: '', did: [], frameId: null, actionId: null, screenshot: null }));
    const chunks = chunkMoments(ms, 9);
    expect(chunks.map((c) => c.length)).toEqual([8, 2]);
  });
});

describe('episode placement', () => {
  const ms: Moment[] = [1, 2, 3, 4].map((n) => ({ n, start: n * 1000, end: n * 1000 + 500, app: 'ERP', title: '', url: null, text: '', did: [], frameId: `f${n}`, actionId: null, screenshot: null }));
  test('spans clamp to the chunk, verbs normalize, steps outside the span drop, variables become snake_case names', () => {
    const [e] = placeEpisodes(ms, [
      { first: 0, last: 9, label: 'Refund', goal: null, outcome: null, outcome_status: 'succeeded', procedural: true, steps: [
        { moment: 3, verb: 'look up', app: 'ERP', object: 'order', params: null, variables: ['Order ID'] },
        { moment: 1, verb: 'Issue', app: 'ERP', object: 'refund', params: null, variables: [] },
      ] },
    ]);
    expect([e!.first, e!.last, e!.start, e!.end]).toEqual([1, 4, 1000, 4500]);
    expect(e!.steps.map((s) => [s.moment, s.verb, s.variables])).toEqual([[1, 'Create', []], [3, 'Search', ['order_id']]]);
    expect(normalizeVerb('Find')).toBe('Search');
    expect(signatureOf([{ verb: 'Open', app: 'Help Desk' }, { verb: 'Send', app: null }])).toBe('open@help_desk send@');
  });
});

describe('mining', () => {
  test('edit distance, sequence similarity, words and percentiles', () => {
    expect(editDistance(['a', 'b', 'c'], ['a', 'c'])).toBe(1);
    expect(sequenceSimilarity(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(words('Searching the orders by number')).toEqual(['search', 'order', 'number']);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  test('average linkage merges only above the threshold', () => {
    const sim = [
      [1, 0.9, 0.1],
      [0.9, 1, 0.2],
      [0.1, 0.2, 1],
    ];
    const { clusters, between } = agglomerate(sim, [1, 1, 1], 0.5);
    expect(clusters.map((c) => c.sort())).toEqual([[0, 1], [2]]);
    expect(between(0, 1)).toBeCloseTo(0.15);
  });

  test('a variant differs where its path leaves the canonical one', () => {
    expect(differingSteps(['a', 'b', 'c', 'd'], ['a', 'b', 'x'])).toEqual([3, 4]);
    expect(differingSteps(['a', 'b', 'c'], ['a', 'x', 'b', 'c'])).toEqual([2]);
  });

  test('a cluster yields the canonical path, a variant with its decision point, and the automation score', () => {
    const now = Date.UTC(2026, 8, 29);
    const run = (i: number, path: string[], status = 'succeeded', userId = 'u1') => ({
      episodeId: `e${i}`, userId, start: new Date(now - (i + 1) * 86_400_000), end: new Date(now - (i + 1) * 86_400_000 + 600_000), label: 'Refund a damaged order', goal: null, outcome: null, outcomeStatus: status, workflowId: null,
      signature: path.map((p) => `${p.toLowerCase()}@erp`).join(' '), steps: path.map((verb) => ({ verb, app: 'ERP', object: `${verb} thing`, params: null, variables: [] })),
    });
    const canonical = ['Open', 'Search', 'Create', 'Send'];
    const variant = ['Open', 'Search', 'Reject'];
    const runs = [
      ...Array.from({ length: 8 }, (_, i) => run(i, canonical, 'succeeded', i % 2 ? 'u1' : 'u2')),
      ...Array.from({ length: 3 }, (_, i) => run(10 + i, variant)),
      run(20, ['Open'], 'abandoned'),
    ];
    const w = describeCluster(runs, now);
    expect(w.paths.map((p) => [p.key, p.runs.length])).toEqual([['A', 8], ['B', 3]]);
    expect(w.variants[1]!.differs).toEqual([3, 4]);
    expect(w.steps[1]!.decision).toMatchObject({ variant: 'B' });
    expect(w.stats.people).toBe(2);
    expect(w.stats.p50).toBe(600);
    expect(w.stats.determinism).toBe(1);
    expect(w.stats.successRate).toBeCloseTo(11 / 12);
    // The first run is 21 days old: 12 runs in 3 weeks = 4/week × 10 min × determinism 1.
    expect(w.stats.hoursPerWeek).toBeCloseTo(4 / 6);
  });
});
