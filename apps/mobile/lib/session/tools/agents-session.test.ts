import { describe, expect, test } from 'bun:test';

import {
  countLineageSessions,
  parseBackgroundWorkers,
  parseSessionGetOutput,
  parseSessionReadSummary,
  parseSessionReadToolEntries,
  parseSessionSearchHits,
  sessionGetHeaderArgs,
  sessionListArgs,
  sessionMessageArgs,
  sessionReadArgs,
  sessionReadModeLabel,
  shortSessionId,
} from './agents-session';

// session_get: ported from apps/web tool/tools/session-get-tool.test.tsx.

const SESSION_OUTPUT = `=== SESSION: Ship the pricing page ===
ID: ses_abc
Created: 2026-08-01 09:00
Updated: 2026-08-01 11:30
Changes: 4 files
Todos:
[completed] Draft the copy
[in_progress] Wire the checkout
Storage: 12 MB
=== CONVERSATION (18 msgs, 6 tool calls) ===
Assistant: I rewrote the hero section and pushed it.
=== COMPRESSION ===
Compressed 4 older turns.`;

describe('parseSessionGetOutput', () => {
  test('the session line, its todos, and the transcript held apart', () => {
    const parsed = parseSessionGetOutput(SESSION_OUTPUT, 'ses_input');
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe('Ship the pricing page');
    expect(parsed!.id).toBe('ses_abc');
    expect(parsed!.created).toBe('2026-08-01 09:00');
    expect(parsed!.updated).toBe('2026-08-01 11:30');
    expect(parsed!.changes).toBe('4 files');
    expect(parsed!.parent).toBeNull();
    expect(parsed!.todos).toEqual([
      { status: 'completed', text: 'Draft the copy' },
      { status: 'in_progress', text: 'Wire the checkout' },
    ]);
    expect(parsed!.msgCount).toBe('18');
    expect(parsed!.toolCount).toBe('6');
    expect(parsed!.hasConversation).toBe(true);
    expect(parsed!.conversation).toBe('Assistant: I rewrote the hero section and pushed it.');
    expect(parsed!.compression).toBe('Compressed 4 older turns.');
  });

  test('header args: msgs, tools, compressed', () => {
    expect(sessionGetHeaderArgs(parseSessionGetOutput(SESSION_OUTPUT, ''))).toEqual([
      '18 msgs',
      '6 tools',
      'compressed',
    ]);
    expect(sessionGetHeaderArgs(null)).toEqual([]);
  });

  test('no output → null; unrecognised output keeps the input id and "Unknown Session"', () => {
    expect(parseSessionGetOutput('', 'ses_x')).toBeNull();
    const parsed = parseSessionGetOutput('something else', 'ses_x');
    expect(parsed!.title).toBe('Unknown Session');
    expect(parsed!.id).toBe('ses_x');
    expect(parsed!.hasConversation).toBe(false);
  });

  test('parent line is read', () => {
    expect(parseSessionGetOutput('=== SESSION: A ===\nParent: ses_parent1\n', '')!.parent).toBe('ses_parent1');
  });
});

describe('session ids and args', () => {
  test('shortSessionId keeps ids up to 16 characters, else …last 12', () => {
    expect(shortSessionId('ses_short')).toBe('ses_short');
    expect(shortSessionId('ses_0123456789abcdefgh')).toBe('…6789abcdefgh');
  });

  test('session_message args', () => {
    expect(sessionMessageArgs('completed')).toEqual(['sent']);
    expect(sessionMessageArgs('error')).toEqual(['failed']);
    expect(sessionMessageArgs('running')).toEqual([]);
  });
});

describe('session_list', () => {
  test('parses workers', () => {
    const output = '- **ses_worker1** status: running project: web\n- **ses_worker2** status: complete project: api';
    const workers = parseBackgroundWorkers(output);
    expect(workers).toEqual([
      { id: 'ses_worker1', status: 'running', project: 'web', prompt: '' },
      { id: 'ses_worker2', status: 'complete', project: 'api', prompt: '' },
    ]);
    expect(sessionListArgs(workers.length, false)).toEqual(['2 workers']);
    expect(sessionListArgs(0, true)).toEqual(['none']);
    expect(sessionListArgs(0, false)).toEqual([]);
  });
});

describe('session_read', () => {
  const summary = '**Status:** idle\n**Agent:** kortix\n**Messages:** 12\n**Tool calls:** 3\n**Tools:** bash, read';

  test('summary fields and args', () => {
    const parsed = parseSessionReadSummary(summary);
    expect(parsed).toEqual({ status: 'idle', agent: 'kortix', messages: '12', toolCalls: '3', toolList: ['bash', 'read'] });
    expect(sessionReadArgs(parsed, 'summary', '')).toEqual(['idle', '12 msgs', '3 tools']);
    expect(sessionReadArgs(parsed, 'search', 'auth')).toEqual(['idle', '12 msgs', '3 tools', '/auth/']);
    expect(sessionReadArgs({ ...parsed!, toolCalls: '0' }, 'summary', '')).toEqual(['idle', '12 msgs']);
    expect(parseSessionReadSummary('')).toBeNull();
  });

  test('mode label defaults to summary', () => {
    expect(sessionReadModeLabel('tools')).toBe('tools');
    expect(sessionReadModeLabel('full')).toBe('full');
    expect(sessionReadModeLabel('search')).toBe('search');
    expect(sessionReadModeLabel('whatever')).toBe('summary');
  });

  test('tool entries only in tools mode', () => {
    const output = '[completed] **bash**: ls -la\n[error] **read**: /missing';
    expect(parseSessionReadToolEntries('tools', output)).toEqual([
      { at: 0, status: 'completed', tool: 'bash', summary: 'ls -la' },
      { at: 29, status: 'error', tool: 'read', summary: '/missing' },
    ]);
    expect(parseSessionReadToolEntries('summary', output)).toEqual([]);
  });
});

describe('session_search / session_lineage', () => {
  test('hits with snippets', () => {
    const output = 'ses_hit1 | "Pricing" | 2026-08-01 | score=9\nSnippet: the pricing page\nses_hit2 | "" | yesterday | score=3';
    expect(parseSessionSearchHits(output)).toEqual([
      { id: 'ses_hit1', title: 'Pricing', updated: '2026-08-01', score: '9', snippet: 'the pricing page' },
      { id: 'ses_hit2', title: '', updated: 'yesterday', score: '3', snippet: '' },
    ]);
    expect(parseSessionSearchHits('')).toEqual([]);
  });

  test('lineage counts every session id', () => {
    expect(countLineageSessions('ses_a -> ses_b -> ses_c')).toBe(3);
    expect(countLineageSessions('')).toBe(0);
  });
});
