import { describe, expect, test } from 'bun:test';
import type { AcpChatItem, AcpStoredEnvelope } from '@kortix/sdk';
import {
  acpContextGroupSummary,
  acpItemOrdinal,
  acpOrdinalTimestamps,
  acpToolGroupKind,
  acpTurnDurationMs,
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

describe('acpContextGroupSummary', () => {
  test('summarizes reads/searches/lists across a context group', () => {
    const items = [tool('t1', 'Read a.ts', 'read'), tool('t2', 'Read b.ts', 'read'), tool('t3', 'Search', 'grep')];
    expect(acpContextGroupSummary(items)).toBe('2 reads, 1 search');
  });

  test('empty group summarizes to an empty string', () => {
    expect(acpContextGroupSummary([])).toBe('');
  });
});
