/**
 * L1 episodes + L2 step traces, one job per closed detected range
 * (`capture.episodes`). Episodes replace the per-range model pipelines for
 * detected ranges; a saved range keeps them and also becomes a pinned episode.
 *
 *   1. the range's frames and actions become moments: one per stretch of the
 *      same app and window, with what was on screen and what the person did
 *   2. moments are chunked (at most MAX_MOMENTS, cut at the longest idle gap)
 *   3. one model call per chunk splits it into tasks and traces each task:
 *      label, goal, outcome, and normalized steps {verb, app, object, params,
 *      variables}, literal values lifted into variable names
 *   4. the range's previous detected episodes are replaced in one transaction
 *
 * Only masked text reaches the model (`maskText`). Each call checks the
 * account's daily budget; spend lands in capture_ai_usage and on each episode.
 *
 * ponytail: L1 and L2 share one call per chunk (half the tokens of two passes).
 * Split them when steps need more context than the chunk carries.
 */
import { captureEpisodes, captureEpisodeSteps, timelineActions, timelineFrames, timelineRanges } from '@kortix/db';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../shared/db';
import { CaptureBudgetExceeded, recordSpend, withinBudget } from './budget';
import { accountPrefix } from './format';
import { withCaptureGateway } from './gateway';
import { emptyUsage, gatewayCaller, imageMime, type Caller, type RangeInput } from './processing';
import { captureStore } from './store';

/** A new moment after this much silence, even in the same window. */
export const MOMENT_GAP_MS = 60_000;
export const MAX_MOMENTS = 80;
const MAX_KEYFRAMES = 4;

export const VERBS = [
  'Open', 'Read', 'Search', 'Select', 'Copy', 'Paste', 'Fill', 'Create', 'Update', 'Set', 'Send',
  'Approve', 'Reject', 'Match', 'Export', 'Import', 'Upload', 'Download', 'Attach', 'Delete', 'Schedule', 'Submit',
] as const;

// ─── Masking ─────────────────────────────────────────────────────────────────

const MASKS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  [/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g, '<iban>'],
  [/(?<![\w-])\+?\d[\d ()-]{7,}\d(?!\w)/g, '<phone>'],
  [/\d{9,}/g, '<number>'],
];

/** Personal data out before text reaches a model: emails, IBANs, phone numbers, long digit runs. */
export function maskText(text: string): string {
  let out = text;
  for (const [re, token] of MASKS) out = out.replace(re, token);
  return out;
}

/**
 * Literal values out of what the model wrote: any word with a run of 3+ digits
 * (`SO-905232`, `#41234`, `EXP-968`) and any mask token. Labels, goals and
 * outcomes describe the kind of task, never one instance of it.
 */
export function scrubLiterals(text: string): string {
  return text
    .replace(/#?[\p{L}\d_/-]*\d{3,}(?:[.,]\d+)?[\p{L}\d_/-]*/gu, '')
    .replace(/<(?:email|iban|phone|number)>/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[\s,;:-]+$/, '');
}

// ─── Moments ─────────────────────────────────────────────────────────────────

export interface FrameRow { frameId: string; ts: Date; app: string | null; title: string | null; url: string | null; text: string | null }
export interface ActionRow { actionId: string; ts: Date; kind: string; app: string | null; window: string | null; description: string | null; target: Record<string, unknown> | null; screenshot: string | null }

export interface Moment {
  n: number;
  start: number;
  end: number;
  app: string;
  title: string;
  url: string | null;
  text: string;
  did: string[];
  frameId: string | null;
  actionId: string | null;
  /** Input actions in this moment (not screenshots), in order: steps at this moment take their time from them. */
  inputs: Array<{ actionId: string; ts: number }>;
  screenshot: string | null;
}

function did(a: ActionRow): string | null {
  const target = typeof a.target?.name === 'string' ? a.target.name : null;
  if (a.kind === 'click' || a.kind === 'double_click') return target ? `click "${target}"` : 'click';
  if (a.kind === 'screenshot') return null;
  return a.description;
}

/** Consecutive frames and actions in the same app and window form one moment; silence of MOMENT_GAP_MS splits. */
export function buildMoments(frames: FrameRow[], actions: ActionRow[]): Moment[] {
  const events = [
    ...frames.map((f) => ({ ts: f.ts.getTime(), app: f.app ?? '', title: f.title ?? '', url: f.url, text: f.text ?? '', frame: f, action: null as ActionRow | null })),
    ...actions.map((a) => ({ ts: a.ts.getTime(), app: a.app ?? '', title: a.window ?? '', url: null, text: '', frame: null as FrameRow | null, action: a })),
  ].sort((x, y) => x.ts - y.ts);
  const moments: Moment[] = [];
  for (const e of events) {
    let m = moments[moments.length - 1];
    if (!m || m.app !== e.app || (e.title && m.title !== e.title) || e.ts - m.end > MOMENT_GAP_MS) {
      m = { n: moments.length + 1, start: e.ts, end: e.ts, app: e.app, title: e.title, url: e.url, text: '', did: [], frameId: null, actionId: null, inputs: [], screenshot: null };
      moments.push(m);
    }
    m.end = e.ts;
    if (e.frame) {
      m.frameId ??= e.frame.frameId;
      if (!m.text && e.text) m.text = e.text.replace(/\s+/g, ' ').trim().slice(0, 200);
      m.url ??= e.url;
    }
    if (e.action) {
      m.actionId ??= e.action.actionId;
      if (e.action.screenshot) m.screenshot ??= e.action.screenshot;
      if (e.action.kind !== 'screenshot') m.inputs.push({ actionId: e.action.actionId, ts: e.ts });
      const line = did(e.action);
      if (line && m.did.length < 6) m.did.push(line.slice(0, 120));
    }
  }
  return moments;
}

/** Chunks of at most `max` moments, each cut at the longest idle gap of its last third. */
export function chunkMoments(moments: Moment[], max = MAX_MOMENTS): Moment[][] {
  const chunks: Moment[][] = [];
  let rest = moments;
  while (rest.length > max) {
    let cut = max;
    let widest = -1;
    for (let i = Math.floor(max * 0.66); i < max; i++) {
      const gap = rest[i]!.start - rest[i - 1]!.end;
      if (gap > widest) [widest, cut] = [gap, i];
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);

export function momentLines(chunk: Moment[], shots: Map<string, number>): string {
  const lines: string[] = [];
  for (const [i, m] of chunk.entries()) {
    const gap = i ? m.start - chunk[i - 1]!.end : 0;
    if (gap >= MOMENT_GAP_MS) lines.push(`   (idle ${Math.round(gap / 60_000)} min)`);
    const seconds = Math.max(1, Math.round((m.end - m.start) / 1000));
    const shot = m.screenshot && shots.has(m.screenshot) ? ` [shot ${shots.get(m.screenshot)}]` : '';
    const where = [m.app || 'unknown app', m.title, m.url].filter(Boolean).map((s) => maskText(s!)).join(' — ');
    const parts = [`m${m.n} ${hhmmss(m.start)} ${seconds}s ${where}`, m.text && `screen: "${maskText(m.text)}"`, m.did.length && `did: ${m.did.map(maskText).join('; ')}`];
    lines.push(parts.filter(Boolean).join(' | ') + shot);
  }
  return lines.join('\n');
}

// ─── The model call ──────────────────────────────────────────────────────────

const optStr = z.string().nullish().transform((v) => v ?? null);
const stepZod = z.object({
  moment: z.coerce.number(),
  verb: z.string(),
  app: optStr,
  object: z.string(),
  params: optStr,
  variables: z.array(z.string()).nullish().transform((v) => v ?? []),
});
const episodesZod = z.object({
  episodes: z.array(
    z.object({
      first: z.coerce.number(),
      last: z.coerce.number(),
      label: z.string(),
      goal: optStr,
      outcome: optStr,
      outcome_status: z.string().nullish().transform((v) => (v === 'succeeded' || v === 'failed' || v === 'abandoned' ? v : null)),
      procedural: z.boolean().nullish().transform((v) => v ?? true),
      steps: z.array(stepZod).nullish().transform((v) => v ?? []),
    }),
  ),
});
export type ModelEpisode = z.output<typeof episodesZod>['episodes'][number];

export function episodesPrompt(lines: string, shotCount: number): string {
  return `You read one person's computer activity and split it into tasks, then trace each task as steps.

Each line is a moment: "m<n> <time> <duration> <app> — <window> | screen: <text on screen> | did: <input actions>". "(idle N min)" marks no activity. ${shotCount ? `[shot N] refers to attached screenshot N.` : ''}
Text like <email>, <phone>, <number> was masked for privacy.

Rules:
- A task is one goal pursued to an end: a moment range "first".."last". Cover every moment with exactly one task; tasks do not overlap.
- A short unrelated detour inside a task (a chat reply, a glance at mail) stays inside that task: it is not a step.
- Idle gaps and switches to unrelated work usually start a new task. Switching apps for the same goal does not.
- "procedural": true when the task is a goal-directed procedure someone could hand to an assistant (processing a ticket, an invoice, an order); false for reading news, chatting, browsing, inbox triage.
- Steps: one per meaningful action, in order, at the moment it happens. "verb" is one of: ${VERBS.join(', ')}. "app" is the app. "object" is what the verb acts on, in a few generic words (e.g. "refund with reason Damaged", "order by number"), no literal values. "params" (optional): where or how, e.g. "Orders › Search". "variables": snake_case names of the values that change from run to run and that the step reads or writes: ids, numbers, emails, amounts, dates, names (e.g. ["order_id", "refund_amount"]); never a document or object ("budget_forecast" is not a variable), never the values themselves.
- "label": 3-7 words, imperative, generic (e.g. "Refund a damaged order"). "goal": one sentence. "outcome": one sentence on what was achieved. Never put literal values (ids, numbers, names, addresses) in label, goal, outcome, object or params: describe the kind of task, not this instance.
- "outcome_status": succeeded, failed, abandoned (the task stopped before its end: no final send, save or status change), or unknown.

Activity:
${lines}

Return ONLY JSON: {"episodes":[{"first":1,"last":9,"label":"…","goal":"…","outcome":"…","outcome_status":"succeeded","procedural":true,"steps":[{"moment":1,"verb":"Open","app":"…","object":"…","params":null,"variables":["…"]}]}]}`;
}

/** Words that make a variable name a value that changes from run to run (an id, an amount, a person's email). */
const VALUE_WORDS = new Set([
  'id', 'ids', 'number', 'no', 'num', 'email', 'phone', 'amount', 'total', 'price', 'cost', 'fee', 'date', 'time', 'slot', 'slots',
  'week', 'month', 'year', 'address', 'name', 'sku', 'code', 'quantity', 'qty', 'reference', 'ref', 'reason', 'url', 'account',
  'iban', 'count', 'percent', 'rate', 'tracking', 'customer', 'vendor', 'supplier', 'contact', 'zip', 'postcode', 'city',
]);

/** A variable stays when its name says it holds a value (`order_id`, `refund_amount`), not a thing (`budget_forecast`). */
export function isValueVariable(name: string): boolean {
  return name.split('_').some((part) => VALUE_WORDS.has(part));
}

const VERB_SET = new Map(VERBS.map((v) => [v.toLowerCase(), v]));
const VERB_SYNONYMS: Record<string, (typeof VERBS)[number]> = {
  reply: 'Send', review: 'Read', check: 'Read', examine: 'Read', open: 'Open',
  'look up': 'Search', 'fill in': 'Fill', 'fill out': 'Fill', 'sign off': 'Approve', 'write back': 'Send',
  view: 'Open', go: 'Open', navigate: 'Open', launch: 'Open', look: 'Read', inspect: 'Read', verify: 'Read', confirm: 'Read',
  find: 'Search', lookup: 'Search', enter: 'Fill', type: 'Fill', input: 'Fill', edit: 'Update', change: 'Update', modify: 'Update',
  mark: 'Set', tag: 'Set', close: 'Set', resolve: 'Set', email: 'Send', message: 'Send', post: 'Send', write: 'Send',
  issue: 'Create', add: 'Create', new: 'Create', make: 'Create', book: 'Schedule', save: 'Update', compare: 'Match', reconcile: 'Match',
};

/** One of VERBS for any verb the model wrote. */
export function normalizeVerb(raw: string): string {
  const [word = '', next = ''] = raw.trim().toLowerCase().split(/\s+/);
  return VERB_SYNONYMS[`${word} ${next}`] ?? VERB_SYNONYMS[word] ?? VERB_SET.get(word) ?? (word ? word[0]!.toUpperCase() + word.slice(1) : 'Do');
}

export function signatureOf(steps: Array<{ verb: string; app: string | null }>): string {
  return steps.map((s) => `${s.verb.toLowerCase()}@${(s.app ?? '').toLowerCase().replace(/\s+/g, '_')}`).join(' ');
}

// ─── The job ─────────────────────────────────────────────────────────────────

async function keyframes(accountId: string, deviceId: string, chunk: Moment[]): Promise<{ images: RangeInput['images']; shots: Map<string, number> }> {
  const names = [...new Set(chunk.map((m) => m.screenshot).filter((s): s is string => !!s))];
  const picked = names.filter((_, i) => names.length <= MAX_KEYFRAMES || i % Math.ceil(names.length / MAX_KEYFRAMES) === 0).slice(0, MAX_KEYFRAMES);
  const images: RangeInput['images'] = [];
  const shots = new Map<string, number>();
  for (const name of picked) {
    const bytes = await captureStore.getBytes(`${accountPrefix(accountId)}/${deviceId}/assets/${name}`).catch(() => null);
    const mime = bytes ? imageMime(bytes) : null;
    if (!bytes || !mime || bytes.byteLength > 2 * 1024 * 1024) continue;
    shots.set(name, images.length + 1);
    images.push({ index: images.length + 1, tSec: 0, context: name, dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` });
  }
  return { images, shots };
}

/** Episodes of one chunk, clamped to its moments; a task with no steps keeps its span and label. */
export function placeEpisodes(chunk: Moment[], raw: ModelEpisode[]) {
  const byN = new Map(chunk.map((m) => [m.n, m]));
  const lo = chunk[0]!.n;
  const hi = chunk[chunk.length - 1]!.n;
  const clamp = (n: number) => Math.min(hi, Math.max(lo, Math.round(n)));
  return raw
    .map((e) => {
      const first = clamp(Math.min(e.first, e.last));
      const last = clamp(Math.max(e.first, e.last));
      const steps = e.steps
        .map((s) => ({ ...s, moment: clamp(s.moment), verb: normalizeVerb(s.verb), object: scrubLiterals(s.object).slice(0, 200), params: s.params ? scrubLiterals(s.params) || null : null, variables: [...new Set(s.variables.map((v) => v.toLowerCase().replace(/[^a-z0-9_]/g, '_')).filter(isValueVariable))] }))
        .filter((s) => s.moment >= first && s.moment <= last && s.object)
        .sort((a, b) => a.moment - b.moment);
      // Each step gets its own time: the k-th step at a moment takes the moment's k-th input action, else
      // an even share of the moment; times strictly increase, so a player can follow the steps.
      let prev = -Infinity;
      const used = new Map<number, number>();
      const timed = steps.map((s) => {
        const at = byN.get(s.moment)!;
        const k = used.get(s.moment) ?? 0;
        used.set(s.moment, k + 1);
        const sharing = steps.filter((x) => x.moment === s.moment).length;
        const input = sharing > 1 ? at.inputs[k] : undefined;
        const ts = Math.max(input?.ts ?? (sharing > 1 ? at.start + Math.round(((at.end - at.start) * k) / sharing) : at.start), prev + 1);
        prev = ts;
        return { ...s, at, ts, actionId: input?.actionId ?? at.actionId };
      });
      return { ...e, first, last, start: byN.get(first)!.start, end: Math.max(byN.get(last)!.end, prev), steps: timed };
    })
    .sort((a, b) => a.first - b.first);
}

export const EPISODES_QUEUE = 'capture.episodes';

/** Trace a closed detected range into episodes. Idempotent: a re-run replaces the range's detected episodes. */
export async function traceRange(rangeId: string, caller?: Caller): Promise<{ episodes: number; costUsd: number }> {
  const [range] = await db.select().from(timelineRanges).where(eq(timelineRanges.rangeId, rangeId)).limit(1);
  if (!range || !range.deviceId) return { episodes: 0, costUsd: 0 };
  if (!caller) {
    return withCaptureGateway({ accountId: range.accountId, userId: range.userId }, (gateway) =>
      traceRange(rangeId, gatewayCaller(gateway.authorization, config.KORTIX_CAPTURE_MODEL, gateway.url)),
    );
  }
  await db.update(timelineRanges).set({ status: 'processing', updatedAt: sql`now()` }).where(eq(timelineRanges.rangeId, rangeId));
  const span = (col: typeof timelineFrames.ts | typeof timelineActions.ts) => [gte(col, range.startAt), lte(col, range.endAt)];
  const frames = await db
    .select({ frameId: timelineFrames.frameId, ts: timelineFrames.ts, app: timelineFrames.app, title: timelineFrames.title, url: timelineFrames.url, text: timelineFrames.ocrText })
    .from(timelineFrames)
    .where(and(eq(timelineFrames.accountId, range.accountId), eq(timelineFrames.deviceId, range.deviceId), ...span(timelineFrames.ts)))
    .orderBy(asc(timelineFrames.ts))
    .limit(100_000);
  const actions = await db
    .select({ actionId: timelineActions.actionId, ts: timelineActions.ts, kind: timelineActions.kind, app: timelineActions.app, window: timelineActions.windowTitle, description: timelineActions.description, target: timelineActions.target, screenshot: timelineActions.screenshot })
    .from(timelineActions)
    .where(and(eq(timelineActions.accountId, range.accountId), eq(timelineActions.deviceId, range.deviceId), ...span(timelineActions.ts)))
    .orderBy(asc(timelineActions.ts))
    .limit(100_000);
  const moments = buildMoments(frames, actions);
  const rows: Array<{ episode: typeof captureEpisodes.$inferInsert; steps: Omit<typeof captureEpisodeSteps.$inferInsert, 'episodeId'>[] }> = [];
  let costUsd = 0;
  for (const chunk of chunkMoments(moments)) {
    if (!(await withinBudget(range.accountId))) throw new CaptureBudgetExceeded();
    const { images, shots } = await keyframes(range.accountId, range.deviceId, chunk);
    const usage = emptyUsage();
    let parsed: ModelEpisode[];
    try {
      parsed = (await caller.call(episodesZod, episodesPrompt(momentLines(chunk, shots), images.length), images, usage)).episodes;
    } finally {
      await recordSpend(range.accountId, usage.cost_usd, usage.requests);
      costUsd += usage.cost_usd;
    }
    const placed = placeEpisodes(chunk, parsed);
    const share = usage.cost_usd / Math.max(1, placed.length);
    for (const e of placed) {
      const steps = e.steps.map((s, index) => ({
        accountId: range.accountId,
        index,
        ts: new Date(s.ts),
        verb: s.verb,
        app: s.app ?? s.at.app ?? null,
        object: s.object,
        params: s.params,
        variables: s.variables,
        keyframeFrameId: s.at.frameId,
        actionId: s.actionId,
      }));
      rows.push({
        episode: {
          accountId: range.accountId,
          userId: range.userId,
          deviceId: range.deviceId,
          source: 'detected',
          startAt: new Date(e.start),
          endAt: new Date(Math.max(e.end, e.start + 1000)),
          label: (scrubLiterals(e.label) || 'Task').slice(0, 200),
          goal: e.goal ? scrubLiterals(e.goal) : null,
          outcome: e.outcome ? scrubLiterals(e.outcome) : null,
          outcomeStatus: e.outcome_status,
          apps: [...new Set(steps.map((s) => s.app).filter((a): a is string => !!a))],
          // A non-procedural task is closed, not traced: mining reads traced episodes only.
          status: e.procedural && steps.length ? 'traced' : 'closed',
          stepsCount: steps.length,
          signature: steps.length ? signatureOf(steps) : null,
          model: caller.model,
          costUsd: share.toFixed(6),
        },
        steps,
      });
    }
  }
  await db.transaction(async (tx) => {
    await tx
      .delete(captureEpisodes)
      .where(
        and(
          eq(captureEpisodes.deviceId, range.deviceId!),
          eq(captureEpisodes.source, 'detected'),
          gte(captureEpisodes.startAt, range.startAt),
          lte(captureEpisodes.startAt, range.endAt),
        ),
      );
    for (const row of rows) {
      const [inserted] = await tx.insert(captureEpisodes).values(row.episode).returning({ episodeId: captureEpisodes.episodeId });
      if (row.steps.length) await tx.insert(captureEpisodeSteps).values(row.steps.map((s) => ({ ...s, episodeId: inserted!.episodeId })));
    }
    // A range that grew meanwhile is `open` again: leave it for its next run.
    await tx
      .update(timelineRanges)
      .set({ status: 'processed', updatedAt: sql`now()` })
      .where(and(eq(timelineRanges.rangeId, rangeId), eq(timelineRanges.status, 'processing')));
  });
  return { episodes: rows.length, costUsd };
}
