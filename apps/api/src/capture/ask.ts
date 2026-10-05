/**
 * L5 Ask: a question over Capture data, answered with citations to workflows,
 * episodes and moments. Scoped by role: a member asks about their own data;
 * an admin or viewer about the account. The caller streams events:
 *
 *   { type: 'sources', sources }       the numbered sources the answer may cite
 *   { type: 'delta', text }            answer text as it arrives
 *   { type: 'done', answer, citations, model, cost_usd }
 *   { type: 'error', code, error }
 *
 * ponytail: v0 retrieves first (full-text over frames, actions and audio;
 * episodes and workflows by word match) and answers in one model call. The
 * tool-calling agent replaces the retrieval step when it lands.
 */
import { captureEpisodes, captureWorkflows } from '@kortix/db';
import { and, desc, eq, gte, ilike, lt, or, type SQL } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../shared/db';
import { CaptureBudgetExceeded, recordSpend, withinBudget } from './budget';
import { withCaptureGateway } from './gateway';
import { retryTransient } from './processing';
import { searchTimeline } from './reads';

export interface AskInput {
  question: string;
  /** Earlier turns, oldest first; the answer is the next assistant turn. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  scope?: { user_id?: string; device_id?: string; from?: string; to?: string };
}

export type AskSource =
  | { n: number; kind: 'workflow'; workflow_id: string; label: string; detail: string }
  | { n: number; kind: 'episode'; episode_id: string; user_id: string; label: string; start_at: string; detail: string }
  | { n: number; kind: 'moment'; moment: 'screen' | 'actions' | 'audio'; id: string; user_id?: string; device_id: string; ts: string; label: string; detail: string };

export type AskEvent =
  | { type: 'sources'; sources: AskSource[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; answer: string; citations: AskSource[]; model: string; cost_usd: number }
  | { type: 'error'; code: string; error: string };

const STOP = new Set(['what', 'which', 'when', 'where', 'how', 'does', 'did', 'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'take', 'most', 'into', 'about', 'their', 'there', 'they', 'were', 'was', 'are', 'who', 'why', 'can', 'should', 'would', 'could', 'many', 'much', 'time']);

/** The words worth matching: 3+ letters, not a stop word, at most 8. */
export function questionTerms(question: string): string[] {
  return [...new Set(question.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? [])].filter((w) => !STOP.has(w)).slice(0, 8);
}

async function retrieve(accountId: string, subject: string | null, accountWide: boolean, input: AskInput): Promise<AskSource[]> {
  const terms = questionTerms(input.question);
  const to = input.scope?.to ? new Date(input.scope.to) : new Date(Date.now() + 60_000);
  const from = input.scope?.from ? new Date(input.scope.from) : new Date(to.getTime() - 90 * 86_400_000);
  const sources: AskSource[] = [];
  const push = (s: AskSource extends infer T ? (T extends unknown ? Omit<T, 'n'> : never) : never) => sources.push({ ...s, n: sources.length + 1 } as AskSource);
  if (accountWide) {
    const like = terms.map((t) => `%${t}%`);
    const match: SQL | undefined = like.length ? or(...like.flatMap((l) => [ilike(captureWorkflows.name, l), ilike(captureWorkflows.goal, l)])) : undefined;
    const workflows = await db
      .select()
      .from(captureWorkflows)
      .where(and(eq(captureWorkflows.accountId, accountId), match))
      .orderBy(desc(captureWorkflows.automationHoursPerWeek))
      .limit(8);
    for (const w of workflows) {
      push({
        kind: 'workflow',
        workflow_id: w.workflowId,
        label: w.name,
        detail: `${w.status}; ${Number(w.runsPerWeek)} runs/week; typical ${Math.round(w.durationP50S / 60)} min; ${w.peopleCount} people; apps ${w.apps.join(', ')}; ${Number(w.automationHoursPerWeek)} automatable h/week; determinism ${Math.round(Number(w.determinism) * 100)}%; goal: ${w.goal ?? '-'}`,
      });
    }
  }
  const episodeFilters: SQL[] = [eq(captureEpisodes.accountId, accountId), gte(captureEpisodes.endAt, from), lt(captureEpisodes.startAt, to)];
  if (subject) episodeFilters.push(eq(captureEpisodes.userId, subject));
  if (input.scope?.device_id) episodeFilters.push(eq(captureEpisodes.deviceId, input.scope.device_id));
  if (terms.length) episodeFilters.push(or(...terms.flatMap((t) => [ilike(captureEpisodes.label, `%${t}%`), ilike(captureEpisodes.goal, `%${t}%`)]))!);
  const episodes = await db.select().from(captureEpisodes).where(and(...episodeFilters)).orderBy(desc(captureEpisodes.startAt)).limit(8);
  for (const e of episodes) {
    push({
      kind: 'episode',
      episode_id: e.episodeId,
      user_id: e.userId,
      label: e.label ?? 'Episode',
      start_at: e.startAt.toISOString(),
      detail: `${e.startAt.toISOString()}–${e.endAt.toISOString()}; apps ${e.apps.join(', ')}; goal: ${e.goal ?? '-'}; outcome: ${e.outcome ?? '-'}`,
    });
  }
  if (terms.length) {
    const hits = await searchTimeline(accountId, subject, {
      q: terms.join(' or '),
      from,
      to,
      kinds: new Set(['screen', 'actions', 'audio']),
      deviceId: input.scope?.device_id,
      limit: 8,
    });
    for (const h of hits.slice(0, 12) as Array<Record<string, any>>) {
      push({
        kind: 'moment',
        moment: h.kind,
        id: h.id,
        user_id: h.user_id,
        device_id: h.device_id,
        ts: new Date(h.ts).toISOString(),
        label: [h.app, h.title].filter(Boolean).join(' — ') || h.kind,
        detail: String(h.snippet ?? h.text ?? '').replace(/\s+/g, ' ').slice(0, 300),
      });
    }
  }
  return sources;
}

const SYSTEM = `You answer questions about how people work, from the recordings Kortix Capture keeps: workflows (repeated procedures), episodes (one task by one person) and moments (what was on screen, done, or said).
Rules: use only the numbered sources. Cite every claim with its source number in brackets, like [2]. If the sources do not answer the question, say so in one sentence. Be short and concrete: numbers, names of workflows and apps. No preamble.`;

/** Run one question; `emit` receives every event. */
export async function ask(
  scope: { accountId: string; viewer: string; subject: string | null; accountWide: boolean },
  input: AskInput,
  emit: (event: AskEvent) => void,
): Promise<void> {
  if (!(await withinBudget(scope.accountId))) {
    const error = new CaptureBudgetExceeded();
    emit({ type: 'error', code: 'capture_budget_exceeded', error: error.message });
    return;
  }
  const sources = await retrieve(scope.accountId, scope.subject, scope.accountWide, input);
  emit({ type: 'sources', sources });
  const model = config.KORTIX_CAPTURE_MODEL;
  const context = sources.map((s) => `[${s.n}] ${s.kind}${s.kind === 'moment' ? `/${s.moment}` : ''}: ${s.label} — ${s.detail}`).join('\n');
  const messages = [
    { role: 'system', content: SYSTEM },
    ...(input.history ?? []).slice(-6),
    { role: 'user', content: `Sources:\n${context || '(none)'}\n\nQuestion: ${input.question}` },
  ];
  let answer = '';
  let cost = 0;
  await withCaptureGateway({ accountId: scope.accountId, userId: scope.viewer }, async (gateway) => {
    const res = await retryTransient(() =>
      fetch(gateway.url, {
        method: 'POST',
        headers: { authorization: gateway.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, temperature: 0.2, max_tokens: 1200, reasoning_effort: 'low', messages }),
        signal: AbortSignal.timeout(120_000),
      }),
    );
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`gateway ${res.status}: ${text.slice(0, 300)}`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        const text = chunk?.choices?.[0]?.delta?.content;
        if (typeof text === 'string' && text) {
          answer += text;
          emit({ type: 'delta', text });
        }
        if (chunk?.usage?.cost !== undefined) cost = Number(chunk.usage.cost) || 0;
      }
    }
  });
  await recordSpend(scope.accountId, cost, 1);
  const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  emit({ type: 'done', answer, citations: sources.filter((s) => cited.has(s.n)), model, cost_usd: cost });
}
