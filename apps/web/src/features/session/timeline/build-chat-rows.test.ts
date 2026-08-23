import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { groupMessagesIntoTurns, type MessageWithParts, type Part } from '@/ui';
import type { TimelineAssistantPartRow, TimelineRow } from '@kortix/sdk';

import { segmentTurn } from '../turn/segment-turn';
import { scenarios } from './__fixtures__/transcript';
import {
  aliasRowKey,
  buildChatRows,
  createTurnGroupCache,
  groupRowsByTurn,
  makeWebGroupPart,
  toTimelineInput,
  webIsRenderablePart,
} from './build-chat-rows';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

type AnyPart = Record<string, unknown>;
const part = (messageID: string, id: string, rest: AnyPart): Part =>
  ({ id, messageID, sessionID: 'ses', ...rest }) as unknown as Part;
const text = (m: string, id: string, body: string) => part(m, id, { type: 'text', text: body });
const reasoning = (m: string, id: string, body: string) =>
  part(m, id, { type: 'reasoning', text: body });
const tool = (m: string, id: string, name: string, state: AnyPart = { status: 'completed' }) =>
  part(m, id, { type: 'tool', tool: name, callID: `call_${id}`, state });
const keep = (m: string, id: string, type: string) => part(m, id, { type });

let t = 1000;
const user = (id: string, body = 'hi'): MessageWithParts =>
  ({
    info: { id, role: 'user', time: { created: (t += 10) } },
    parts: [text(id, `${id}t`, body)],
  }) as unknown as MessageWithParts;
const assistant = (
  id: string,
  parentID: string,
  parts: Part[],
  info: AnyPart = {},
): MessageWithParts =>
  ({
    info: {
      id,
      role: 'assistant',
      parentID,
      time: { created: (t += 10), completed: t + 5 },
      ...info,
    },
    parts,
  }) as unknown as MessageWithParts;

const EMPTY = new Set<string>();

function build(
  messages: MessageWithParts[],
  overrides: Partial<Parameters<typeof buildChatRows>[0]> = {},
): TimelineRow[] {
  return buildChatRows({
    messages,
    activeUserMessageID: undefined,
    status: 'idle',
    standaloneCallIds: EMPTY,
    answeredQuestionIds: EMPTY,
    prev: undefined,
    ...overrides,
  });
}

const assistantRows = (rows: TimelineRow[], userMessageID: string) =>
  rows.filter(
    (r): r is TimelineAssistantPartRow =>
      r.kind === 'assistant-part' && r.userMessageID === userMessageID,
  );

/** The ids each segment of `segmentTurn` renders, in order — the reference. */
function segmentIds(parts: Part[], standaloneCallIds: ReadonlySet<string> = EMPTY): string[][] {
  return segmentTurn(parts, { standaloneCallIds }).map((s) =>
    s.kind === 'burst' ? s.parts.map((p) => p.id) : [s.part.id],
  );
}

/** The ids each assistant-part row renders, in order. */
function rowIds(rows: TimelineAssistantPartRow[]): string[][] {
  return rows.map((r) =>
    r.group.type === 'context' ? r.group.refs.map((ref) => ref.partID) : [r.group.ref.partID],
  );
}

/** The legacy pre-filter of `SessionTurnImpl` (`segments` useMemo), applied
 *  before `segmentTurn`: plan writes dropped, unanswered questions dropped. */
function legacyFilter(parts: Part[], answered: ReadonlySet<string>): Part[] {
  return parts.filter((p) => {
    if (p.type !== 'tool') return true;
    const toolName = (p as { tool: string }).tool;
    if (toolName === 'todowrite' || toolName === 'todo_write') return false;
    if (toolName === 'question') return answered.has(p.id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// T1 — grouping equivalence with segmentTurn
// ---------------------------------------------------------------------------

describe('buildChatRows reproduces segmentTurn for every turn', () => {
  const cases: {
    name: string;
    parts: Part[];
    standalone?: Set<string>;
    answered?: Set<string>;
  }[] = [
    {
      name: 'a tool burst is one context row',
      parts: [tool('a', 'p1', 'read'), tool('a', 'p2', 'bash'), tool('a', 'p3', 'grep')],
    },
    {
      name: 'text splits a burst into two context rows around a part row',
      parts: [tool('a', 'p1', 'read'), text('a', 'p2', 'prose'), tool('a', 'p3', 'grep')],
    },
    {
      name: 'a standalone show_user gets its own part row',
      parts: [tool('a', 'p1', 'bash'), tool('a', 'p2', 'show_user'), tool('a', 'p3', 'bash')],
    },
    {
      name: 'a pending-permission call (standaloneCallIds) splits the burst',
      parts: [tool('a', 'p1', 'read'), tool('a', 'p2', 'bash'), tool('a', 'p3', 'read')],
      standalone: new Set(['call_p2']),
    },
    {
      name: 'hidden todoread / context_info stay inside the burst (ActivityBurst owns them)',
      parts: [
        tool('a', 'p1', 'read'),
        tool('a', 'p2', 'todoread'),
        tool('a', 'p3', 'context_info'),
      ],
    },
    {
      name: 'the plan write is dropped and does not split the burst',
      parts: [tool('a', 'p1', 'read'), tool('a', 'p2', 'todowrite'), tool('a', 'p3', 'bash')],
    },
    {
      name: 'an unanswered question is dropped, an answered one rides in its burst',
      parts: [
        tool('a', 'p1', 'read'),
        tool('a', 'p2', 'question'),
        tool('a', 'p3', 'question'),
        tool('a', 'p4', 'bash'),
      ],
      answered: new Set(['p3']),
    },
    {
      name: 'reasoning rides inside the burst',
      parts: [reasoning('a', 'p1', 'hmm'), tool('a', 'p2', 'read'), reasoning('a', 'p3', 'ok')],
    },
    {
      name: 'snapshot / patch / step-* are ignored and do not split a burst',
      parts: [
        keep('a', 'p0', 'step-start'),
        tool('a', 'p1', 'bash'),
        keep('a', 'p2', 'snapshot'),
        tool('a', 'p3', 'bash'),
        keep('a', 'p4', 'patch'),
        text('a', 'p5', '   '),
        tool('a', 'p6', 'bash'),
        keep('a', 'p7', 'step-finish'),
      ],
    },
    {
      name: 'an empty settled show part is invisible',
      parts: [
        tool('a', 'p1', 'bash'),
        tool('a', 'p2', 'show_user', { status: 'completed', input: {} }),
        tool('a', 'p3', 'bash'),
      ],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const standalone = c.standalone ?? EMPTY;
      const answered = c.answered ?? EMPTY;
      const messages = [user('u'), assistant('a', 'u', c.parts)];
      const rows = build(messages, {
        standaloneCallIds: standalone,
        answeredQuestionIds: answered,
      });
      const expected = segmentIds(legacyFilter(c.parts, answered), standalone);
      expect(rowIds(assistantRows(rows, 'u'))).toEqual(expected);
    });
  }

  test('a burst spanning two assistant messages stays one row', () => {
    const messages = [
      user('u'),
      assistant('a1', 'u', [tool('a1', 'p1', 'read')]),
      assistant('a2', 'u', [tool('a2', 'p2', 'bash'), text('a2', 'p3', 'done')]),
    ];
    const rows = assistantRows(build(messages), 'u');
    expect(rowIds(rows)).toEqual([['p1', 'p2'], ['p3']]);
    expect(rows[0].group.type).toBe('context');
  });

  test('the SDK flushes a group at the interrupted divider; the projection merges it back', () => {
    // Upstream semantics: a group must not span a rendered divider. The host
    // renders no divider in Stage 2, and `segmentTurn` never split there, so
    // `projectTurnPlacements` merges the two context rows into ONE burst
    // (`partUnits` in project-rows.ts; asserted in project-rows.test.ts and by
    // the `abort-step2-reasoning-head` / `abort-step3-of-three` goldens). The
    // ROWS keep the split — this test pins the row-level fact.
    const messages = [
      user('u'),
      assistant('a1', 'u', [tool('a1', 'p1', 'read')]),
      assistant('a2', 'u', [tool('a2', 'p2', 'bash')], {
        error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
      }),
    ];
    const rows = build(messages);
    expect(rowIds(assistantRows(rows, 'u'))).toEqual([['p1'], ['p2']]);
    expect(rows.some((r) => r.kind === 'turn-divider' && r.label === 'interrupted')).toBe(true);
    // The reference keeps them together — and so does the projection:
    expect(segmentIds([tool('a1', 'p1', 'read'), tool('a2', 'p2', 'bash')])).toEqual([
      ['p1', 'p2'],
    ]);
  });

  test('the SDK flushes a group at the orphan preamble error; the projection merges it back', () => {
    const messages = [
      {
        info: {
          id: 'pre',
          role: 'assistant',
          time: { created: 1 },
          error: { name: 'APIError', data: { message: 'init failed' } },
        },
        parts: [tool('pre', 'p0', 'read')],
      } as unknown as MessageWithParts,
      user('u'),
      assistant('a', 'u', [tool('a', 'p1', 'read'), text('a', 'p2', 'done')]),
    ];
    const rows = build(messages);
    expect(rowIds(assistantRows(rows, 'u'))).toEqual([['p0'], ['p1'], ['p2']]);
    const kinds = rows.filter((r) => r.userMessageID === 'u').map((r) => r.kind);
    expect(kinds).toEqual([
      'user-message',
      'assistant-part',
      'error',
      'assistant-part',
      'assistant-part',
    ]);
    // `segmentTurn` over the turn's parts: one burst of two.
    expect(
      segmentIds([tool('pre', 'p0', 'read'), tool('a', 'p1', 'read'), text('a', 'p2', 'done')]),
    ).toEqual([['p0', 'p1'], ['p2']]);
  });
});

// ---------------------------------------------------------------------------
// Intended divergences from the legacy turn list
// ---------------------------------------------------------------------------

/**
 * Every way `SessionTimelineList` renders DIFFERENTLY from the legacy
 * `turns.map(SessionTurn)` list, on purpose. Each has a golden fixture whose
 * expected markup is the NEW render (`__fixtures__/golden.<name>.html`); an
 * entry here without its golden, or a golden not listed here, fails below.
 * Everything else is byte-identical (the `idle` / `working` goldens plus the
 * other edge scenarios in `__fixtures__/transcript.ts`).
 */
const INTENDED_DIVERGENCES: { fixture: string; rationale: string }[] = [
  {
    fixture: 'assistant-only-head-question',
    rationale:
      'An assistant-only head holding an answered question renders the answered card then its prose as ASSISTANT content; legacy put the head in the user bubble, which renders nothing for a tool part, so the answered question vanished.',
  },
  {
    fixture: 'assistant-only-text',
    rationale:
      'An assistant-only turn (orphan assistant message, no prompt at all) renders its head message as ASSISTANT content — the response block; legacy painted it as a USER bubble.',
  },
  {
    fixture: 'assistant-only-error',
    rationale:
      'An assistant-only turn whose head failed with no parts renders the error text; legacy drew an empty user bubble and no error (getTurnError read only assistantMessages).',
  },
  {
    fixture: 'assistant-only-head-orphan',
    rationale:
      'An assistant-only head followed by a second orphan renders the head text as the first text step of the steps block; legacy put it in a user bubble above the steps.',
  },
  {
    fixture: 'assistant-only-head-tool-abort',
    rationale:
      'An assistant-only head holding only TOOL parts contributes them to the steps burst (two tools, one burst); legacy put the head in the user bubble, which renders nothing for a tool part, so the head tool vanished and the remaining single step rendered as an open one-step burst.',
  },
  {
    fixture: 'working-whitespace-text',
    rationale:
      'A streaming text part that is still all whitespace has no row, so no response block mounts until its first non-blank character; legacy mounted an empty streaming markdown container (an empty div inside the space-y stack).',
  },
  {
    fixture: 'gateway-unreachable',
    rationale:
      'A reply whose info.error is OpenCode\'s "Cannot connect to API …" against the Kortix LLM gateway (a rotated KORTIX_URL / dead tunnel / 530 from the edge) renders the human row — "Couldn\'t reach the Kortix gateway from the sandbox" plus what to do, the raw message behind a "Show error" disclosure (turn/gateway-error.ts classifier); legacy printed the raw provider string verbatim.',
  },
];

describe('intended divergences', () => {
  test('each has a golden fixture and a fixtured scenario', () => {
    const names = new Set(scenarios.map((s) => s.name));
    for (const { fixture, rationale } of INTENDED_DIVERGENCES) {
      expect(rationale.length).toBeGreaterThan(40);
      expect(names.has(fixture)).toBe(true);
      const golden = fileURLToPath(
        new URL(`./__fixtures__/golden.${fixture}.html`, import.meta.url),
      );
      expect(existsSync(golden)).toBe(true);
    }
  });

  test('an assistant-only turn emits NO user-message row and keeps the head message parts', () => {
    const messages = [
      {
        info: { id: 'o', role: 'assistant', time: { created: 1 } },
        parts: [text('o', 'p', 'init')],
      },
    ] as unknown as MessageWithParts[];
    const rows = build(messages);
    expect(rows.map((r) => r.kind)).toEqual(['assistant-part']);
    expect(rowIds(assistantRows(rows, 'o'))).toEqual([['p']]);
  });

  test('a whitespace-only text part has no row', () => {
    const rows = build(
      [user('u'), assistant('a', 'u', [text('a', 'p', '  ')], { time: { created: (t += 10) } })],
      {
        activeUserMessageID: 'u',
        status: 'busy',
      },
    );
    expect(assistantRows(rows, 'u')).toEqual([]);
  });
});

describe('webIsRenderablePart / makeWebGroupPart', () => {
  test('the predicate mirrors the legacy pre-filter plus the invisible-part rule', () => {
    expect(webIsRenderablePart(text('a', 'x', 'hi'), EMPTY)).toBe(true);
    expect(webIsRenderablePart(text('a', 'x', '  '), EMPTY)).toBe(false);
    expect(webIsRenderablePart(reasoning('a', 'x', 'think'), EMPTY)).toBe(true);
    expect(webIsRenderablePart(keep('a', 'x', 'snapshot'), EMPTY)).toBe(false);
    expect(webIsRenderablePart(keep('a', 'x', 'patch'), EMPTY)).toBe(false);
    expect(webIsRenderablePart(keep('a', 'x', 'step-start'), EMPTY)).toBe(false);
    expect(webIsRenderablePart(keep('a', 'x', 'step-finish'), EMPTY)).toBe(false);
    expect(webIsRenderablePart(tool('a', 'x', 'todowrite'), EMPTY)).toBe(false);
    expect(webIsRenderablePart(tool('a', 'x', 'todo_write'), EMPTY)).toBe(false);
    expect(webIsRenderablePart(tool('a', 'x', 'question'), EMPTY)).toBe(false);
    expect(webIsRenderablePart(tool('a', 'x', 'question'), new Set(['x']))).toBe(true);
    // Hidden tools are NOT dropped here: they ride into the burst as today.
    expect(webIsRenderablePart(tool('a', 'x', 'todoread'), EMPTY)).toBe(true);
  });

  test('the grouping key is burst for everything but text and standalone tools', () => {
    const group = makeWebGroupPart(new Set(['call_perm']));
    expect(group(text('a', 'x', 'hi'))).toBeUndefined();
    expect(group(tool('a', 'x', 'show_user'))).toBeUndefined();
    expect(group(tool('a', 'x', 'agent_spawn'))).toBeUndefined();
    expect(group(tool('a', 'perm', 'bash'))).toBeUndefined();
    expect(group(tool('a', 'x', 'bash'))).toBe('burst');
    expect(group(reasoning('a', 'x', 'hmm'))).toBe('burst');
    expect(group(tool('a', 'x', 'question'))).toBe('burst');
  });
});

// ---------------------------------------------------------------------------
// T2 — reuse
// ---------------------------------------------------------------------------

describe('buildChatRows reuses rows', () => {
  const base = () => [
    user('u1'),
    assistant('a1', 'u1', [tool('a1', 'p1', 'read'), text('a1', 'p2', 'one')]),
    user('u2'),
    assistant('a2', 'u2', [text('a2', 'p3', 'two')]),
  ];

  test('a content-only change (same ids) returns the PREVIOUS array object', () => {
    const first = base();
    const prev = build(first);
    const next = first.map((m, i) =>
      i === 3 ? ({ ...m, parts: [text('a2', 'p3', 'two more')] } as MessageWithParts) : m,
    );
    const rows = build(next, { prev });
    expect(Object.is(rows, prev)).toBe(true);
  });

  test('appending a part keeps every other row object', () => {
    const first = base();
    const prev = build(first);
    const next = first.map((m, i) =>
      i === 3 ? ({ ...m, parts: [...m.parts, tool('a2', 'p4', 'bash')] } as MessageWithParts) : m,
    );
    const rows = build(next, { prev });
    expect(Object.is(rows, prev)).toBe(false);
    expect(rows.length).toBe(prev.length + 1);
    const prevByKey = new Map(prev.map((r) => [r.key, r]));
    let fresh = 0;
    for (const row of rows) {
      const before = prevByKey.get(row.key);
      if (before) expect(Object.is(row, before)).toBe(true);
      else fresh += 1;
    }
    expect(fresh).toBe(1);
  });

  test('groupRowsByTurn returns the same groups array for the same rows array', () => {
    const rows = build(base());
    const a = groupRowsByTurn(rows);
    const b = groupRowsByTurn(rows);
    expect(Object.is(a, b)).toBe(true);
    expect(a.map((g) => g.userMessageID)).toEqual(['u1', 'u2']);
    expect(a[0].rows.map((r) => r.kind)).toEqual([
      'user-message',
      'assistant-part',
      'assistant-part',
    ]);
    // The second turn's gap row belongs to the second group.
    expect(a[1].rows[0].kind).toBe('turn-gap');
  });

  test('groupRowsByTurn with a cache: an untouched turn keeps its PREVIOUS group object across frames', () => {
    const cache = createTurnGroupCache();
    const first = base();
    const prev = build(first);
    const g1 = groupRowsByTurn(prev, cache);
    // Same rows array → same groups array (StrictMode's double render).
    expect(Object.is(groupRowsByTurn(prev, cache), g1)).toBe(true);

    // One appended part on u2: u1's group is the previous object, u2's is new.
    const next = first.map((m, i) =>
      i === 3 ? ({ ...m, parts: [...m.parts, tool('a2', 'p4', 'bash')] } as MessageWithParts) : m,
    );
    const rows = build(next, { prev });
    const g2 = groupRowsByTurn(rows, cache);
    expect(Object.is(g2, g1)).toBe(false);
    expect(Object.is(g2[0], g1[0])).toBe(true);
    expect(Object.is(g2[1], g1[1])).toBe(false);
    expect(g2[1].rows.length).toBe(g1[1].rows.length + 1);

    // A new rows ARRAY whose every row is the same object (nothing changed)
    // → the cached groups array itself.
    expect(Object.is(groupRowsByTurn([...rows], cache), g2)).toBe(true);

    // A third turn appended: the first two groups are the previous objects.
    const more = [...next, user('u3'), assistant('a3', 'u3', [text('a3', 'p5', 'three')])];
    const rows3 = build(more, { prev: rows });
    const g3 = groupRowsByTurn(rows3, cache);
    expect(g3.map((g) => g.userMessageID)).toEqual(['u1', 'u2', 'u3']);
    expect(Object.is(g3[0], g2[0])).toBe(true);
    expect(Object.is(g3[1], g2[1])).toBe(true);

    // A turn removed from the front (a rewind): u3 keeps its object, the
    // array is new.
    const rows4 = build(more.slice(2), { prev: rows3 });
    const g4 = groupRowsByTurn(rows4, cache);
    expect(g4.map((g) => g.userMessageID)).toEqual(['u2', 'u3']);
    expect(Object.is(g4[1], g3[2])).toBe(true);
    expect(Object.is(g4, g3)).toBe(false);
  });

  test('groupRowsByTurn without a cache still caches on the rows array identity', () => {
    const rows = build(base());
    expect(Object.is(groupRowsByTurn(rows), groupRowsByTurn(rows))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T3 — queued synthetic bubbles
// ---------------------------------------------------------------------------

describe('queued synthetic bubbles', () => {
  const synthetic = (promptId: string, createdMs: number): MessageWithParts =>
    ({
      info: {
        id: `queued-${promptId}`,
        sessionID: 'ses',
        role: 'user',
        time: { created: createdMs },
      },
      parts: [
        {
          id: `syn-${promptId}`,
          messageID: `queued-${promptId}`,
          sessionID: 'ses',
          type: 'text',
          text: 'later',
        },
      ],
    }) as unknown as MessageWithParts;

  test('produce a user-message row and no assistant rows, reusable across frames', () => {
    const spliced = [
      user('u1'),
      assistant('a1', 'u1', [text('a1', 'p1', 'x')]),
      synthetic('p1', 99_999),
    ];
    const prev = build(spliced);
    const queuedRows = prev.filter((r) => r.userMessageID === 'queued-p1');
    expect(queuedRows.map((r) => r.kind)).toEqual(['turn-gap', 'user-message']);
    expect(queuedRows[1].key).toBe('user-message:queued-p1');
    expect(assistantRows(prev, 'queued-p1')).toEqual([]);
    // A fresh `messages` array with the same ids — every row is reused.
    const rows = build([...spliced.map((m) => ({ ...m }) as MessageWithParts)], { prev });
    expect(Object.is(rows, prev)).toBe(true);
  });

  test('aliasRowKey maps the echo id to the origin the bubble was first painted under', () => {
    const rows = build([user('echo-1'), assistant('a1', 'echo-1', [text('a1', 'p1', 'x')])]);
    const renderKeys = new Map([['echo-1', 'origin-1~']]);
    const bubble = rows.find((r) => r.kind === 'user-message')!;
    expect(aliasRowKey(bubble, (id) => renderKeys.get(id))).toBe('user-message:origin-1~');
    // Non-user rows and unaliased bubbles keep the SDK key.
    const partRow = rows.find((r) => r.kind === 'assistant-part')!;
    expect(aliasRowKey(partRow, (id) => renderKeys.get(id))).toBe(partRow.key);
    expect(aliasRowKey(bubble, () => undefined)).toBe('user-message:echo-1');
  });
});

// ---------------------------------------------------------------------------
// T4 — activeUserMessageID and the type cast
// ---------------------------------------------------------------------------

describe('activeUserMessageID', () => {
  const messages = () => [
    user('W'),
    assistant('aW', 'W', [], { time: { created: (t += 10) } }),
    user('Q'),
  ];

  test('the host passes the WORKING turn, so the placeholder lands under it, not the queued bubble', () => {
    const rows = build(messages(), { activeUserMessageID: 'W', status: 'busy' });
    expect(rows.some((r) => r.kind === 'thinking' && r.userMessageID === 'W')).toBe(true);
    expect(
      rows.some((r) => (r.kind === 'thinking' || r.kind === 'retry') && r.userMessageID === 'Q'),
    ).toBe(false);
  });

  test('the SDK default (last turn) would land under the queued bubble', () => {
    const rows = build(messages(), { status: 'busy' });
    expect(rows.some((r) => r.kind === 'thinking' && r.userMessageID === 'Q')).toBe(true);
  });

  test('toTimelineInput accepts a real AssistantMessage carrying summary: true', () => {
    const msgs = [user('u'), assistant('a', 'u', [text('a', 'p', 'summary')], { summary: true })];
    const input = toTimelineInput(msgs);
    expect(input.length).toBe(2);
    const rows = build(msgs);
    expect(rows.some((r) => r.kind === 'user-message' && r.userMessageID === 'u')).toBe(true);
    // Grouping is unchanged by the cast.
    expect(groupMessagesIntoTurns(msgs).length).toBe(1);
  });
});
