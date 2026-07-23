import { describe, expect, test } from 'bun:test';

import { extractFallbackTitleFromPrompt, extractHarnessSessionTitle, isAcpPromptEnvelope } from './acp-envelope';

describe('isAcpPromptEnvelope', () => {
  test('matches only a JSON-RPC session/prompt request', () => {
    expect(isAcpPromptEnvelope({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: {} })).toBe(true);
    expect(isAcpPromptEnvelope({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} })).toBe(false);
    expect(isAcpPromptEnvelope({ jsonrpc: '2.0', method: 'session/update', params: {} })).toBe(false);
    expect(isAcpPromptEnvelope(null)).toBe(false);
  });
});

// Fixtures below are real envelope shapes pulled from `kortix.acp_session_envelopes`
// (dev DB) — see the task report for the exact query. Only claude-agent-acp's
// `session_info_update` carries a `title`; codex-acp and pi-acp send the same
// notification kind for status pings only.
describe('extractHarnessSessionTitle', () => {
  test('claude-agent-acp: extracts {title, updatedAt} from a real session_info_update', () => {
    const envelope = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'ses_0ac176ff9ffegrdaFiUZYlAMSd',
        update: {
          title: 'Reply with exactly: ACP_PONG',
          updatedAt: '2026-07-12T02:30:47.426Z',
          sessionUpdate: 'session_info_update',
        },
      },
    };
    expect(extractHarnessSessionTitle(envelope)).toEqual({
      title: 'Reply with exactly: ACP_PONG',
      updatedAt: '2026-07-12T02:30:47.426Z',
    });
  });

  test('codex-acp: session_info_update with only threadStatus carries no title', () => {
    const envelope = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          _meta: { codex: { threadStatus: { type: 'active', activeFlags: [] } } },
          sessionUpdate: 'session_info_update',
        },
      },
    };
    expect(extractHarnessSessionTitle(envelope)).toBeNull();
  });

  test('pi-acp: session_info_update with only piAcp running/queueDepth carries no title', () => {
    const envelope = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        update: {
          _meta: { piAcp: { running: true, queueDepth: 0 } },
          sessionUpdate: 'session_info_update',
        },
      },
    };
    expect(extractHarnessSessionTitle(envelope)).toBeNull();
  });

  test('a whitespace-only title is treated as absent', () => {
    const envelope = {
      method: 'session/update',
      params: { update: { title: '   ', sessionUpdate: 'session_info_update' } },
    };
    expect(extractHarnessSessionTitle(envelope)).toBeNull();
  });

  test('ignores other session/update kinds (agent_message_chunk, tool_call_update, …)', () => {
    expect(extractHarnessSessionTitle({
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', title: 'not a real title field here' } },
    })).toBeNull();
  });

  test('ignores non-session/update methods and malformed input', () => {
    expect(extractHarnessSessionTitle({ method: 'session/prompt', params: {} })).toBeNull();
    expect(extractHarnessSessionTitle(null)).toBeNull();
    expect(extractHarnessSessionTitle({ method: 'session/update', params: null })).toBeNull();
    expect(extractHarnessSessionTitle({ method: 'session/update', params: { update: null } })).toBeNull();
  });
});

describe('extractFallbackTitleFromPrompt', () => {
  test('extracts the first text block from a real session/prompt request', () => {
    const envelope = {
      id: 3,
      method: 'session/prompt',
      params: {
        prompt: [{ text: 'Reply with exactly: ACP_PONG', type: 'text' }],
        sessionId: 'ses_0ac176ff9ffegrdaFiUZYlAMSd',
      },
      jsonrpc: '2.0',
    };
    expect(extractFallbackTitleFromPrompt(envelope)).toBe('Reply with exactly: ACP_PONG');
  });

  test('collapses internal newlines/whitespace to single spaces', () => {
    const envelope = {
      method: 'session/prompt',
      params: { prompt: [{ type: 'text', text: 'fix the   bug\n\nin session-list.tsx' }] },
    };
    expect(extractFallbackTitleFromPrompt(envelope)).toBe('fix the bug in session-list.tsx');
  });

  test('truncates a long prompt on a word boundary and appends an ellipsis', () => {
    const longText = 'a'.repeat(50) + ' ' + 'b'.repeat(50);
    const envelope = { method: 'session/prompt', params: { prompt: [{ type: 'text', text: longText }] } };
    const result = extractFallbackTitleFromPrompt(envelope);
    expect(result).toBe(`${'a'.repeat(50)}…`);
    expect(result!.length).toBeLessThanOrEqual(81);
  });

  test('hard-cuts when there is no reasonable word boundary before the limit', () => {
    const longText = 'a'.repeat(100);
    const envelope = { method: 'session/prompt', params: { prompt: [{ type: 'text', text: longText }] } };
    expect(extractFallbackTitleFromPrompt(envelope)).toBe(`${'a'.repeat(80)}…`);
  });

  test('skips a leading image block to find the first text block', () => {
    const envelope = {
      method: 'session/prompt',
      params: {
        prompt: [
          { type: 'image', data: 'base64...', mimeType: 'image/png' },
          { type: 'text', text: 'what is in this screenshot?' },
        ],
      },
    };
    expect(extractFallbackTitleFromPrompt(envelope)).toBe('what is in this screenshot?');
  });

  test('an image-only / empty-text prompt yields no fallback title', () => {
    expect(extractFallbackTitleFromPrompt({
      method: 'session/prompt',
      params: { prompt: [{ type: 'image', data: 'x' }] },
    })).toBeNull();
    expect(extractFallbackTitleFromPrompt({
      method: 'session/prompt',
      params: { prompt: [{ type: 'text', text: '   ' }] },
    })).toBeNull();
  });

  test('ignores non-session/prompt methods and malformed input', () => {
    expect(extractFallbackTitleFromPrompt({ method: 'session/update', params: {} })).toBeNull();
    expect(extractFallbackTitleFromPrompt(null)).toBeNull();
    expect(extractFallbackTitleFromPrompt({ method: 'session/prompt', params: { prompt: 'not-an-array' } })).toBeNull();
  });
});
