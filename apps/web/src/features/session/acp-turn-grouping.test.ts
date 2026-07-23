import { describe, expect, test } from 'bun:test';
import type { AcpChatItem, AcpStoredEnvelope } from '@kortix/sdk';
import {
  acpContextGroupSummary,
  acpItemOrdinal,
  acpOrdinalTimestamps,
  acpSessionContextTokens,
  acpToolGroupKind,
  acpTurnDurationMs,
  acpTurnEndedAt,
  acpTurnMetaRows,
  describeAcpStopReason,
  formatAcpContextValue,
  formatAcpCost,
  formatAcpDuration,
  groupAcpTurnItems,
  groupAcpTurns,
  parseAcpReplyContext,
  splitAcpTurn,
  wrapAcpReplyContext,
} from './acp-turn-grouping';

function userMsg(id: string, text = 'hi'): AcpChatItem {
  return { kind: 'message', id, role: 'user', text };
}
function assistantMsg(id: string, text = 'hello'): AcpChatItem {
  return { kind: 'message', id, role: 'assistant', text };
}
function thoughtMsg(id: string, text = 'thinking'): AcpChatItem {
  return { kind: 'message', id, role: 'thought', text };
}
function tool(
  id: string,
  title: string,
  toolKind: string | null = null,
  status = 'completed',
): Extract<AcpChatItem, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id,
    title,
    toolKind,
    status,
    content: [],
    locations: [],
    rawInput: {},
    rawOutput: null,
    data: {},
  };
}

describe('groupAcpTurns', () => {
  test('starts a new turn on every user message', () => {
    const items = [userMsg('prompt-1'), assistantMsg('assistant-2'), userMsg('prompt-3'), assistantMsg('assistant-4')];
    const turns = groupAcpTurns(items);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toHaveLength(2);
    expect(turns[1]).toHaveLength(2);
  });

  test('attaches leading orphan items to their own turn when no user message precedes them', () => {
    const items = [assistantMsg('assistant-1'), userMsg('prompt-2')];
    const turns = groupAcpTurns(items);
    expect(turns).toHaveLength(2);
    expect(turns[0][0].kind).toBe('message');
  });

  test('empty input yields no turns', () => {
    expect(groupAcpTurns([])).toEqual([]);
  });
});

describe('splitAcpTurn', () => {
  test('separates the user bubble from the rest', () => {
    const turn = [userMsg('prompt-1'), assistantMsg('assistant-2')];
    const { userItem, restItems } = splitAcpTurn(turn);
    expect(userItem?.id).toBe('prompt-1');
    expect(restItems).toHaveLength(1);
  });

  test('returns null userItem when the turn does not start with a user message', () => {
    const turn = [assistantMsg('assistant-1')];
    const { userItem, restItems } = splitAcpTurn(turn);
    expect(userItem).toBeNull();
    expect(restItems).toHaveLength(1);
  });
});

describe('acpToolGroupKind', () => {
  test('collapses read/glob/grep/list into the context bucket', () => {
    expect(acpToolGroupKind('read')).toBe('__context__');
    expect(acpToolGroupKind('glob')).toBe('__context__');
    expect(acpToolGroupKind('grep')).toBe('__context__');
    expect(acpToolGroupKind('list')).toBe('__context__');
  });

  test('collapses bash into the shell bucket', () => {
    expect(acpToolGroupKind('bash')).toBe('__shell__');
  });

  test('other tools group by their own name', () => {
    expect(acpToolGroupKind('edit')).toBe('edit');
    expect(acpToolGroupKind('write')).toBe('write');
  });
});

describe('groupAcpTurnItems', () => {
  test('folds 2+ consecutive same-bucket tool calls into a tool-group, leaves singles alone', () => {
    const items = [
      tool('t1', 'Read a.ts', 'read'),
      tool('t2', 'Read b.ts', 'read'),
      tool('t3', 'Run command', 'execute'),
    ];
    const grouped = groupAcpTurnItems(items);
    expect(grouped).toEqual([
      { type: 'tool-group', groupKind: '__context__', items: [items[0], items[1]], key: 'tg-t1' },
      { type: 'tool-single', item: items[2] },
    ]);
  });

  test('folds consecutive non-empty thought messages into one reasoning group', () => {
    const items = [thoughtMsg('thought-1', 'step one'), thoughtMsg('thought-2', 'step two'), assistantMsg('assistant-3')];
    const grouped = groupAcpTurnItems(items);
    expect(grouped[0]).toEqual({
      type: 'reasoning-group',
      items: [items[0], items[1]],
      key: 'reasoning-thought-1',
    });
    expect(grouped[1]).toEqual({ type: 'message', item: items[2] });
  });

  test('drops blank thought messages instead of grouping them', () => {
    const items = [thoughtMsg('thought-1', '   '), assistantMsg('assistant-2')];
    expect(groupAcpTurnItems(items)).toEqual([{ type: 'message', item: items[1] }]);
  });

  test('a run of 3+ tool calls interrupted by text breaks the group', () => {
    const items = [tool('t1', 'Read a.ts', 'read'), assistantMsg('assistant-2'), tool('t3', 'Read b.ts', 'read')];
    const grouped = groupAcpTurnItems(items);
    expect(grouped).toEqual([
      { type: 'tool-single', item: items[0] },
      { type: 'message', item: items[1] },
      { type: 'tool-single', item: items[2] },
    ]);
  });

  test('permission items are dropped (pinned above the composer instead); question items stay inline', () => {
    const items: AcpChatItem[] = [
      { kind: 'permission', id: 1, method: 'session/request_permission', params: {} },
      { kind: 'question', id: 2, method: 'session/elicit', questions: [], params: {} },
      assistantMsg('assistant-3'),
    ];
    // Permission is dropped (rendered in the composer's `AcpSessionPermissionPrompt`),
    // but the question survives as its own inline render item — the owner
    // decision is that a question shows as BOTH a composer chip and an inline
    // `AcpQuestionCard`.
    expect(groupAcpTurnItems(items)).toEqual([
      { type: 'question', item: items[1] },
      { type: 'message', item: items[2] },
    ]);
  });

  test('plan and raw items pass through as their own render item', () => {
    const items: AcpChatItem[] = [
      { kind: 'plan', entries: ['step'], data: {} },
      { kind: 'raw', method: 'weird/method', data: { a: 1 } },
    ];
    expect(groupAcpTurnItems(items)).toEqual([
      { type: 'plan', item: items[0] },
      { type: 'raw', item: items[1] },
    ]);
  });
});

describe('reply context wrap/parse round-trip', () => {
  test('wraps then parses back to the original clean text and reply', () => {
    const wrapped = wrapAcpReplyContext('follow-up question', 'the earlier answer');
    const { cleanText, replyContext } = parseAcpReplyContext(wrapped);
    expect(cleanText).toBe('follow-up question');
    expect(replyContext).toBe('the earlier answer');
  });

  test('text with no reply context parses through unchanged', () => {
    expect(parseAcpReplyContext('plain message')).toEqual({
      cleanText: 'plain message',
      replyContext: null,
    });
  });
});

describe('acpItemOrdinal', () => {
  test('extracts the trailing ordinal from message-kind ids', () => {
    expect(acpItemOrdinal('prompt-12')).toBe(12);
    expect(acpItemOrdinal('assistant-7')).toBe(7);
    expect(acpItemOrdinal('thought-0')).toBe(0);
  });

  test('returns null for ids with no trailing ordinal', () => {
    expect(acpItemOrdinal('acp-tool:call_abc')).toBeNull();
  });
});

describe('acpTurnDurationMs', () => {
  const envelopes: AcpStoredEnvelope[] = [
    { ordinal: 1, direction: 'client_to_agent', envelope: {}, createdAt: '2026-01-01T00:00:00.000Z' },
    { ordinal: 2, direction: 'agent_to_client', envelope: {}, createdAt: '2026-01-01T00:00:05.000Z' },
    { ordinal: 3, direction: 'agent_to_client', envelope: {}, createdAt: '2026-01-01T00:00:12.000Z' },
  ];
  const ordinalTimestamps = acpOrdinalTimestamps(envelopes);

  test('spans from the earliest to the latest message ordinal in the turn', () => {
    const turnItems = [userMsg('prompt-1'), thoughtMsg('thought-2'), assistantMsg('assistant-3')];
    expect(acpTurnDurationMs(turnItems, ordinalTimestamps)).toBe(12_000);
  });

  test('ignores tool items (no ordinal-addressable timing)', () => {
    const turnItems = [userMsg('prompt-1'), tool('t-mid', 'Read', 'read'), assistantMsg('assistant-3')];
    expect(acpTurnDurationMs(turnItems, ordinalTimestamps)).toBe(12_000);
  });

  test('returns null when there is not enough timestamp data', () => {
    expect(acpTurnDurationMs([userMsg('prompt-1')], ordinalTimestamps)).toBeNull();
    expect(acpTurnDurationMs([tool('t1', 'Read')], ordinalTimestamps)).toBeNull();
  });
});

describe('formatAcpDuration', () => {
  test('formats sub-minute durations as seconds', () => {
    expect(formatAcpDuration(4_200)).toBe('4s');
    expect(formatAcpDuration(0)).toBe('0s');
  });

  test('formats minute-plus durations as m/s', () => {
    expect(formatAcpDuration(65_000)).toBe('1m 5s');
    expect(formatAcpDuration(120_000)).toBe('2m');
  });
});

describe('formatAcpCost', () => {
  test('formats USD amounts with a $ prefix', () => {
    expect(formatAcpCost({ amount: 0.1234, currency: 'USD' })).toBe('$0.12');
  });

  test('shows extra precision for sub-cent amounts', () => {
    expect(formatAcpCost({ amount: 0.0031, currency: 'USD' })).toBe('$0.0031');
  });

  test('returns null when there is no cost', () => {
    expect(formatAcpCost(null)).toBeNull();
    expect(formatAcpCost(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session-total usage line (Task WS5-P3-b) — pure projections off the
// existing `AcpUsageProjection` snapshot (`used`/`tokens`/`cost`), no fetch.
// ---------------------------------------------------------------------------

describe('acpSessionContextTokens', () => {
  test('prefers the stable `usage_update` total (`used`) over the token-total fallback', () => {
    expect(
      acpSessionContextTokens({
        used: 128_000,
        tokens: { total: 999, input: 0, output: 0, thought: null, cachedRead: null, cachedWrite: null },
      }),
    ).toBe(128_000);
  });

  test('falls back to the prompt-response token total when `used` has not been reported', () => {
    expect(
      acpSessionContextTokens({
        used: null,
        tokens: { total: 4_500, input: 0, output: 0, thought: null, cachedRead: null, cachedWrite: null },
      }),
    ).toBe(4_500);
  });

  test('returns null when neither is available', () => {
    expect(acpSessionContextTokens(null)).toBeNull();
    expect(acpSessionContextTokens(undefined)).toBeNull();
    expect(acpSessionContextTokens({ used: null, tokens: null })).toBeNull();
  });
});

describe('formatAcpContextValue', () => {
  test('formats thousands as a compact "k" count — bare, because the popover row supplies the "Context" label', () => {
    expect(formatAcpContextValue({ used: 128_000, tokens: null })).toBe('128k');
  });

  test('formats sub-1000 token counts as a raw number', () => {
    expect(formatAcpContextValue({ used: 420, tokens: null })).toBe('420');
  });

  test('returns null when there is no context usage yet', () => {
    expect(formatAcpContextValue(null)).toBeNull();
    expect(formatAcpContextValue({ used: 0, tokens: null })).toBeNull();
    expect(formatAcpContextValue({ used: null, tokens: null })).toBeNull();
  });
});

describe('acpTurnEndedAt', () => {
  const stamps = new Map([
    [1, 1_000],
    [2, 6_000],
  ]);

  test('is the latest message timestamp in the turn', () => {
    const turn: AcpChatItem[] = [
      { kind: 'message', id: 'prompt-1', role: 'user', text: 'go' },
      { kind: 'message', id: 'assistant-2', role: 'assistant', text: 'done' },
    ];
    expect(acpTurnEndedAt(turn, stamps)).toBe(6_000);
  });

  test('survives a single-timestamp turn, where the DURATION is unknowable', () => {
    const turn: AcpChatItem[] = [{ kind: 'message', id: 'prompt-1', role: 'user', text: 'go' }];
    expect(acpTurnEndedAt(turn, stamps)).toBe(1_000);
    expect(acpTurnDurationMs(turn, stamps)).toBeNull();
  });

  test('is null when no message item resolves to a timestamp', () => {
    const turn: AcpChatItem[] = [{ kind: 'message', id: 'prompt-99', role: 'user', text: 'go' }];
    expect(acpTurnEndedAt(turn, stamps)).toBeNull();
  });
});

describe('acpTurnMetaRows', () => {
  const NOW = 1_700_000_000_000;

  test('labels every value, and de-jargons "ctx" into a spelled-out token count', () => {
    expect(
      acpTurnMetaRows({
        endedAt: NOW - 5_000,
        now: NOW,
        durationMs: 135_000,
        cost: { amount: 0.45, currency: 'USD' },
        usage: { used: 46_000, tokens: null },
      }),
    ).toEqual([
      { label: 'Finished', value: '5 seconds ago' },
      { label: 'Duration', value: '2m 15s' },
      { label: 'Session cost', value: '$0.45' },
      { label: 'Context', value: '46k tokens' },
    ]);
  });

  test('cost carries no "this session" suffix — the label already says it', () => {
    const rows = acpTurnMetaRows({
      endedAt: null,
      now: NOW,
      durationMs: null,
      cost: { amount: 0.42, currency: 'USD' },
      usage: null,
    });
    expect(rows).toEqual([{ label: 'Session cost', value: '$0.42' }]);
  });

  test('omits rows the harness reported nothing for — never a fabricated $0.00 or 0 tokens', () => {
    expect(
      acpTurnMetaRows({
        endedAt: NOW - 90_000,
        now: NOW,
        durationMs: null,
        cost: null,
        usage: { used: 0, tokens: null },
      }),
    ).toEqual([{ label: 'Finished', value: '2 minutes ago' }]);
  });

  test('is empty when the turn has no meta at all, so the caller can drop the trigger', () => {
    expect(
      acpTurnMetaRows({ endedAt: null, now: NOW, durationMs: null, cost: null, usage: null }),
    ).toEqual([]);
  });
});

describe('acpContextGroupSummary', () => {
  test('summarizes reads/searches/lists across a context group', () => {
    const items = [tool('t1', 'Read a.ts', 'read'), tool('t2', 'Read b.ts', 'read'), tool('t3', 'Search', 'grep')];
    expect(acpContextGroupSummary(items)).toBe('2 reads, 1 search');
  });

  test('empty group summarizes to an empty string', () => {
    expect(acpContextGroupSummary([])).toBe('');
  });
});

// Real captured `stopReason` values (`kortix.acp_session_envelopes`, local
// DB, 2026-07-22): 140x `end_turn`, 1x `cancelled`. `refusal`/`max_tokens`/
// `max_turn_requests` are spec'd (protocol/v1/prompt-turn.md) but not yet
// observed live — covered here from the spec text.
describe('describeAcpStopReason', () => {
  test('refusal gets a distinct, emphasized label + plain explanation, no continue', () => {
    expect(describeAcpStopReason('refusal')).toEqual({
      text: 'Refused',
      emphasize: true,
      explanation: 'The model declined this request.',
      canContinue: false,
    });
  });

  test('max_tokens and max_turn_requests both get a "Truncated" affordance with a continue action', () => {
    const truncated = {
      text: 'Truncated',
      emphasize: true,
      explanation: 'The response hit its length limit.',
      canContinue: true,
    };
    expect(describeAcpStopReason('max_tokens')).toEqual(truncated);
    expect(describeAcpStopReason('max_turn_requests')).toEqual(truncated);
  });

  test('end_turn (the ordinary clean finish) renders nothing', () => {
    expect(describeAcpStopReason('end_turn')).toBeNull();
  });

  test('cancelled renders nothing — already fully communicated by the turn simply stopping', () => {
    expect(describeAcpStopReason('cancelled')).toBeNull();
  });

  test('null/undefined (no turn has finished yet) renders nothing', () => {
    expect(describeAcpStopReason(null)).toBeNull();
    expect(describeAcpStopReason(undefined)).toBeNull();
  });

  test('an unrecognized future stopReason value renders nothing rather than guessing', () => {
    expect(describeAcpStopReason('some_future_reason')).toBeNull();
  });
});
