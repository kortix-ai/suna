/**
 * Range processing: the kortix-ai/capture `apps/web/src/lib/ai/` pipelines,
 * ported onto Kortix's own LLM gateway (managed open-weight vision model,
 * billed to the project's account through a short-lived project gateway key).
 *
 *   segmentation  work / communication / personal / entertainment / idle / other
 *                 blocks; idle windows (no input for >= 120 s) override the model
 *   transcript    step-by-step narrative per active block, then a title + summary
 *   annotation    structured workflow annotation (pass 1), critique and
 *                 enrichment (pass 2), structured extraction (pass 3), merged
 *
 * Input differs from the old pipelines on purpose: the schema-2 timeline is
 * richer than the old action stream. Each timeline line is a screen change
 * (app, window, URL and on-screen text), an action, or an audio line; the
 * images are the action screenshots (assets) of the range, at most 12 (the
 * gateway's inline-image keep count). Embeddings are not ported: the gateway
 * serves no embedding model. Outputs are searchable through their text.
 */
import {
  captureDevices,
  rangeOutputs,
  timelineActions,
  timelineAudio,
  timelineFrames,
  timelineRanges,
} from '@kortix/db';
import { getManagedModel } from '@kortix/llm-catalog';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../lib/logger';
import { projectLlmGatewayEnabledById } from '../llm-gateway/enablement';
import { createGatewayKey, deleteGatewayKey } from '../llm-gateway/gateway-keys';
import { standaloneGatewayUrl } from '../projects/session-title-generate';
import { db } from '../shared/db';
import { projectPrefix } from './format';
import { captureStore } from './store';

const MAX_EVENTS = 2400;
const MAX_IMAGES = 12;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IDLE_GAP_SEC = 120;
const GAP_EPSILON_SEC = 2;
const MAX_TRANSCRIPT_WINDOWS = 12;
const CALL_TIMEOUT_MS = 300_000;
const KEY_NAME = 'internal-capture-processing';

// ─── Input ───────────────────────────────────────────────────────────────────

export interface RangeInput {
  totalSeconds: number;
  /** "<clock>  <description> [shot:N]" lines, chronological. */
  lines: Array<{ tSec: number; text: string }>;
  images: Array<{ index: number; tSec: number; context: string; dataUrl: string }>;
  /** Seconds at which the person gave input (actions, active screen changes). */
  inputTimesSec: number[];
  apps: string[];
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

export function parseClock(value: string | undefined): number | null {
  if (!value) return null;
  const parts = value.trim().split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** Evenly sample at most `max` items, keeping the first and the last. */
export function sampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const picked = new Set<number>();
  for (let i = 0; i < max; i++) picked.add(Math.round((i * (items.length - 1)) / (max - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => items[i]!);
}

async function loadInput(range: typeof timelineRanges.$inferSelect): Promise<RangeInput> {
  const start = range.startAt.getTime();
  const owner = and(
    eq(timelineFrames.projectId, range.projectId),
    eq(timelineFrames.userId, range.userId),
    ...(range.deviceId ? [eq(timelineFrames.deviceId, range.deviceId)] : []),
    gte(timelineFrames.ts, range.startAt),
    lte(timelineFrames.ts, range.endAt),
  );
  const frames = await db
    .select({ ts: timelineFrames.ts, app: timelineFrames.app, title: timelineFrames.title, url: timelineFrames.url, text: timelineFrames.ocrText, inactive: timelineFrames.inactive })
    .from(timelineFrames)
    .where(owner)
    .orderBy(asc(timelineFrames.ts))
    .limit(50_000);
  const actions = await db
    .select({ ts: timelineActions.ts, deviceId: timelineActions.deviceId, description: timelineActions.description, kind: timelineActions.kind, app: timelineActions.app, window: timelineActions.windowTitle, screenshot: timelineActions.screenshot })
    .from(timelineActions)
    .where(
      and(
        eq(timelineActions.projectId, range.projectId),
        eq(timelineActions.userId, range.userId),
        ...(range.deviceId ? [eq(timelineActions.deviceId, range.deviceId)] : []),
        gte(timelineActions.ts, range.startAt),
        lte(timelineActions.ts, range.endAt),
      ),
    )
    .orderBy(asc(timelineActions.ts))
    .limit(50_000);
  const audio = await db
    .select({ ts: timelineAudio.ts, text: timelineAudio.text })
    .from(timelineAudio)
    .where(
      and(
        eq(timelineAudio.projectId, range.projectId),
        eq(timelineAudio.userId, range.userId),
        ...(range.deviceId ? [eq(timelineAudio.deviceId, range.deviceId)] : []),
        gte(timelineAudio.ts, range.startAt),
        lte(timelineAudio.ts, range.endAt),
      ),
    )
    .orderBy(asc(timelineAudio.ts))
    .limit(10_000);

  const rel = (d: Date) => (d.getTime() - start) / 1000;
  const lines: RangeInput['lines'] = [];
  // A screen line only when what is on screen changed (app, window or URL).
  let last = '';
  for (const f of frames) {
    const where = [f.app, f.title, f.url].filter(Boolean).join(' — ');
    if (where === last) continue;
    last = where;
    const text = (f.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    lines.push({ tSec: rel(f.ts), text: `Screen: ${where || 'unknown window'}${text ? ` | text: "${text}"` : ''}` });
  }
  // Images: distinct action screenshots, evenly sampled.
  const shots = sampleEvenly(
    actions.filter((a, i, all) => a.screenshot && all.findIndex((b) => b.screenshot === a.screenshot) === i),
    MAX_IMAGES,
  );
  const shotIndex = new Map<string, number>();
  const images: RangeInput['images'] = [];
  for (const action of shots) {
    const [device] = await db
      .select({ accountId: captureDevices.accountId })
      .from(captureDevices)
      .where(eq(captureDevices.deviceId, action.deviceId))
      .limit(1);
    if (!device) continue;
    const key = `${projectPrefix(device.accountId, range.projectId)}/${action.deviceId}/assets/${action.screenshot}`;
    const bytes = await captureStore.getBytes(key).catch(() => null);
    if (!bytes || bytes.byteLength > MAX_IMAGE_BYTES) continue;
    const mime = action.screenshot!.endsWith('.png') ? 'image/png' : action.screenshot!.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    const index = images.length + 1;
    shotIndex.set(action.screenshot!, index);
    images.push({
      index,
      tSec: rel(action.ts),
      context: action.description ?? action.kind,
      dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
    });
  }
  for (const a of actions) {
    const where = [a.app, a.window].filter(Boolean).join(' — ');
    const shot = a.screenshot ? shotIndex.get(a.screenshot) : undefined;
    lines.push({ tSec: rel(a.ts), text: `${a.description ?? a.kind}${where ? ` in ${where}` : ''}${shot ? ` [shot:${shot}]` : ''}` });
  }
  for (const line of audio) lines.push({ tSec: rel(line.ts), text: `Heard: "${line.text.slice(0, 200)}"` });
  lines.sort((a, b) => a.tSec - b.tSec);

  return {
    totalSeconds: Math.max(1, (range.endAt.getTime() - start) / 1000),
    lines: sampleEvenly(lines, MAX_EVENTS),
    images,
    inputTimesSec: [...actions.map((a) => rel(a.ts)), ...frames.filter((f) => !f.inactive).map((f) => rel(f.ts))].sort((a, b) => a - b),
    apps: [...new Set(frames.map((f) => f.app).filter((a): a is string => !!a))],
  };
}

const timelineText = (input: RangeInput) =>
  input.lines.map((l) => `${clock(l.tSec)}  ${l.text}`).join('\n') || 'No timeline events were captured.';
const shotIndexText = (input: RangeInput) =>
  input.images.map((s) => `  shot ${s.index} @ ${clock(s.tSec)} — ${s.context}`).join('\n') || '  (no screenshots)';

const LINE_TYPES =
  'Lines starting "Screen:" are what was on screen (app — window title — URL, then OCR text); "Heard:" lines are the audio transcript; every other line is an input action.';

// ─── Model calls ─────────────────────────────────────────────────────────────

export interface Usage {
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  duration_ms?: number;
}

const emptyUsage = (): Usage => ({ requests: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 });

interface Caller {
  model: string;
  call<S extends z.ZodTypeAny>(schema: S, prompt: string, images: RangeInput['images'], usage: Usage): Promise<z.output<S>>;
}

/** Strip a code fence and parse the first JSON object in a model reply. */
export function parseModelJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? body.slice(start, end + 1) : body);
}

function costOf(model: string, prompt: number, completion: number, reported: unknown): number {
  if (typeof reported === 'number' && Number.isFinite(reported)) return reported;
  const pricing = getManagedModel(model)?.pricing;
  if (!pricing) return 0;
  return (prompt * pricing.inputPerMillion + completion * pricing.outputPerMillion) / 1e6;
}

function gatewayCaller(authorization: string, model: string): Caller {
  const url = standaloneGatewayUrl();
  if (!url) throw new Error('the standalone LLM gateway is not configured');
  return {
    model,
    async call(schema, prompt, images, usage) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        const content = [
          { type: 'text', text: attempt ? `${prompt}\n\nYour previous reply was not valid JSON for the schema. Return ONLY the JSON object.` : prompt },
          ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
        ];
        const res = await fetch(url, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          // Low reasoning effort: these are extraction tasks, and a reasoning model at the
          // default effort spent 12k+ hidden tokens and over 300 s on one annotation pass.
          body: JSON.stringify({ model, stream: false, temperature: 0.2, max_tokens: 16_000, reasoning_effort: 'low', messages: [{ role: 'user', content }] }),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        const data = (await res.json().catch(() => null)) as any;
        if (!res.ok) throw new Error(`gateway ${res.status}: ${JSON.stringify(data?.error ?? data).slice(0, 300)}`);
        const prompt_tokens = Number(data?.usage?.prompt_tokens ?? 0);
        const completion_tokens = Number(data?.usage?.completion_tokens ?? 0);
        usage.requests += 1;
        usage.prompt_tokens += prompt_tokens;
        usage.completion_tokens += completion_tokens;
        usage.cost_usd += costOf(model, prompt_tokens, completion_tokens, data?.usage?.cost);
        try {
          return schema.parse(parseModelJson(String(data?.choices?.[0]?.message?.content ?? '')));
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error(`model reply did not match the schema: ${String(lastError).slice(0, 300)}`);
    },
  };
}

// ─── Segmentation ────────────────────────────────────────────────────────────

// Models drift from a schema in small ways (a number as a string, null for an
// absent field). Accept those; reject only what is structurally wrong.
const num = z.coerce.number();
const refs = z.array(z.coerce.number()).nullish().transform((v) => v ?? []);
const optStr = z.string().nullish().transform((v) => v ?? undefined);
const strs = z.array(z.string()).nullish().transform((v) => v ?? []);

export const CATEGORIES = ['work', 'communication', 'personal', 'entertainment', 'idle', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

const segmentationZod = z.object({
  segments: z.array(
    z.object({
      tStart: z.string(),
      tEnd: z.string(),
      category: z.string(),
      title: z.string(),
      annotation: z.string(),
      app: optStr,
      confidence: num.optional(),
      screenshotRefs: refs,
    }),
  ),
});

export interface Segment {
  startSec: number;
  endSec: number;
  category: Category;
  title: string;
  annotation: string;
  app?: string;
  confidence: number;
  screenshotRefs: number[];
}

const SYNONYMS: Record<string, Category> = {
  coding: 'work', development: 'work', research: 'work', design: 'work', writing: 'work', productivity: 'work',
  meeting: 'communication', email: 'communication', chat: 'communication', call: 'communication', messaging: 'communication',
  shopping: 'personal', banking: 'personal', finance: 'personal', admin: 'personal',
  video: 'entertainment', music: 'entertainment', social: 'entertainment', game: 'entertainment', gaming: 'entertainment', streaming: 'entertainment',
  away: 'idle', inactive: 'idle', break: 'idle', none: 'idle',
};

export function normalizeCategory(raw: string): Category {
  const value = raw.trim().toLowerCase();
  if ((CATEGORIES as readonly string[]).includes(value)) return value as Category;
  if (SYNONYMS[value]) return SYNONYMS[value];
  const hit = [...CATEGORIES, ...Object.keys(SYNONYMS)].find((k) => value.includes(k));
  return hit ? ((CATEGORIES as readonly string[]).includes(hit) ? (hit as Category) : SYNONYMS[hit]!) : 'other';
}

const idleBlock = (startSec: number, endSec: number, title = 'Idle / no activity captured'): Segment => ({
  startSec, endSec, category: 'idle', title, annotation: title, confidence: 0.9, screenshotRefs: [],
});

/** Clamp, order and make contiguous; fill gaps > 2 s with idle; cover [0, total]. */
export function normalizeSegments(raw: z.infer<typeof segmentationZod>['segments'], total: number): Segment[] {
  const parsed = raw
    .map((s) => ({
      startSec: Math.min(Math.max(parseClock(s.tStart) ?? 0, 0), total),
      endSec: Math.min(Math.max(parseClock(s.tEnd) ?? 0, 0), total),
      category: normalizeCategory(s.category),
      title: s.title.trim() || 'Activity',
      annotation: s.annotation.trim(),
      app: s.app?.trim() || undefined,
      confidence: typeof s.confidence === 'number' ? Math.min(Math.max(s.confidence, 0), 1) : 0.6,
      screenshotRefs: s.screenshotRefs,
    }))
    .filter((s) => s.endSec > s.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  const out: Segment[] = [];
  let cursor = 0;
  for (const s of parsed) {
    let startSec = Math.max(s.startSec, cursor);
    if (s.endSec <= startSec) continue;
    if (startSec - cursor > GAP_EPSILON_SEC) out.push(idleBlock(cursor, startSec));
    else startSec = cursor; // close a gap of <= 2 s
    out.push({ ...s, startSec });
    cursor = s.endSec;
  }
  if (total - cursor > GAP_EPSILON_SEC) out.push(idleBlock(cursor, total));
  else if (out.length) out[out.length - 1]!.endSec = total;
  return out.length ? out : [idleBlock(0, total)];
}

/** Gaps of >= 120 s between inputs (including before the first and after the last). */
export function computeIdleWindows(inputTimes: number[], total: number, gap = IDLE_GAP_SEC): Array<[number, number]> {
  const marks = [0, ...[...new Set(inputTimes)].filter((t) => t >= 0 && t <= total).sort((a, b) => a - b), total];
  const windows: Array<[number, number]> = [];
  for (let i = 1; i < marks.length; i++) if (marks[i]! - marks[i - 1]! >= gap) windows.push([marks[i - 1]!, marks[i]!]);
  return windows;
}

/** Split at segment and idle-window boundaries; idle windows win; merge equal neighbours. */
export function applyIdleWindows(segments: Segment[], windows: Array<[number, number]>, total: number): Segment[] {
  const cuts = [...new Set([0, total, ...segments.flatMap((s) => [s.startSec, s.endSec]), ...windows.flat()])].sort((a, b) => a - b);
  const pieces: Segment[] = [];
  for (let i = 1; i < cuts.length; i++) {
    const [a, b] = [cuts[i - 1]!, cuts[i]!];
    if (b - a <= 0) continue;
    const mid = (a + b) / 2;
    const idle = windows.some(([s, e]) => mid >= s && mid <= e);
    const base = segments.find((s) => mid >= s.startSec && mid <= s.endSec) ?? idleBlock(a, b);
    const piece = idle ? idleBlock(a, b, 'Idle / no input') : { ...base, startSec: a, endSec: b };
    const prev = pieces[pieces.length - 1];
    if (prev && prev.category === piece.category && prev.title === piece.title) prev.endSec = b;
    else pieces.push(piece);
  }
  return pieces;
}

export function categoryTotals(segments: Segment[]) {
  const total = segments.reduce((sum, s) => sum + (s.endSec - s.startSec), 0) || 1;
  return CATEGORIES.map((category) => {
    const seconds = segments.filter((s) => s.category === category).reduce((sum, s) => sum + (s.endSec - s.startSec), 0);
    return { category, seconds: Math.round(seconds), percent: Math.round((seconds / total) * 1000) / 10 };
  }).filter((c) => c.seconds > 0);
}

function segmentationPrompt(input: RangeInput, meta: Record<string, unknown>): string {
  return `You are the TIME-SEGMENTATION engine for Kortix Capture, a work-intelligence product.
Your job: split ONE screen recording into a clean, chronological timeline of how the
person actually spent their time, so a manager can see work vs. non-work at a glance.

You receive:
1. Recording metadata (JSON), including the EXACT total duration.
2. A chronological, human-readable event timeline. Each line is
   "<clock>  <description> [shot:N]" — <clock> is elapsed m:ss from the
   recording start, and [shot:N] cites reference screenshot N (1-based).
   ${LINE_TYPES}
3. ${input.images.length} reference screenshots, attached IN ORDER. The
   "SCREENSHOT INDEX" below maps each screenshot number to the exact clock time
   it was captured, so you can place what is on screen at the right moment.

=== RECORDING METADATA ===
${JSON.stringify(meta, null, 2)}

=== SCREENSHOT INDEX (shot N @ clock — context) ===
${shotIndexText(input)}

=== EVENT TIMELINE ===
${timelineText(input)}

=== YOUR TASK ===
Produce "segments": an ORDERED, NON-OVERLAPPING list of time blocks that together
cover the whole recording from 0:00 to the total duration. Each segment:
  - tStart / tEnd: clock times "m:ss" (or "h:mm:ss"). tEnd of one segment should equal
    tStart of the next. The final tEnd must be the recording's total duration.
  - category: EXACTLY one of:
      "work"          — job tasks: coding, docs, spreadsheets, design, research, tickets, dashboards.
      "communication" — email, chat/Slack/Teams, meetings, calls (work or mixed).
      "personal"      — personal admin: banking, shopping, personal email, settings.
      "entertainment" — video, music, social media, games, news browsing for leisure.
      "idle"          — no meaningful activity: screensaver, no input, away, long waits.
      "other"         — genuinely unclear or none of the above.
  - title: a short, specific label (e.g. "Editing Q3 budget sheet", not "Working").
  - annotation: 1-2 sentences describing what happened, citing [shot:N] where useful.
  - app: the primary application or website in use (e.g. "VS Code", "YouTube", "Gmail").
  - confidence: 0.0-1.0.
  - screenshotRefs: screenshot numbers that show this block.

RULES:
- Ground every segment in what was on screen (the "Screen:" lines and the screenshots).
  WHAT IS ON SCREEN wins over what the keyboard/mouse timeline alone implies — a window
  can be open while the person reads or watches with little input.
- Re-evaluate the app/content at EACH screen change. Do NOT carry a label forward: if the
  morning shows a file explorer and the afternoon shows a game or video, they are
  DIFFERENT segments with different categories.
- Games, video players, streaming, and social feeds are "entertainment" even if a work tab
  is open in the background. Judge by the FOREGROUND content.
- Merge adjacent moments of the SAME activity into one segment. Prefer 6-25 meaningful
  segments — do not emit one segment per click, but DO split when the activity changes.
- Use "idle" honestly for stretches with no real input or an idle/lock screen.
  NOTE: idle/away time (spans with no user input) is also detected automatically
  and will OVERRIDE your labels for those spans — so focus your effort on
  correctly categorizing the ACTIVE work/content that is visible.
- Be decisive about work vs. entertainment vs. personal based on what is visible.
- Cover the FULL duration in order; do not skip the middle or end.
- Return ONLY a JSON object {"segments": [...]}. No markdown fences.`;
}

async function runSegmentation(caller: Caller, input: RangeInput, meta: Record<string, unknown>, usage: Usage) {
  const result = await caller.call(segmentationZod, segmentationPrompt(input, meta), input.images, usage);
  const total = input.totalSeconds;
  const segments = applyIdleWindows(normalizeSegments(result.segments, total), computeIdleWindows(input.inputTimesSec, total), total);
  return {
    totalSeconds: Math.round(total),
    segments: segments.map((s) => ({ ...s, tStart: clock(s.startSec), tEnd: clock(s.endSec) })),
    categoryTotals: categoryTotals(segments),
  };
}

// ─── Transcript ──────────────────────────────────────────────────────────────

const segmentNarrativeZod = z.object({
  narrative: z.string(),
  keyPoints: strs,
  entities: strs,
});
const synthesisZod = z.object({ title: z.string(), summary: z.string() });

/** At most MAX_TRANSCRIPT_WINDOWS windows: merge the shortest neighbouring active blocks. */
function transcriptWindows(segments: Segment[]): Segment[] {
  const windows = segments.map((s) => ({ ...s }));
  while (windows.length > MAX_TRANSCRIPT_WINDOWS) {
    let best = 0;
    for (let i = 1; i < windows.length - 1; i++) {
      const len = (j: number) => windows[j]!.endSec - windows[j]!.startSec + windows[j + 1]!.endSec - windows[j + 1]!.startSec;
      if (len(i) < len(best)) best = i;
    }
    const [a, b] = [windows[best]!, windows[best + 1]!];
    windows.splice(best, 2, { ...a, endSec: b.endSec, title: `${a.title}; ${b.title}`, category: a.category === 'idle' ? b.category : a.category });
  }
  return windows;
}

async function runTranscript(caller: Caller, input: RangeInput, segments: Segment[], usage: Usage) {
  const out: Array<Record<string, unknown>> = [];
  for (const [index, window] of transcriptWindows(segments).entries()) {
    const base = {
      index: index + 1,
      startSec: Math.round(window.startSec),
      endSec: Math.round(window.endSec),
      startClock: clock(window.startSec),
      endClock: clock(window.endSec),
      category: window.category,
      heading: window.title,
    };
    const lines = input.lines.filter((l) => l.tSec >= window.startSec && l.tSec <= window.endSec).slice(0, 120);
    const shots = input.images.filter((s) => s.tSec >= window.startSec && s.tSec <= window.endSec).slice(0, 10);
    if (window.category === 'idle' || lines.length === 0) {
      out.push({ ...base, idle: true, narrative: 'No activity was captured in this window.', keyPoints: [], entities: [], screenshotRefs: [] });
      continue;
    }
    const prompt = `You are documenting ONE short window of a screen recording in exhaustive, faithful detail.
This window is part of a longer session; capture EXACTLY what happened here so it can later be
grepped, searched, and verified against the screenshots.

Window: "${window.title}" · ${base.startClock}–${base.endClock} · category: ${window.category}

Timeline (each line is "<clock>  <description> [shot:N]"; ${LINE_TYPES}):
${lines.map((l) => `${clock(l.tSec)}  ${l.text}`).join('\n')}

Attached screenshots from THIS window, in order: ${shots.map((s) => `shot ${s.index}`).join(', ') || 'none'}
(Cite them inline as [shot:N] using exactly those numbers.)

Write JSON with:
- "narrative": a precise, chronological account of what happened and what was visible on screen in
  this window. Capture concrete specifics: the app or website, window/file/tab titles, on-screen text,
  names, numbers, URLs, messages, code, and what the user typed, clicked, or read. Cite [shot:N].
  Aim for 4-10 sentences. Ground everything; if something is unclear, say so — do NOT invent.
- "keyPoints": 1-5 short factual bullets (artifacts, identifiers, decisions) seen in this window.
- "entities": concrete things observed (files, people, apps, URLs, projects, companies).
Return ONLY JSON. No markdown fences.`;
    const result = await caller.call(segmentNarrativeZod, prompt, shots, usage);
    out.push({
      ...base,
      idle: false,
      narrative: result.narrative,
      keyPoints: result.keyPoints.slice(0, 8),
      entities: result.entities.slice(0, 12),
      screenshotRefs: shots.map((s) => s.index),
    });
  }
  const outline = out
    .filter((s) => !s.idle)
    .map((s) => `- ${s.startClock}-${s.endClock} ${s.heading}: ${String(s.narrative).slice(0, 240)}`)
    .join('\n')
    .slice(0, 12_000);
  const synthesis = outline
    ? await caller.call(
        synthesisZod,
        `Below is a per-segment transcript of one screen recording. Produce a JSON object with:
- "title": a specific, descriptive title for the whole session (not generic).
- "summary": 3-5 sentences covering the purpose and the A-to-Z arc of what was done.
Ground it in the segments; do not invent. Return ONLY JSON.

SEGMENTS:
${outline}`,
        [],
        usage,
      )
    : { title: 'Idle session', summary: 'No activity was captured in this range.' };
  const markdown = [
    `# ${synthesis.title}`,
    `_Full transcript · ${clock(input.totalSeconds)} · ${out.length} segments_`,
    synthesis.summary,
    ...out.map(
      (s) =>
        `## ${s.startClock}–${s.endClock} · ${s.heading} _(${s.category})_\n\n${s.narrative}` +
        `${(s.keyPoints as string[]).length ? `\n\n${(s.keyPoints as string[]).map((k) => `- ${k}`).join('\n')}` : ''}` +
        `${(s.entities as string[]).length ? `\n\n**Entities:** ${(s.entities as string[]).join(', ')}` : ''}`,
    ),
  ].join('\n\n');
  return { title: synthesis.title, summary: synthesis.summary, totalDurationSec: Math.round(input.totalSeconds), segments: out, markdown };
}

// ─── Annotation (3 passes) ───────────────────────────────────────────────────

const pass1Zod = z.object({
  title: z.string(),
  summary: z.string(),
  apps: strs,
  entities: strs,
  segments: z.array(
    z.object({
      tStart: z.string(),
      tEnd: optStr,
      heading: z.string(),
      description: z.string(),
      app: optStr,
      screenshotRefs: refs,
      confidence: num.catch(0.5),
    }),
  ),
  keyMoments: z.array(z.object({ time: z.string(), label: z.string(), screenshotRefs: refs, importance: z.string().catch('medium') })).catch([]),
  sourceOfTruth: z.object({ narrative: z.string(), keyInsights: strs, timelineRef: z.string().catch('') }),
  dataQuality: z.object({ coverage: z.string().catch('low'), gaps: strs, confidence: num.catch(0.5) }),
});

const pass2Zod = z.object({
  corrections: z.array(z.object({ issue: z.string(), severity: z.string().catch('minor'), fix: z.string().catch('') })).catch([]),
  enrichedSegments: z
    .array(z.object({ heading: z.string(), description: z.string(), screenshotRefs: refs, confidence: num.catch(0.5) }))
    .catch([]),
  enrichedNarrative: z.string().catch(''),
  qualityScore: num.catch(0),
  missingDetails: strs,
});

const extractionZod = z.object({
  links: z.array(z.object({ url: z.string(), label: optStr, context: z.string(), timestamp: optStr, screenshotRefs: refs })).catch([]),
  files: z.array(z.object({ name: z.string(), path: optStr, operation: z.string(), context: z.string(), timestamp: optStr, screenshotRefs: refs })).catch([]),
  decisions: z.array(z.object({ decision: z.string(), rationale: optStr, context: z.string(), timestamp: optStr, screenshotRefs: refs })).catch([]),
  actionItems: z.array(z.object({ action: z.string(), priority: optStr, context: z.string(), timestamp: optStr, screenshotRefs: refs })).catch([]),
  communications: z.array(z.object({ type: z.string(), platform: optStr, subject: optStr, participants: strs, context: z.string(), screenshotRefs: refs })).catch([]),
  workPatterns: z.array(z.object({ pattern: z.string(), frequency: optStr, tools_used: strs, description: z.string() })).catch([]),
});

async function runAnnotation(caller: Caller, input: RangeInput, meta: Record<string, unknown>, usage: Usage) {
  const timeline = timelineText(input);
  const pass1 = await caller.call(
    pass1Zod,
    `You are the deep annotation engine for Kortix Capture, a work-intelligence product.
Transform a raw screen recording into a faithful, comprehensive "source of truth."

You receive:
1. Recording metadata as JSON
2. A chronological, human-readable event timeline. Each line is
   "<clock>  <description> [shot:N]" where <clock> is elapsed m:ss and [shot:N] cites
   reference screenshot N (1-based). ${LINE_TYPES}
3. ${input.images.length} reference screenshots in order

=== RECORDING METADATA ===
${JSON.stringify(meta, null, 2)}

=== EVENT TIMELINE ===
${timeline}

=== YOUR TASK ===

Produce a COMPLETE annotation with these components:

**title**: A specific, descriptive title for this work session (not generic like "Work Session").

**summary**: 3-5 sentences capturing the essence, purpose, and outcomes.

**apps**: Applications observed. **entities**: concrete files, people, projects, sites observed.

**segments**: Break the session into chronological chapters. Each segment has:
  - tStart/tEnd: clock times (e.g. "0:00", "3:15")
  - heading: Short descriptive label
  - description: What happened, with [shot:N] references where screenshots exist
  - app: Application in use
  - screenshotRefs: Array of screenshot numbers visible in this segment
  - confidence: 0.0-1.0 score of how certain you are
  Prefer 6-14 meaningful segments. Merge repetitive low-signal activity instead of creating many similar chapters.

**keyMoments**: 5-10 pivotal moments, ordered by importance:
  - time: Clock timestamp
  - label: What happened
  - screenshotRefs: Array of screenshot numbers
  - importance: "critical" | "high" | "medium" | "low"

**sourceOfTruth**: THE MOST IMPORTANT field.
  - narrative: A MULTI-PARAGRAPH markdown account of the entire session. Walk through chronologically.
    Reference screenshots as [shot:N] inline. Make it readable by someone who never saw the recording.
    Minimum 200 words. This is the definitive record of the work session.
  - keyInsights: 2-4 bullet insights
  - timelineRef: A condensed timeline string for quick scanning

**dataQuality**:
  - coverage: "high" | "medium" | "low" — how well the evidence covers the timeline
  - gaps: Array of missing time windows
  - confidence: 0.0-1.0 overall confidence score

RULES:
- Ground EVERY statement in the timeline and screenshots. Do not invent.
- The sourceOfTruth narrative MUST be substantive (200+ words).
- Cover the beginning, middle, and end of the available timeline.
- Do not repeat the same finding across summary, key moments, segments, and narrative unless each placement adds new information.
- Highlight the most important outcomes and visible work artifacts first; avoid generic "user interacted with application" language.
- If evidence is thin, note it in dataQuality.gaps.
- Return ONLY valid JSON matching the schema. No markdown fences.`,
    input.images,
    usage,
  );
  const pass2 = await caller
    .call(
      pass2Zod,
      `You are the CRITIQUE & ENRICHMENT pass for Kortix Capture.

You receive:
1. The original event timeline
2. A Pass-1 annotation (generated from this timeline + screenshots)

=== ORIGINAL TIMELINE ===
${timeline.slice(0, 12_000)}

=== PASS-1 ANNOTATION ===
${JSON.stringify(pass1).slice(0, 20_000)}

=== YOUR TASK ===

Review the Pass-1 annotation and improve it:

**corrections**: Array of factual errors or omissions found: issue, severity ("critical" | "major" | "minor"), fix
**enrichedSegments**: Improved version of the segments (same order and count) with better descriptions, more screenshot references, and honest confidence scores
**enrichedNarrative**: Improved sourceOfTruth narrative that is more detailed, catches anything Pass-1 missed, and has better citations
**qualityScore**: 0.0-1.0 score of the pass-1 output
**missingDetails**: Array of important things pass-1 missed entirely

RULES:
- Be honest but constructive. Ground your critique in the timeline.
- Remove redundancy. Preserve full-session coverage.
- Add uncertainty notes when the evidence does not support a stronger claim.
- Return ONLY valid JSON. No markdown fences.`,
      input.images,
      usage,
    )
    .catch((error) => {
      logger.warn('[capture] annotation pass 2 failed; keeping pass 1', { error: String(error) });
      return null;
    });
  const extraction = await caller
    .call(
      extractionZod,
      `You are the STRUCTURED DATA EXTRACTOR for Kortix Capture.

From the event timeline and ${input.images.length} screenshots, extract ALL structured data:

=== EVENT TIMELINE ===
${timeline.slice(0, 16_000)}

=== EXTRACT ===

**links**: URLs visited — url, label, context, timestamp, screenshotRefs[]
**files**: Files opened/edited/saved — name, path, operation, context, timestamp, screenshotRefs[]
**decisions**: Key decisions made — decision, rationale, context, timestamp, screenshotRefs[]
**actionItems**: TODOs and next steps — action, priority(high/medium/low), context, timestamp, screenshotRefs[]
**communications**: Emails, chats, calls — type, platform, subject, participants[], context, screenshotRefs[]
**workPatterns**: Repeated behaviors — pattern, frequency, tools_used[], description

Be exhaustive but factual. Prefer specific observed artifacts over generic activity labels.
If an item is only weakly implied, omit it rather than hallucinating. Return ONLY valid JSON. No markdown fences.`,
      input.images,
      usage,
    )
    .catch((error) => {
      logger.warn('[capture] annotation extraction failed', { error: String(error) });
      return null;
    });
  // Merge: pass-2 text over pass-1 times; drop empty low-signal segments.
  const segments = pass1.segments
    .map((segment, i) => {
      const enriched = pass2?.enrichedSegments[i];
      return enriched ? { ...segment, ...enriched, screenshotRefs: enriched.screenshotRefs.length ? enriched.screenshotRefs : segment.screenshotRefs } : segment;
    })
    .filter((s) => s.tStart || s.tEnd || s.screenshotRefs.length || s.description.length >= 40);
  return {
    title: pass1.title,
    summary: pass1.summary,
    apps: pass1.apps,
    entities: pass1.entities,
    segments,
    keyMoments: pass1.keyMoments,
    sourceOfTruth: { ...pass1.sourceOfTruth, narrative: pass2?.enrichedNarrative || pass1.sourceOfTruth.narrative },
    corrections: pass2?.corrections ?? [],
    extraction,
    dataQuality: { ...pass1.dataQuality, screenshotsAnalyzed: input.images.length, eventsProcessed: input.lines.length },
  };
}

// ─── Orchestration ───────────────────────────────────────────────────────────

type Kind = 'segmentation' | 'transcript' | 'annotation';

async function record(rangeId: string, kind: Kind, model: string, run: (usage: Usage) => Promise<Record<string, unknown>>) {
  const usage = emptyUsage();
  const started = Date.now();
  await db
    .insert(rangeOutputs)
    .values({ rangeId, kind, status: 'running', model })
    .onConflictDoUpdate({ target: [rangeOutputs.rangeId, rangeOutputs.kind], set: { status: 'running', model, error: null, updatedAt: sql`now()` } });
  try {
    const output = await run(usage);
    await db
      .update(rangeOutputs)
      .set({ status: 'done', output, usage: { ...usage, duration_ms: Date.now() - started }, updatedAt: sql`now()` })
      .where(and(eq(rangeOutputs.rangeId, rangeId), eq(rangeOutputs.kind, kind)));
    return output;
  } catch (error) {
    await db
      .update(rangeOutputs)
      .set({ status: 'failed', error: String(error).slice(0, 2000), usage: { ...usage, duration_ms: Date.now() - started }, updatedAt: sql`now()` })
      .where(and(eq(rangeOutputs.rangeId, rangeId), eq(rangeOutputs.kind, kind)));
    logger.warn('[capture] range pipeline failed', { rangeId, kind, error: String(error) });
    return null;
  }
}

/** Run every pipeline on one range. Idempotent: a re-run replaces the outputs. */
export async function processRange(rangeId: string, caller?: Caller): Promise<void> {
  const [range] = await db.select().from(timelineRanges).where(eq(timelineRanges.rangeId, rangeId)).limit(1);
  if (!range) return;
  await db.update(timelineRanges).set({ status: 'processing', updatedAt: sql`now()` }).where(eq(timelineRanges.rangeId, rangeId));
  let keyId: string | null = null;
  try {
    if (!caller) {
      if (!(await projectLlmGatewayEnabledById(range.projectId))) throw new Error('the LLM gateway is off for this project');
      const key = await createGatewayKey({ accountId: range.accountId, projectId: range.projectId, name: KEY_NAME, createdBy: range.userId });
      keyId = key.key_id;
      caller = gatewayCaller(`Bearer ${key.secret_key}`, config.KORTIX_CAPTURE_MODEL);
    }
    const input = await loadInput(range);
    const meta = {
      sessionName: range.title ?? 'Activity session',
      startedAt: range.startAt.toISOString(),
      endedAt: range.endAt.toISOString(),
      totalClock: clock(input.totalSeconds),
      totalSeconds: Math.round(input.totalSeconds),
      apps: input.apps.slice(0, 20),
    };
    // The transcript needs the segmentation; the annotation needs neither, so it runs alongside.
    const [[segmentation, transcript], annotation] = await Promise.all([
      (async () => {
        const seg = await record(rangeId, 'segmentation', caller!.model, (u) => runSegmentation(caller!, input, meta, u));
        const segments = (seg?.segments as Segment[] | undefined) ?? normalizeSegments([], input.totalSeconds);
        return [seg, await record(rangeId, 'transcript', caller!.model, (u) => runTranscript(caller!, input, segments, u))] as const;
      })(),
      record(rangeId, 'annotation', caller.model, (u) => runAnnotation(caller!, input, meta, u)),
    ]);
    const ok = [segmentation, transcript, annotation].some(Boolean);
    const title = range.title ?? ((transcript?.title as string | undefined) || (annotation?.title as string | undefined) || null);
    // A range that grew while it was processed is `open` again: leave it for its next run.
    await db
      .update(timelineRanges)
      .set({ status: ok ? 'processed' : 'failed', title, updatedAt: sql`now()` })
      .where(and(eq(timelineRanges.rangeId, rangeId), eq(timelineRanges.status, 'processing')));
  } catch (error) {
    await db.update(timelineRanges).set({ status: 'failed', updatedAt: sql`now()` }).where(eq(timelineRanges.rangeId, rangeId));
    throw error;
  } finally {
    if (keyId) await deleteGatewayKey(range.projectId, keyId).catch(() => {});
  }
}
