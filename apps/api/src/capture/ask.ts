/**
 * L5 Ask: a question over Capture data, answered by a tool-calling agent with
 * citations to workflows, episodes and moments. Scoped by role: a member asks
 * about their own data; an admin or viewer about a member or the account
 * (audited by the route). The caller streams events:
 *
 *   { type: 'sources', sources }       every numbered source so far (first: a seed
 *                                      retrieval; again after each tool round)
 *   { type: 'tool', name, args }       the agent called a tool
 *   { type: 'delta', text }            answer text as it arrives
 *   { type: 'done', answer, citations, model, cost_usd }
 *   { type: 'error', code, error }
 *
 * The agent runs up to MAX_ROUNDS model calls. Its tools read the same data the
 * routes serve, bound to the caller's scope: search_moments, list_episodes,
 * get_episode, and for account-wide askers list_workflows, get_workflow, stats.
 * Every tool result numbers what it returns as sources; the answer cites them.
 * A gateway that rejects tools falls back to one answer over the seed sources.
 */
import { captureEpisodes, captureWorkflows } from '@kortix/db';
import { and, desc, eq, gte, ilike, lt, or, type SQL } from 'drizzle-orm';
import { episodeInAccount, episodeSteps, overview, workflowDetail, workflowInAccount } from './intelligence';
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
  | { type: 'tool'; name: string; args: Record<string, unknown> }
  | { type: 'delta'; text: string }
  | { type: 'done'; answer: string; citations: AskSource[]; model: string; cost_usd: number }
  | { type: 'error'; code: string; error: string };

const STOP = new Set(['what', 'which', 'when', 'where', 'how', 'does', 'did', 'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'take', 'most', 'into', 'about', 'their', 'there', 'they', 'were', 'was', 'are', 'who', 'why', 'can', 'should', 'would', 'could', 'many', 'much', 'time']);

/** The words worth matching: 3+ letters, not a stop word, at most 8. */
export function questionTerms(question: string): string[] {
  return [...new Set(question.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? [])].filter((w) => !STOP.has(w)).slice(0, 8);
}

export async function retrieve(accountId: string, subject: string | null, accountWide: boolean, input: AskInput): Promise<AskSource[]> {
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

const MAX_ROUNDS = 5;

const SYSTEM = (accountWide: boolean) => `You answer questions about how people work, from what Kortix Capture recorded: workflows (procedures people repeat, with runs per week, duration, automatable hours), episodes (one task by one person, with steps) and moments (what was on screen, done, or said).
You have tools to look things up${accountWide ? ' across the whole account' : " in the asker's own recordings"}. Use them when the numbered sources do not answer the question yet; call tools before you write the answer, not while writing it.
Rules: use only numbered sources. Cite every claim with its source number in brackets, like [2]. If the sources do not answer the question, say so in one sentence. Be short and concrete: numbers, names of workflows and apps. No preamble.`;

type Scope = { accountId: string; viewer: string; subject: string | null; accountWide: boolean };
type ToolSpec = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };

const str = { type: 'string' } as const;
const window = { from: { ...str, description: 'ISO time, inclusive' }, to: { ...str, description: 'ISO time, exclusive' } };

export function askTools(accountWide: boolean): ToolSpec[] {
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolSpec => ({
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required } },
  });
  const person = accountWide ? { user_id: { ...str, description: 'Only this member' } } : {};
  return [
    tool('search_moments', 'Full-text search over what was on screen, typed or said. Returns moments with app, window and a snippet.', { query: { ...str, description: 'Words to find; "a or b" for either' }, app: str, ...person, ...window }, ['query']),
    tool('list_episodes', 'Episodes (one task by one person): label, goal, outcome, apps, duration, workflow. Newest first.', { query: { ...str, description: 'Words in the label or goal' }, workflow_id: str, ...person, ...window }),
    tool('get_episode', 'One episode with its ordered steps (verb, app, object, variables).', { episode_id: str }, ['episode_id']),
    ...(accountWide
      ? [
          tool('list_workflows', 'Workflows (repeated procedures) with runs/week, typical duration, people, apps, automatable hours/week, status.', { query: str, app: str, sort: { type: 'string', enum: ['hours', 'runs', 'newest'] } }),
          tool('get_workflow', 'One workflow: canonical steps, variants with their conditions, people and their runs.', { workflow_id: str }, ['workflow_id']),
          tool('stats', 'Account totals for a time span: hours recorded, people recording, workflows by status, automatable hours/week, top opportunities.', window),
        ]
      : []),
  ];
}

type Push = (s: AskSourceInput) => AskSource;
type AskSourceInput = AskSource extends infer T ? (T extends unknown ? Omit<T, 'n'> : never) : never;

const asDate = (v: unknown, fallback: Date) => {
  const d = typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : fallback;
};

/** Run one tool call in the asker's scope. Returns the JSON the model reads; new sources are pushed. */
export async function runTool(scope: Scope, name: string, args: Record<string, unknown>, push: Push): Promise<unknown> {
  const now = new Date(Date.now() + 60_000);
  const to = asDate(args.to, now);
  const from = asDate(args.from, new Date(to.getTime() - 90 * 86_400_000));
  // A member's tools see the member only; an account-wide asker may narrow to one member.
  const person = scope.accountWide ? (typeof args.user_id === 'string' ? args.user_id : null) : scope.subject;
  const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 200) : '');
  switch (name) {
    case 'search_moments': {
      const hits = await searchTimeline(scope.accountId, person, { q: text(args.query) || 'a', from, to, kinds: new Set(['screen', 'actions', 'audio']), app: text(args.app) || undefined, limit: 12 });
      return (hits as Array<Record<string, any>>).map((h) => {
        const s = push({ kind: 'moment', moment: h.kind, id: h.id, user_id: h.user_id, device_id: h.device_id, ts: new Date(h.ts).toISOString(), label: [h.app, h.title].filter(Boolean).join(' — ') || h.kind, detail: String(h.snippet ?? '').replace(/\s+/g, ' ').slice(0, 300) });
        return { source: s.n, kind: h.kind, ts: s.kind === 'moment' ? s.ts : null, where: s.label, snippet: s.detail };
      });
    }
    case 'list_episodes': {
      const filters: SQL[] = [eq(captureEpisodes.accountId, scope.accountId), gte(captureEpisodes.endAt, from), lt(captureEpisodes.startAt, to)];
      if (person) filters.push(eq(captureEpisodes.userId, person));
      if (typeof args.workflow_id === 'string') filters.push(eq(captureEpisodes.workflowId, args.workflow_id));
      const terms = questionTerms(text(args.query));
      if (terms.length) filters.push(or(...terms.flatMap((t) => [ilike(captureEpisodes.label, `%${t}%`), ilike(captureEpisodes.goal, `%${t}%`)]))!);
      const rows = await db.select().from(captureEpisodes).where(and(...filters)).orderBy(desc(captureEpisodes.startAt)).limit(15);
      return rows.map((e) => {
        const s = push({ kind: 'episode', episode_id: e.episodeId, user_id: e.userId, label: e.label ?? 'Episode', start_at: e.startAt.toISOString(), detail: `${Math.round((e.endAt.getTime() - e.startAt.getTime()) / 1000)} s; apps ${e.apps.join(', ')}; goal: ${e.goal ?? '-'}; outcome: ${e.outcome ?? '-'}` });
        return { source: s.n, episode_id: e.episodeId, label: e.label, start_at: e.startAt.toISOString(), duration_s: Math.round((e.endAt.getTime() - e.startAt.getTime()) / 1000), apps: e.apps, outcome_status: e.outcomeStatus, workflow_id: e.workflowId, variant: e.variantKey };
      });
    }
    case 'get_episode': {
      const e = await episodeInAccount(scope.accountId, text(args.episode_id));
      if (!e || (person && e.userId !== person) || (!scope.accountWide && e.userId !== scope.subject)) return { error: 'not found' };
      const steps = await episodeSteps(e.episodeId);
      const s = push({ kind: 'episode', episode_id: e.episodeId, user_id: e.userId, label: e.label ?? 'Episode', start_at: e.startAt.toISOString(), detail: steps.map((x) => `${x.verb} ${x.object}${x.app ? ` (${x.app})` : ''}`).join(' → ').slice(0, 400) });
      return { source: s.n, label: e.label, goal: e.goal, outcome: e.outcome, steps: steps.map((x) => ({ verb: x.verb, app: x.app, object: x.object, variables: x.variables })) };
    }
    case 'list_workflows':
    case 'get_workflow':
    case 'stats': {
      if (!scope.accountWide) return { error: 'workflows and stats are for Capture admins and viewers' };
      if (name === 'stats') {
        const o = await overview(scope.accountId, { from, to });
        return { hours_recorded: o.hours_recorded, people: o.people, workflows: o.workflows, automation_hours_per_week: o.automation_hours_per_week, top: o.top_opportunities.map((w) => ({ source: pushWorkflow(push, w).n, name: w.name, hours_per_week: w.automation_hours_per_week })) };
      }
      if (name === 'get_workflow') {
        const w = await workflowInAccount(scope.accountId, text(args.workflow_id));
        if (!w) return { error: 'not found' };
        const d = await workflowDetail(w);
        return { source: pushWorkflow(push, d).n, name: d.name, goal: d.goal, steps: d.steps, variants: d.variants, people: d.people, runs_per_week: d.runs_per_week, duration_p50_s: d.duration_p50_s, automation_hours_per_week: d.automation_hours_per_week };
      }
      const terms = questionTerms(text(args.query));
      const filters: SQL[] = [eq(captureWorkflows.accountId, scope.accountId)];
      if (terms.length) filters.push(or(...terms.flatMap((t) => [ilike(captureWorkflows.name, `%${t}%`), ilike(captureWorkflows.goal, `%${t}%`)]))!);
      const order = args.sort === 'runs' ? desc(captureWorkflows.runsPerWeek) : args.sort === 'newest' ? desc(captureWorkflows.firstSeenAt) : desc(captureWorkflows.automationHoursPerWeek);
      const rows = await db.select().from(captureWorkflows).where(and(...filters)).orderBy(order).limit(15);
      return rows
        .filter((w) => !args.app || w.apps.includes(text(args.app)))
        .map((w) => ({ source: pushWorkflow(push, { workflow_id: w.workflowId, name: w.name, status: w.status, runs_per_week: Number(w.runsPerWeek), duration_p50_s: w.durationP50S, people_count: w.peopleCount, apps: w.apps, automation_hours_per_week: Number(w.automationHoursPerWeek), goal: w.goal }).n, workflow_id: w.workflowId, name: w.name, status: w.status, runs_per_week: Number(w.runsPerWeek), duration_p50_s: w.durationP50S, people: w.peopleCount, apps: w.apps, automation_hours_per_week: Number(w.automationHoursPerWeek) }));
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

function pushWorkflow(push: Push, w: { workflow_id: string; name: string; status: string; runs_per_week: number; duration_p50_s: number; people_count: number; apps: string[]; automation_hours_per_week: number; goal: string | null }) {
  return push({ kind: 'workflow', workflow_id: w.workflow_id, label: w.name, detail: `${w.status}; ${w.runs_per_week} runs/week; typical ${Math.round(w.duration_p50_s / 60)} min; ${w.people_count} people; apps ${w.apps.join(', ')}; ${w.automation_hours_per_week} automatable h/week; goal: ${w.goal ?? '-'}` });
}

interface Round {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  cost: number;
}

/** Read one streamed chat completion: text deltas go to `onText`; tool calls are assembled by index. */
export async function readRound(body: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<Round> {
  const reader = body.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader();
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let content = '';
  let cost = 0;
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
      const delta = chunk?.choices?.[0]?.delta;
      if (typeof delta?.content === 'string' && delta.content) {
        content += delta.content;
        onText(delta.content);
      }
      for (const tc of (delta?.tool_calls ?? []) as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>) {
        const i = tc.index ?? 0;
        const call = calls.get(i) ?? { id: '', name: '', arguments: '' };
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.arguments += tc.function.arguments;
        calls.set(i, call);
      }
      if (chunk?.usage?.cost !== undefined) cost = Number(chunk.usage.cost) || 0;
    }
  }
  return { content, toolCalls: [...calls.values()].filter((c) => c.name).map((c, i) => ({ ...c, id: c.id || `call_${i}` })), cost };
}

export type AskTransport = (body: Record<string, unknown>) => Promise<Response>;

/** Run one question; `emit` receives every event. `transport` replaces the gateway (tests). */
export async function ask(scope: Scope, input: AskInput, emit: (event: AskEvent) => void, transport?: AskTransport): Promise<void> {
  if (!(await withinBudget(scope.accountId))) {
    emit({ type: 'error', code: 'capture_budget_exceeded', error: new CaptureBudgetExceeded().message });
    return;
  }
  const sources = await retrieve(scope.accountId, scope.subject, scope.accountWide, input);
  const seen = new Map<string, AskSource>(sources.map((s) => [sourceKey(s), s]));
  const push: Push = (s) => {
    const key = sourceKey(s as AskSource);
    const existing = seen.get(key);
    if (existing) return existing;
    const added = { ...s, n: sources.length + 1 } as AskSource;
    sources.push(added);
    seen.set(key, added);
    return added;
  };
  emit({ type: 'sources', sources: [...sources] });
  const model = config.KORTIX_CAPTURE_MODEL;
  const context = (list: AskSource[]) => list.map((s) => `[${s.n}] ${s.kind}${s.kind === 'moment' ? `/${s.moment}` : ''}: ${s.label} — ${s.detail}`).join('\n');
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: SYSTEM(scope.accountWide) },
    ...(input.history ?? []).slice(-6),
    { role: 'user', content: `Sources:\n${context(sources) || '(none)'}\n\nQuestion: ${input.question}` },
  ];
  let answer = '';
  let cost = 0;
  const go = async (send: AskTransport) => {
    let tools: ToolSpec[] | null = askTools(scope.accountWide);
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (round && !(await withinBudget(scope.accountId))) throw new CaptureBudgetExceeded();
      const last = round === MAX_ROUNDS - 1;
      const res = await send({ model, stream: true, stream_options: { include_usage: true }, temperature: 0.2, max_tokens: 1200, reasoning_effort: 'low', messages, ...(tools && !last ? { tools, tool_choice: 'auto' } : {}) });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        // A model or gateway without tool support: answer once over the seed sources.
        if (tools && res.status === 400 && /tool/i.test(text)) {
          tools = null;
          round--;
          continue;
        }
        throw new Error(`gateway ${res.status}: ${text.slice(0, 300)}`);
      }
      const r = await readRound(res.body, (text) => {
        answer += text;
        emit({ type: 'delta', text });
      });
      cost += r.cost;
      await recordSpend(scope.accountId, r.cost, 1);
      if (!r.toolCalls.length) return;
      messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) });
      for (const call of r.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch {
          args = {};
        }
        emit({ type: 'tool', name: call.name, args });
        const result = await runTool(scope, call.name, args, push).catch((error) => ({ error: String(error).slice(0, 200) }));
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12_000) });
      }
      emit({ type: 'sources', sources: [...sources] });
    }
  };
  if (transport) await go(transport);
  else {
    await withCaptureGateway({ accountId: scope.accountId, userId: scope.viewer }, (gateway) =>
      go((body) =>
        retryTransient(() =>
          fetch(gateway.url, { method: 'POST', headers: { authorization: gateway.authorization, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) }),
        ),
      ),
    );
  }
  const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  emit({ type: 'done', answer, citations: sources.filter((s) => cited.has(s.n)), model, cost_usd: cost });
}

const sourceKey = (s: AskSource) => (s.kind === 'workflow' ? `w:${s.workflow_id}` : s.kind === 'episode' ? `e:${s.episode_id}` : `m:${s.id}`);
