/** The pure parts of Capture Intelligence: masking, moments, episode placement, clustering, variants, stats. */
import { describe, expect, test } from 'bun:test';
import { buildMoments, chunkMoments, isValueVariable, maskText, scrubLiterals, momentLines, normalizeVerb, placeEpisodes, signatureOf, type Moment } from './episodes';
import { agglomerate, commonSubsequence, describeCluster, differingSteps, editDistance, groupRuns, percentile, sequenceSimilarity, startedWorkflow, words, workflowGroup } from './mining';

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

describe('scrubLiterals', () => {
  test('labels, goals and outcomes keep the kind of task, never one instance of it', () => {
    expect(scrubLiterals('Approve expense report EXP-968')).toBe('Approve expense report');
    expect(scrubLiterals('Escalate late shipment for order SO-905232')).toBe('Escalate late shipment for order');
    expect(scrubLiterals("Review the expense report EXP-968 and its receipts, then approve it.")).toBe('Review the expense report and its receipts, then approve it.');
    expect(scrubLiterals('Reply to <email> about ticket #41234.')).toBe('Reply to about ticket.');
    expect(scrubLiterals('Refund a damaged order')).toBe('Refund a damaged order');
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
    const ms: Moment[] = Array.from({ length: 10 }, (_, i) => ({ n: i + 1, start: i * 10_000 + (i >= 8 ? 600_000 : 0), end: i * 10_000 + 5_000 + (i >= 8 ? 600_000 : 0), app: 'A', title: '', url: null, text: '', did: [], frameId: null, actionId: null, inputs: [], screenshot: null }));
    const chunks = chunkMoments(ms, 9);
    expect(chunks.map((c) => c.length)).toEqual([8, 2]);
  });
});

describe('episode placement', () => {
  const ms: Moment[] = [1, 2, 3, 4].map((n) => ({ n, start: n * 1000, end: n * 1000 + 500, app: 'ERP', title: '', url: null, text: '', did: [], frameId: `f${n}`, actionId: null, inputs: n === 2 ? [{ actionId: 'a2', ts: 2100 }, { actionId: 'a3', ts: 2300 }] : [], screenshot: null }));
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
    expect(normalizeVerb('Reply')).toBe('Send');
    expect(normalizeVerb('Review')).toBe('Read');
    expect(signatureOf([{ verb: 'Open', app: 'Help Desk' }, { verb: 'Send', app: null }])).toBe('open@help_desk send@');
  });
});

describe('step times and variables', () => {
  const ms: Moment[] = [1, 2].map((n) => ({ n, start: n * 1000, end: n * 1000 + 900, app: 'ERP', title: '', url: null, text: '', did: [], frameId: `f${n}`, actionId: `first${n}`, inputs: n === 1 ? [{ actionId: 'a1', ts: 1200 }, { actionId: 'a2', ts: 1500 }] : [], screenshot: null }));
  const step = (moment: number, verb: string, variables: string[] = []) => ({ moment, verb, app: 'ERP', object: 'x', params: null, variables });
  test('steps at one moment take its input actions in order, else an even share; times strictly increase', () => {
    const [e] = placeEpisodes(ms, [{ first: 1, last: 2, label: 'T', goal: null, outcome: null, outcome_status: null, procedural: true, steps: [step(1, 'Open'), step(1, 'Copy'), step(1, 'Fill'), step(2, 'Send'), step(2, 'Set')] }]);
    expect(e!.steps.map((s) => [s.ts, s.actionId])).toEqual([[1200, 'a1'], [1500, 'a2'], [1600, 'first1'], [2000, 'first2'], [2450, 'first2']]);
  });
  test('only value-like variables stay', () => {
    expect(['order_id', 'refund_amount', 'customer_email', 'callback_slot', 'budget_forecast', 'forecast_update', 'chat_message', 'match_status'].filter(isValueVariable)).toEqual(['order_id', 'refund_amount', 'customer_email', 'callback_slot']);
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
    // The abandoned run counts in the stats, never as a path.
    expect(w.paths.map((p) => [p.key, p.runs.length])).toEqual([['A', 8], ['B', 3]]);
    expect(w.stats.runsTotal).toBe(12);
    expect(w.variants[1]!.differs).toEqual([3, 4]);
    expect(w.steps[1]!.decision).toMatchObject({ variant: 'B' });
    expect(w.stats.people).toBe(2);
    expect(w.stats.p50).toBe(600);
    expect(w.stats.determinism).toBe(1);
    expect(w.stats.successRate).toBeCloseTo(11 / 12);
    // The first run is 21 days old: 12 runs in 3 weeks = 4/week × 10 min × determinism 1.
    expect(w.stats.hoursPerWeek).toBeCloseTo(4 / 6);
  });

  test('an abandoned run joins the workflow whose canonical path holds its steps in order', () => {
    const now = Date.UTC(2026, 8, 29);
    const run = (i: number, path: string[], label: string, status = 'succeeded') => ({
      episodeId: `e${i}`, userId: 'u1', start: new Date(now - i * 3_600_000), end: new Date(now - i * 3_600_000 + 60_000), label, goal: null, outcome: null, outcomeStatus: status, workflowId: null,
      signature: path.join(' '), steps: path.map((t) => ({ verb: t.split('@')[0]!, app: t.split('@')[1]!, object: label, params: null, variables: [] })),
    });
    const refund = describeCluster([1, 2, 3].map((i) => run(i, ['open@helpdesk', 'search@erp', 'create@erp', 'send@mail'], 'Refund a damaged order')), now);
    const escalate = describeCluster([4, 5, 6].map((i) => run(i, ['open@helpdesk', 'search@erp', 'open@browser', 'send@mail'], 'Escalate a late shipment')), now);
    const partial = groupRuns([run(7, ['open@helpdesk', 'search@erp', 'open@browser'], 'Escalate a late shipment', 'abandoned')])[0]!;
    expect(commonSubsequence(['a', 'b', 'c'], ['a', 'x', 'c'])).toBe(2);
    expect(startedWorkflow(partial, [{ group: workflowGroup(refund) }, { group: workflowGroup(escalate) }])).toBe(1);
    const stray = groupRuns([run(8, ['read@chat', 'send@chat'], 'Chat', 'abandoned')])[0]!;
    expect(startedWorkflow(stray, [{ group: workflowGroup(refund) }])).toBe(-1);
  });
});

describe('skill draft', () => {
  test('reads the persisted workflow: clean sentences, conditions on decisions, every variant named, no literals', async () => {
    const { draftSkill } = await import('./skills');
    const w = {
      workflowId: 'w1', name: 'Refund a damaged-order claim', goal: 'Refund a damaged item.', outcome: 'The customer has the refund.', apps: ['Helpdesk', 'ERP', 'Mail'], runsTotal: 140, updatedAt: new Date('2026-10-05T17:50:47Z'),
      steps: [
        { index: 1, verb: 'Open', object: 'damaged-in-transit ticket', app: 'Helpdesk', params: null, variables: ['ticket_id'] },
        { index: 2, verb: 'Search', object: 'order by number', app: 'ERP', params: 'Orders.', variables: ['order_id'], decision: { question: 'the case calls for variant B', variant: 'B', share: 0.2 } },
        { index: 3, verb: 'Create', object: 'refund with reason Damaged', app: 'ERP', params: null, variables: ['refund_amount'] },
      ],
      variants: [
        { key: 'A', name: 'Canonical path', runs: 100, share: 0.75, steps_count: 3, differs: [], note: 'The most common path.' },
        { key: 'B', name: 'Outside the return window', runs: 27, share: 0.2, steps_count: 3, differs: [3], note: 'Sends a denial instead of a refund.', question: 'the order is older than 30 days.' },
      ],
    } as never;
    const draft = draftSkill(w);
    expect(draft.markdown).toContain('description: "Refund a damaged item. Use when asked to refund a damaged-order claim."');
    expect(draft.markdown).toContain('2. Search order by number ({order_id}) in ERP › Orders.\n   If the order is older than 30 days, follow variant B (Outside the return window) below.');
    expect(draft.markdown).toContain('- **B · Outside the return window** (20% of runs), when the order is older than 30 days: Sends a denial instead of a refund.');
    expect(draft.markdown).toContain('Learned from 140 recorded runs');
    expect(draft.markdown).not.toMatch(/\.\.(?!\.)/);
    expect(draft.workflow_updated_at).toBe('2026-10-05T17:50:47.000Z');
    expect(draft.checks.every((c) => c.ok)).toBe(true);
  });
});

describe('variant folding', () => {
  test('paths that differ only in steps that change nothing are one path', async () => {
    const { changesSomething } = await import('./mining');
    expect(changesSomething(['open@helpdesk', 'search@erp', 'send@mail'], ['open@helpdesk', 'copy@helpdesk', 'search@erp', 'read@erp', 'send@mail'])).toBe(false);
    expect(changesSomething(['open@helpdesk', 'create@erp', 'send@mail'], ['open@helpdesk', 'send@mail', 'set@helpdesk'])).toBe(true);
  });
});

describe('variants', () => {
  test('two paths that add and skip the same changing steps are one variant; A is named by what it does', () => {
    const now = Date.UTC(2026, 8, 29);
    const run = (i: number, path: string[]) => ({
      episodeId: `v${i}`, userId: 'u1', start: new Date(now - (i + 1) * 3_600_000), end: new Date(now - (i + 1) * 3_600_000 + 600_000), label: 'Refund', goal: null, outcome: null, outcomeStatus: 'succeeded', workflowId: null,
      signature: path.map((p) => `${p.toLowerCase()}@erp`).join(' '), steps: path.map((verb) => ({ verb, app: 'ERP', object: verb === 'Create' ? 'refund' : verb === 'Reject' ? 'claim' : 'order', params: null, variables: [] })),
    });
    const runs = [
      ...Array.from({ length: 8 }, (_, i) => run(i, ['Open', 'Search', 'Create', 'Send'])),
      ...Array.from({ length: 3 }, (_, i) => run(10 + i, ['Open', 'Search', 'Reject'])),
      ...Array.from({ length: 2 }, (_, i) => run(20 + i, ['Open', 'Copy', 'Read', 'Search', 'Reject'])),
    ];
    const w = describeCluster(runs, now);
    expect(w.paths.map((p) => [p.key, p.runs.length])).toEqual([['A', 8], ['B', 5]]);
    expect(w.variants[0]!.name).toBe('Standard: create refund');
    expect(w.variants[0]!.note).toContain('62% of runs');
    expect(w.variants[1]!.name).toBe('Reject claim');
  });
});



describe('naming', () => {
  test('the workflow is named from its standard path: the prompt samples only path A, even when the latest runs are a variant', async () => {
    const { namePrompt } = await import('./mining');
    const now = Date.UTC(2026, 8, 29);
    const run = (i: number, path: string[], label: string) => ({
      episodeId: `n${i}`, userId: 'u1', start: new Date(now - (30 - i) * 3_600_000), end: new Date(now - (30 - i) * 3_600_000 + 600_000), label, goal: `${label}.`, outcome: null, outcomeStatus: 'succeeded', workflowId: null,
      signature: path.map((p) => `${p.toLowerCase()}@erp`).join(' '), steps: path.map((verb) => ({ verb, app: 'ERP', object: verb.toLowerCase(), params: null, variables: [] })),
    });
    // 7 standard runs first, then 3 variant runs: the 6 latest runs are mostly the variant.
    const runs = [
      ...Array.from({ length: 7 }, (_, i) => run(i, ['Open', 'Search', 'Update', 'Send'], 'Update the order address')),
      ...Array.from({ length: 3 }, (_, i) => run(10 + i, ['Open', 'Search', 'Submit', 'Send'], 'Redirect the parcel with the carrier')),
    ];
    const prompt = namePrompt(describeCluster(runs, now));
    const samples = prompt.split('Sample runs of path A')[1]!.split('Paths (A')[0]!;
    expect(samples).toContain('Update the order address');
    expect(samples).not.toContain('Redirect the parcel');
    expect(prompt).toContain('describe path A, the standard path, never a variant');
  });
});
