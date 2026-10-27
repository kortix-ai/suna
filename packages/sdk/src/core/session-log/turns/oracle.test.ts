/**
 * The equivalence oracle of the block turn layer: for every golden fixture session, the v1
 * parity fixture and the edge cases below, `sessionLogTurns` and its block functions, projected
 * to v1 ids, equal the v1 turn helpers on the same rows. Each accepted difference is listed in
 * `ACCEPTED` with its reason; any other difference fails.
 *
 * Two paths per golden fixture:
 *  - `v1 view`: the v1 rows (`toV1` of one thread) read through `sessionLogOfV1Rows`, as
 *    `useSessionLogThread` serves them while the session reads v1;
 *  - `native`: the v2 thread itself, as the API serves it (`GET …/log`).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_FIXTURE } from '../../../../../shared/src/session-fixture';
import type { Message, Part, ToolPart } from '../../runtime/runtime-types';
import {
  collectTurnParts,
  compactionTurnInfo,
  compareMessagesForDisplay,
  findLastTextPart,
  getShellModePart,
  getTurnCost,
  getTurnError,
  getTurnErrorDetails,
  getTurnErrorRawText,
  getTurnStatus,
  groupMessagesIntoTurns,
  groupShowSegments,
  hasRetryingAssistantTurn,
  isQuestionTool,
  isToolPart,
  mergeBurstSteps,
  resolveWorkingTurn,
  segmentTurn,
  shouldShowToolPart,
  splitTurnWork,
  stepLabel,
  toToolView,
  toolKind,
  type BurstStep,
  type ShowGroupedSegment,
  type TurnLike,
} from '../../turns';
import type { SessionLog, SessionLogThread } from '../types';
import { toV1 } from '../v1';
import { sessionLogOfV1Rows, type V1MessageRow } from '../v1-view';
import { sessionLogTurns, sessionLogActivityText, sessionLogBurstSteps, sessionLogTurnSegments, splitSessionLogTurnWork, type SessionLogBurstStep, type SessionLogSegment, type SessionLogTurn } from './index';
import { partOf, v1RowsOf } from './v1-parts';

const FIXTURES = join(import.meta.dir, '../../../../../api-contract/src/__tests__/fixtures/session-log');
const goldens: Array<[string, SessionLog]> = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.v2.json'))
  .sort()
  .map((name) => [name.replace('.v2.json', ''), JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))]);

type Rows = V1MessageRow[];
type Opts = { busy: boolean; hint: string | null; held: string[]; standalone: string[] };
const DEFAULT: Opts = { busy: true, hint: null, held: [], standalone: [] };

// ─── v1 reference: what the transcript computes today ──────────────────────

/** `apps/web` `isAnsweredQuestionPart` + `burstSteps` (activity-burst.tsx), over v1 parts. */
const answered = (part: Part) => {
  if (!isToolPart(part) || !isQuestionTool(part.tool)) return false;
  const questions = (part.state as { input?: { questions?: unknown } }).input?.questions;
  return Array.isArray(questions) && questions.length > 0 && (toToolView(part).answers ?? []).length > 0;
};
function burstStepsV1(parts: Part[]): BurstStep[] {
  return mergeBurstSteps(parts, (p) => stepLabel(p).tier).flatMap((step) =>
    step.kind === 'group' && step.step.parts.some(answered)
      ? step.step.parts.map((part) => ({ kind: 'part' as const, key: part.id, part }))
      : [step],
  );
}
/** `apps/web` `planAnchorMessageId` (plan-anchor.ts), over the rows as the store orders them. */
function planAnchorV1(rows: Rows): string | null {
  let current: string | null = null;
  let anchor: string | null = null;
  let last: string | null = null;
  for (const m of [...rows].sort(compareMessagesForDisplay)) {
    if (m.info.role === 'user') {
      current = last = m.info.id;
      continue;
    }
    if (current === null) continue;
    if (m.parts.some((p) => isToolPart(p) && toolKind(p.tool) === 'todowrite' && shouldShowToolPart({ tool: p.tool }))) anchor = current;
  }
  return anchor ?? last;
}

type Projected = Record<string, unknown>;
const segV1 = (s: ShowGroupedSegment) =>
  s.kind === 'burst' || s.kind === 'show-group' ? { kind: s.kind, ids: s.parts.map((p) => p.id) } : { kind: s.kind, ids: [s.part.id] };
// A thought's `running` is left out: the block layer clamps it to a streaming message (group.test.ts), v1 reads a missing end time as running.
const stepV1 = (s: BurstStep) =>
  s.kind === 'thought'
    ? { kind: s.kind, key: s.key, texts: s.texts, durationMs: s.durationMs }
    : s.kind === 'part'
      ? { kind: s.kind, key: s.key, ids: [s.part.id] }
      : { kind: s.kind, key: s.key, ids: s.step.parts.map((p) => p.id), family: s.step.family, label: s.step.label, status: s.step.status };

function v1Turn(turn: TurnLike<V1MessageRow>, opts: Opts, working: { id: string | null; pending: string[] }, anchor: string | null, children: Record<string, Rows>): Projected {
  const parts = collectTurnParts(turn);
  const standaloneCallIds = new Set(opts.standalone);
  const segments = groupShowSegments(segmentTurn(parts.map((p) => p.part as Part), { standaloneCallIds }), { standaloneCallIds });
  const cost = getTurnCost(parts);
  const compaction = compactionTurnInfo(turn);
  const running = [...parts].reverse().find(({ part }) => isToolPart(part) && (part as ToolPart).state.status === 'running')?.part as ToolPart | undefined;
  const child = running ? children[(running.state as { metadata?: { sessionId?: string } }).metadata?.sessionId ?? ''] : undefined;
  const split = splitTurnWork(segments, { working: false });
  // What the v1 cost read: step-finish parts per reply, and the totals they carry.
  const stepParts = turn.assistantMessages.map((m) => m.parts.filter((p) => p.type === 'step-finish') as Array<{ cost?: number; tokens?: { input?: number; output?: number; reasoning?: number } }>);
  const total = (p: { cost?: number; tokens?: { input?: number; output?: number; reasoning?: number } }) => (p.cost ?? 0) + (p.tokens?.input ?? 0) + (p.tokens?.output ?? 0) + (p.tokens?.reasoning ?? 0);
  const facts = {
    steps: Math.max(0, ...stepParts.map((list) => list.length)),
    stepTotals: stepParts.flat().reduce((n, p) => n + total(p), 0),
    // What the replies' own `info` carries: OpenCode accumulates its steps into it, a synthetic fixture may not.
    infoTotals: turn.assistantMessages.reduce((n, m) => n + total(m.info as never), 0),
  };
  return {
    facts,
    user: turn.userMessage.info.id,
    partial: turn.partial === true,
    assistant: turn.assistantMessages.map((m) => m.info.id),
    error: getTurnError(turn as never) ?? null,
    raw: getTurnErrorRawText(turn as never) ?? null,
    details: getTurnErrorDetails(turn as never) ?? null,
    cost: cost ? Math.round(cost.cost * 1e9) / 1e9 : null,
    tokens: cost?.tokens ?? null,
    compaction: compaction.isCompaction ? { hasContent: compaction.hasContent, inFlight: compaction.inFlight } : null,
    shell: getShellModePart(turn)?.id ?? null,
    response: findLastTextPart(parts)?.id ?? null,
    activity: getTurnStatus(parts, child),
    segments: segments.map(segV1),
    bursts: segments.flatMap((s) => (s.kind === 'burst' ? [burstStepsV1(s.parts).map(stepV1)] : [])),
    split: split && { work: split.work.map(segV1), hoisted: split.hoisted.map(segV1), final: split.final.map(segV1) },
    plan: anchor === turn.userMessage.info.id,
    live: opts.busy && working.id === turn.userMessage.info.id,
    queued: working.pending.includes(turn.userMessage.info.id),
  };
}

/**
 * The rows with the continue prompt OpenCode once sent after a compaction inside a turn: a reply
 * after the marker that names an earlier prompt (or none, the marker being the latest) answers `<marker id>:continued`, a
 * user row with no parts right after the marker. The block layer infers that continuation turn
 * (`group.test.ts`); the v1 helpers file the reply under the prompt, above the marker.
 */
function withContinuePrompts(rows: Rows): Rows {
  const order = new Map<string, number>();
  let marker: { info: Message; at: number; continued: boolean } | null = null;
  const out: Rows = [];
  for (const row of [...rows].sort(compareMessagesForDisplay)) {
    const info = row.info as Message & { parentID?: string; summary?: boolean };
    if (info.role === 'user') {
      order.set(info.id, order.size);
      if (row.parts.some((p) => p.type === 'compaction')) marker = { info, at: order.size - 1, continued: false };
      out.push(row);
      continue;
    }
    // A reply with no loaded prompt joins the latest one: the marker's continuation only when that is the marker.
    const named = (info.parentID === undefined ? undefined : order.get(info.parentID)) ?? order.size - 1;
    if (!marker || info.summary || named > marker.at) {
      out.push(row);
      continue;
    }
    const id = `${marker.info.id}:continued`;
    if (!marker.continued) {
      marker.continued = true;
      const created = ((marker.info as { time?: { created?: number } }).time?.created ?? 0) + 2;
      out.push({ info: { ...marker.info, id, time: { created } } as Message, parts: [] });
    }
    out.push({ ...row, info: { ...info, parentID: id } as Message });
  }
  return out;
}

function v1Side(rows: Rows, opts: Opts, children: Record<string, Rows>) {
  const held = new Set(opts.held);
  const turns = groupMessagesIntoTurns(rows, { pendingMessageIds: held });
  const w = resolveWorkingTurn({ turns, hintMessageId: opts.hint, unrunTurnIds: held });
  const anchor = planAnchorV1(rows);
  return {
    turns: turns.map((t) => v1Turn(t, opts, { id: w.workingTurnId, pending: w.pendingTurnIds }, anchor, children)),
    retrying: hasRetryingAssistantTurn(rows),
  };
}

// ─── the block layer, projected to v1 ids ──────────────────────────────────

const ids = (blocks: readonly unknown[]) => blocks.map((b) => partOf(b as never)?.id ?? `!${(b as { id: string }).id}`);
const segLog = (s: SessionLogSegment) =>
  s.kind === 'burst' || s.kind === 'show-group' ? { kind: s.kind, ids: ids(s.blocks) } : { kind: s.kind, ids: ids([s.block]) };
const stepLog = (s: SessionLogBurstStep) =>
  s.kind === 'thought'
    ? { kind: s.kind, key: s.key, texts: s.texts, durationMs: s.durationMs }
    : s.kind === 'block'
      ? { kind: 'part', key: s.key, ids: ids([s.block]) }
      : { kind: s.kind, key: s.key, ids: ids(s.blocks), family: s.family, label: s.label, status: s.status };

function logTurn(turn: SessionLogTurn, opts: Opts, children: Record<string, SessionLogThread>): Projected {
  // A message's v1 rows: the first is the message, a compaction's second its summary reply.
  const [userRow, ...summary] = turn.partial ? [{ info: { id: turn.user.message_id } }] : v1RowsOf(turn.user);
  const segments = sessionLogTurnSegments(turn.blocks, { standaloneCallIds: new Set(opts.standalone) });
  const split = splitSessionLogTurnWork(segments, { working: false });
  const running = [...turn.blocks].reverse().find((b) => b.type === 'tool_call' && b.status === 'running');
  const childId = running ? turn.threads.find((t) => children[t]) : undefined;
  return {
    user: userRow!.info.id,
    partial: turn.partial,
    assistant: [...summary.map((r) => r.info.id), ...turn.assistant.flatMap((m) => v1RowsOf(m).map((r) => r.info.id))],
    error: turn.error?.message ?? null,
    raw: turn.error?.raw ?? null,
    details: turn.error?.details ?? null,
    cost: turn.cost ? Math.round(turn.cost.cost * 1e9) / 1e9 : null,
    tokens: turn.cost?.tokens ?? null,
    compaction: turn.compaction && { hasContent: turn.compaction.hasContent, inFlight: turn.compaction.inFlight },
    shell: turn.shell ? ids([turn.shell])[0] : null,
    response: turn.response ? ids([turn.response])[0] : null,
    activity: sessionLogActivityText(turn, childId ? children[childId]!.messages : undefined),
    segments: segments.map(segLog),
    bursts: segments.flatMap((s) => (s.kind === 'burst' ? [sessionLogBurstSteps(s.blocks).map(stepLog)] : [])),
    split: split && { work: split.work.map(segLog), hoisted: split.hoisted.map(segLog), final: split.final.map(segLog) },
    plan: turn.plan,
    live: turn.live,
    queued: turn.queued,
  };
}

function logSide(thread: SessionLogThread, opts: Opts, children: Record<string, SessionLogThread>, heads: SessionLogThread[]) {
  const turns = sessionLogTurns(thread, { busy: opts.busy, liveMessageId: opts.hint, held: opts.held, threads: heads });
  return { turns: turns.map((t) => logTurn(t, opts, children)), retrying: turns.some((t) => t.retrying) };
}

// ─── the comparison ────────────────────────────────────────────────────────

/** Every field of every turn that differs, as `<case> #<turn> <field>`. */
function differences(name: string, v1: ReturnType<typeof v1Side>, log: ReturnType<typeof logSide>): Difference[] {
  const out: Difference[] = [];
  if (v1.retrying !== log.retrying) out.push({ at: `${name} retrying`, v1: v1.retrying, log: log.retrying });
  if (v1.turns.length !== log.turns.length) out.push({ at: `${name} turns`, v1: v1.turns.map((t) => t.user), log: log.turns.map((t) => t.user) });
  v1.turns.forEach((t, i) => {
    const l = log.turns[i];
    if (!l) return;
    for (const key of Object.keys(t)) {
      if (key === 'facts') continue;
      if (JSON.stringify(t[key]) !== JSON.stringify(l[key])) out.push({ at: `${name} #${i} ${key}`, v1: t[key], log: l[key], turn: l, v1Turn: t });
    }
  });
  return out;
}

/**
 * The v1 rows of a thread. With `bySeq`, each row is stamped with a time in the record's `seq`
 * order (pi stamps coarse times and no `reply_to`; claude-code stamps its compaction marker after
 * the prompt it precedes), so the v1 helpers, which order same-time rows by id, read the record's
 * order as the block layer does. Their ids are not wire ids, so the stamp is the only clock.
 */
const rowsOf = (log: SessionLog, thread: SessionLogThread, bySeq = false): Rows =>
  bySeq
    ? thread.messages.flatMap((m) =>
        toV1({ ...log, threads: [{ ...thread, messages: [m] }] }).rows.map((r, i) => ({
          info: { ...(r.info as unknown as Message), time: { ...(r.info as { time?: object }).time, created: 1_800_000_000_000 + m.seq * 1000 + i } } as Message,
          parts: r.parts as unknown as Part[],
        })),
      )
    : toV1({ ...log, threads: [thread] }).rows.map((r) => ({ info: r.info as unknown as Message, parts: r.parts as unknown as Part[] }));
const SEQ_ORDERED = new Set(['pi', 'claude-code']);

type Facts = { steps?: number; stepTotals?: number; infoTotals?: number };
type Difference = { at: string; v1: unknown; log: unknown; turn?: Projected & { facts?: Facts }; v1Turn?: Projected & { facts?: Facts } };
/**
 * Accepted differences, each with why the block result is the one to keep. A rule names the
 * field it covers and the cases it applies to (every case unless `cases` narrows it); every rule
 * must still fire. Filled from the oracle's real output; the PR body carries the same list.
 */
/**
 * The v1 cost read and the record's `usage` are allowed to differ only when v1 had nothing the
 * record has: no step-finish part (v1 then prices usage only through the lookup and ignores a
 * reported cost; it reports nothing without a lookup); several steps per reply; or step parts
 * whose totals are not the reply's own (`toV1` writes zero-total step parts for a native record;
 * a synthetic fixture's steps do not add up to its `info`, which OpenCode accumulates). A
 * single-step reply whose steps add up must price the same on both sides.
 */
const costDiffers = (d: Difference) => {
  const v1 = d.v1Turn?.facts ?? {};
  return (d.v1 === null && v1.steps === 0) || (v1.steps ?? 0) > 1 || ((v1.steps ?? 0) > 0 && v1.stepTotals !== v1.infoTotals);
};
const ACCEPTED: Array<{ fields: string[]; cases?: RegExp; when?: (d: Difference) => boolean; reason: string }> = [
  {
    fields: ['cost', 'tokens'],
    // A v1-derived message prices its v1 parts exactly as `getTurnCost` does (the v1 view, a `fromV1` record).
    cases: / native /,
    when: costDiffers,
    reason: "a native record's reply `usage` is the record's own field (`cost` as reported, else the lookup); v1 sums step-finish parts, which a native record's `toV1` writes with zero totals and OpenCode's `info.tokens` (the last step's) does not add up to on a multi-step reply, and without a step part it prices usage only through the lookup",
  },
  {
    fields: ['plan'],
    cases: /^edge all prompts held /,
    reason: 'the fallback anchor is the last displayed turn, so the plan card stays reachable; v1 takes the last message by time, which a held prompt displayed last is not',
  },
  {
    fields: ['response', 'activity', 'segments', 'split', 'assistant', 'bursts', 'cost', 'tokens'],
    when: (d) => d.turn?.compaction != null,
    reason: 'a compaction turn holds its summary in its compaction block, and the block layer draws it as a compaction row; v1 drew the summary as a reply (its text, its reasoning burst, its cost)',
  },
  {
    fields: ['partial'],
    when: (d) => String(d.turn?.user).endsWith(':continued'),
    reason: "the work after a compaction inside a turn is a continuation turn whose prompt is a stand-in with no blocks (`partial`, no bubble); the v1 side reads the same rows with a real continue prompt (`withContinuePrompts`), as OpenCode once sent",
  },
];

const fired = new Set<number>();
const accepted = (d: Difference) => {
  const i = ACCEPTED.findIndex((r) => r.fields.some((f) => d.at.endsWith(` ${f}`)) && (!r.cases || r.cases.test(d.at)) && (!r.when || r.when(d)));
  if (i >= 0) fired.add(i);
  return i >= 0;
};

function check(name: string, rows: Rows, thread: SessionLogThread, opts: Opts, children: { v1: Record<string, Rows>; log: Record<string, SessionLogThread> }, heads: SessionLogThread[] = []) {
  const found = differences(name, v1Side(withContinuePrompts(rows), opts, children.v1), logSide(thread, opts, children.log, heads));
  expect(found.filter((d) => !accepted(d))).toEqual([]);
  return found;
}

// ─── edge cases the goldens do not hold ────────────────────────────────────

const T0 = Date.parse('2026-10-01T12:00:00Z');
const SID = 'ses_edge0000000000000000001';
/** An OpenCode wire id minted at `ms`. */
const wireId = (ms: number, tag: string) =>
  `msg_${((BigInt(ms) * BigInt(0x1000)) & BigInt(0xffffffffffff)).toString(16).padStart(12, '0')}${tag.padEnd(14, 'x').slice(0, 14)}`;
const text = (mid: string, id: string, t: string, extra: object = {}) => ({ id, sessionID: SID, messageID: mid, type: 'text', text: t, ...extra });
const tool = (mid: string, id: string, name: string, state: object) => ({ id, sessionID: SID, messageID: mid, type: 'tool', callID: `call_${id}`, tool: name, state });
const step = (mid: string, id: string, cost: number, input: number) => ({
  id, sessionID: SID, messageID: mid, type: 'step-finish', reason: 'stop', cost, tokens: { input, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
});
function u(ms: number, tag: string, parts: (mid: string) => object[] = (mid) => [text(mid, `prt_${tag}`, tag)]): V1MessageRow {
  const id = wireId(ms, tag);
  return { info: { id, sessionID: SID, role: 'user', time: { created: ms }, agent: 'build', model: { providerID: 'kortix', modelID: 'm' } } as never, parts: parts(id) as never };
}
/** A reply whose `cost` and `tokens` are the sums of its step-finish parts, as OpenCode accumulates them (zero without a step). */
function a(ms: number, tag: string, parent: string | undefined, parts: (mid: string) => object[], info: object = {}): V1MessageRow {
  const id = wireId(ms, tag);
  const built = parts(id);
  const steps = built.filter((p): p is { cost: number; tokens: { input: number; output: number; reasoning: number } } => (p as { type?: string }).type === 'step-finish');
  const sum = (pick: (s: (typeof steps)[number]) => number) => steps.reduce((n, s) => n + pick(s), 0);
  return {
    info: {
      id, sessionID: SID, role: 'assistant', time: { created: ms, completed: ms + 500 }, ...(parent && { parentID: parent }),
      modelID: 'm', providerID: 'kortix', mode: 'build', agent: 'build', path: { cwd: '/', root: '/' }, cost: sum((s) => s.cost),
      tokens: { input: sum((s) => s.tokens.input), output: sum((s) => s.tokens.output), reasoning: sum((s) => s.tokens.reasoning), cache: { read: 0, write: 0 } }, finish: 'stop', ...info,
    } as never,
    parts: built as never,
  };
}
const done = { status: 'completed', input: { command: 'ls' }, output: 'a', title: 'ls', metadata: {}, time: { start: T0, end: T0 + 9 } };

function edgeCases(): Array<[string, Rows, Partial<Opts>]> {
  const p1 = u(T0, 'p1');
  const p2 = u(T0 + 10_000, 'p2');
  const p3 = u(T0 + 20_000, 'p3');
  const unloaded = wireId(T0 - 60_000, 'gone');
  const shell = u(T0 + 30_000, 'shell', (mid) => [text(mid, 'prt_sh', 'ls', { synthetic: true })]);
  const marker = u(T0 + 40_000, 'compact', (mid) => [{ id: 'prt_cmp', sessionID: SID, messageID: mid, type: 'compaction', auto: true }]);
  return [
    ['partial run + orphan', [
      a(T0 - 5_000, 'tail1', unloaded, (mid) => [text(mid, 'prt_t1', 'one'), step(mid, 'prt_s1', 0.01, 5)]),
      a(T0 - 4_000, 'tail2', unloaded, (mid) => [text(mid, 'prt_t2', 'two')]),
      p1,
      a(T0 + 1_000, 'r1', p1.info.id, (mid) => [text(mid, 'prt_r1', 'answer'), step(mid, 'prt_s2', 0.02, 8)]),
    ], {}],
    ['empty shell + error + abort', [
      p1,
      a(T0 + 1_000, 'shell0', p1.info.id, () => [], { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }),
      a(T0 + 2_000, 'err', p1.info.id, (mid) => [text(mid, 'prt_e', 'partial')], {
        error: { name: 'APIError', data: { message: 'Bad Request', statusCode: 400, isRetryable: false, responseBody: '{"error":{"message":"model overloaded","provider":"acme","code":"overloaded","request_id":"req_1"}}' } },
      }),
      p2,
      a(T0 + 11_000, 'stop', p2.info.id, (mid) => [tool(mid, 'prt_k', 'bash', { status: 'error', input: { command: 'sleep 9' }, error: 'Tool execution aborted', time: { start: T0, end: T0 + 1 } })], {
        error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } },
      }),
    ], {}],
    ['retrying turn', [
      p1,
      a(T0 + 1_000, 'retry', p1.info.id, (mid) => [text(mid, 'prt_rt', 'x')], {
        time: { created: T0 + 1_000 }, error: { name: 'APIError', data: { message: 'Too Many Requests', statusCode: 429, isRetryable: true } },
      }),
    ], {}],
    ['streaming turn + held prompts', [
      p1,
      a(T0 + 1_000, 'live', p1.info.id, (mid) => [tool(mid, 'prt_run', 'bash', { status: 'running', input: { command: 'make' }, time: { start: T0 + 1_000 } })], { time: { created: T0 + 1_000 } }),
      p2,
      p3,
    ], { held: [p3.info.id] }],
    ['all prompts held', [p1, p2], { held: [p2.info.id, p1.info.id] }],
    ['shell mode + plan + show', [
      p1,
      a(T0 + 1_000, 'plan', p1.info.id, (mid) => [
        tool(mid, 'prt_todo', 'todowrite', { ...done, input: { todos: [] } }),
        tool(mid, 'prt_show1', 'show', { ...done, input: { type: 'image', path: '/a.png' } }),
        tool(mid, 'prt_show2', 'show', { ...done, input: { type: 'image', path: '/b.png' } }),
        { id: 'prt_rs', sessionID: SID, messageID: mid, type: 'reasoning', text: '**Plan** it', time: { start: T0 + 1_000, end: T0 + 3_000 } },
        tool(mid, 'prt_r1', 'read', { ...done, input: { filePath: '/x' } }),
        tool(mid, 'prt_r2', 'read', { ...done, input: { filePath: '/y' } }),
        text(mid, 'prt_fin', 'done'),
      ]),
      shell,
      a(T0 + 31_000, 'shellr', shell.info.id, (mid) => [tool(mid, 'prt_bash', 'bash', done)]),
    ], { standalone: ['call_prt_r2'] }],
    ['compaction', [
      p1,
      a(T0 + 1_000, 'r1', p1.info.id, (mid) => [text(mid, 'prt_r1', 'answer')]),
      marker,
      a(T0 + 41_000, 'sum', marker.info.id, (mid) => [text(mid, 'prt_sum', 'SUMMARY')], { summary: true, agent: 'compaction', mode: 'compaction' }),
      p2,
    ], {}],
    ['compaction in flight', [p1, marker], {}],
    ['optimistic stub', [
      p1,
      a(T0 + 1_000, 'r1', p1.info.id, (mid) => [text(mid, 'prt_r1', 'answer')]),
      { info: { id: 'optimistic-1', sessionID: SID, role: 'user', time: { created: T0 + 50_000 } } as never, parts: [text('optimistic-1', 'prt_o', 'next')] as never },
    ], {}],
  ];
}

describe('edge cases', () => {
  for (const [name, rows, opts] of edgeCases()) {
    test(`${name}: v1 view`, () => {
      check(`edge ${name}`, rows, sessionLogOfV1Rows('kses', SID, rows).threads[0]!, { ...DEFAULT, ...opts }, { v1: {}, log: {} });
    });
  }
});
describe('the block turn layer equals the v1 turn helpers', () => {
  for (const [name, log] of goldens) {
    for (const thread of log.threads) {
      const rows = rowsOf(log, thread, SEQ_ORDERED.has(name));
      const childRows = Object.fromEntries(log.threads.map((t) => [t.thread_id, rowsOf(log, t, SEQ_ORDERED.has(name))]));
      const childThreads = Object.fromEntries(log.threads.map((t) => [t.thread_id, t]));
      for (const opts of [DEFAULT, { ...DEFAULT, busy: false }]) {
        const label = `${name} ${thread.thread_id === log.threads[0]!.thread_id ? 'root' : thread.thread_id}${opts.busy ? '' : ' idle'}`;
        test(`${label}: v1 view`, () => {
          const view = sessionLogOfV1Rows('kses', thread.thread_id, rows).threads[0]!;
          const viewChildren = Object.fromEntries(log.threads.map((t) => [t.thread_id, sessionLogOfV1Rows('kses', t.thread_id, childRows[t.thread_id]!).threads[0]!]));
          check(`${label} v1-view`, rows, view, opts, { v1: childRows, log: viewChildren }, log.threads);
        });
        test(`${label}: native`, () => {
          check(`${label} native`, rows, thread, opts, { v1: childRows, log: childThreads }, log.threads);
        });
      }
    }
  }

  const fixtureRows = SESSION_FIXTURE.messages as unknown as Rows;
  const fixtureChildren = Object.fromEntries(Object.entries(SESSION_FIXTURE.childSessions).map(([id, m]) => [id, m as unknown as Rows]));
  const viewOf = (sid: string, rows: Rows) => sessionLogOfV1Rows(SESSION_FIXTURE.sessionId, sid, rows).threads[0]!;
  const fixtureThreads = Object.fromEntries(Object.entries(fixtureChildren).map(([id, rows]) => [id, viewOf(id, rows)]));
  for (const [label, opts] of [
    ['parity fixture', DEFAULT],
    ['parity fixture idle', { ...DEFAULT, busy: false }],
    ['parity fixture hinted', { ...DEFAULT, hint: SESSION_FIXTURE.working.userMessageId }],
  ] as const) {
    test(`${label}: v1 view`, () => {
      check(label, fixtureRows, viewOf(SESSION_FIXTURE.sessionId, fixtureRows), opts, { v1: fixtureChildren, log: fixtureThreads });
    });
  }

});

/**
 * A real session: `SESSION_LOG_ORACLE_FILE` names a JSON file `{ rows, log, busy? }` with the
 * session's v1 rows (`transcript?shape=sync`) and its session log (`GET …/log`, every page),
 * captured from a stack. Both paths run on it; the differences print with their reasons.
 */
const REAL = process.env.SESSION_LOG_ORACLE_FILE;
if (REAL) {
  describe(`real session: ${REAL}`, () => {
    const real = JSON.parse(readFileSync(REAL, 'utf8')) as { rows: Rows; log: SessionLog | null; busy?: boolean };
    const opts = { ...DEFAULT, busy: real.busy ?? false };
    const runtime = String((real.rows[0]?.info as { sessionID?: string } | undefined)?.sessionID ?? 'ses_real');
    const root = real.log?.threads.find((t) => t.parent_thread_id === null) ?? real.log?.threads[0];
    const heads = real.log?.threads ?? [];
    const threads = Object.fromEntries(heads.map((t) => [t.thread_id, t]));
    const v1Children = Object.fromEntries(heads.map((t) => [t.thread_id, rowsOf(real.log!, t)]));
    const cases: Array<readonly [string, Rows, SessionLogThread, Record<string, SessionLogThread>]> = [
      ['v1 view', real.rows, sessionLogOfV1Rows('kses_real', runtime, real.rows).threads[0]!, {}],
      ...(real.log && root ? [['native', rowsOf(real.log, root), root, threads] as const] : []),
    ];
    for (const [label, rows, thread, children] of cases) {
      test(label, () => {
        const found = differences(`real ${label}`, v1Side(rows, opts, v1Children), logSide(thread, opts, children, heads));
        for (const d of found) console.log(`${accepted(d) ? 'accepted' : 'UNEXPLAINED'} ${d.at}: v1=${JSON.stringify(d.v1)} log=${JSON.stringify(d.log)}`);
        expect(found.filter((d) => !accepted(d))).toEqual([]);
      });
    }
  });
}

describe('accepted differences', () => {
  test('every accepted rule still fires', () => {
    expect(ACCEPTED.filter((_, i) => !fired.has(i)).map((r) => r.reason)).toEqual([]);
  });
});
