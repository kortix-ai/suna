import { describe, expect, test } from 'bun:test';
import type { AcpChatItem } from '@kortix/sdk';
import { isToolPart } from '@/ui';
import { acpItemsToPanelMessages } from './acp-panel-messages';

const SID = 'runtime-session-1';

function userMsg(id: string, text = 'do it'): AcpChatItem {
  return { kind: 'message', id, role: 'user', text };
}
function assistantMsg(id: string, text = 'done'): AcpChatItem {
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

describe('acpItemsToPanelMessages', () => {
  test('empty / undefined input yields no messages', () => {
    expect(acpItemsToPanelMessages(undefined, SID)).toEqual([]);
    expect(acpItemsToPanelMessages([], SID)).toEqual([]);
  });

  test('projects a message item to a text part carrying the host session id', () => {
    const [msg] = acpItemsToPanelMessages([assistantMsg('a1', 'hi there')], SID);
    expect(msg.info.role).toBe('assistant');
    expect(msg.info.sessionID).toBe(SID);
    expect(msg.parts).toHaveLength(1);
    expect(msg.parts[0]).toMatchObject({ type: 'text', text: 'hi there', sessionID: SID });
  });

  test('a thought item becomes a reasoning part', () => {
    const [msg] = acpItemsToPanelMessages([thoughtMsg('t1', 'hmm')], SID);
    expect(msg.info.role).toBe('assistant');
    expect(msg.parts[0]).toMatchObject({ type: 'reasoning', text: 'hmm' });
  });

  test('a tool item becomes an assistant message carrying one tool part', () => {
    const [msg] = acpItemsToPanelMessages([tool('call-1', 'Read file', 'read')], SID);
    expect(msg.info.role).toBe('assistant');
    expect(msg.parts).toHaveLength(1);
    const part = msg.parts[0];
    expect(isToolPart(part)).toBe(true);
    expect(part).toMatchObject({ type: 'tool', callID: 'call-1', sessionID: SID });
  });

  test('preserves chronological order and keeps the last user message sliceable', () => {
    const messages = acpItemsToPanelMessages(
      [
        userMsg('u1'),
        tool('c1', 'Write a.ts', 'write'),
        assistantMsg('a1'),
        userMsg('u2'),
        tool('c2', 'Write b.ts', 'write'),
      ],
      SID,
    );
    // One message per item, order preserved.
    expect(messages.map((m) => m.info.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'user',
      'assistant',
    ]);
    // The last user message is the run boundary the panel's `latestRunMessages`
    // slices on — it must be findable by `info.role === 'user'`.
    const lastUserIndex = messages.map((m) => m.info.role).lastIndexOf('user');
    expect(lastUserIndex).toBe(3);
    // The tool call after it (c2) is part of the latest run.
    const latestRunToolParts = messages
      .slice(lastUserIndex)
      .flatMap((m) => m.parts)
      .filter(isToolPart);
    expect(latestRunToolParts).toHaveLength(1);
    expect(latestRunToolParts[0]).toMatchObject({ callID: 'c2' });
  });

  test('skips non-visual items (plan / permission / question / raw)', () => {
    const messages = acpItemsToPanelMessages(
      [
        { kind: 'plan', entries: [], data: {} },
        { kind: 'permission', id: 1, method: 'session/request_permission', params: {} },
        { kind: 'raw', method: 'x', data: {} },
        assistantMsg('a1'),
      ],
      SID,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].info.id).toBe('a1');
  });
});
