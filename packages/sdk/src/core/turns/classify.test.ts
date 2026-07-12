import { describe, expect, test } from 'bun:test';

import type { Message, Part } from '../runtime/client';
import type { MessageWithParts } from '../../transcript';
import {
  type ClassifiedPart,
  classifyPart,
  classifyTurn,
  humanizeToolName,
  toolInfo,
} from './index';

function textPart(overrides: Partial<Part> = {}): Part {
  return {
    id: 'p1',
    sessionID: 's1',
    messageID: 'm1',
    type: 'text',
    text: 'hello',
    ...overrides,
  } as Part;
}

describe('classifyPart — exhaustive part model', () => {
  test('text', () => {
    const result = classifyPart(textPart());
    expect(result).toEqual({ kind: 'text', id: 'p1', text: 'hello', synthetic: false });
  });

  test('text with synthetic flag', () => {
    const result = classifyPart(textPart({ synthetic: true }));
    expect(result.kind).toBe('text');
    expect((result as Extract<ClassifiedPart, { kind: 'text' }>).synthetic).toBe(true);
  });

  test('reasoning', () => {
    const part = {
      id: 'p2',
      sessionID: 's1',
      messageID: 'm1',
      type: 'reasoning',
      text: 'thinking...',
      time: { start: 0 },
    } as Part;
    expect(classifyPart(part)).toEqual({ kind: 'reasoning', id: 'p2', text: 'thinking...' });
  });

  test('tool — pending', () => {
    const part = {
      id: 'p3',
      sessionID: 's1',
      messageID: 'm1',
      type: 'tool',
      callID: 'c1',
      tool: 'bash',
      state: { status: 'pending', input: { command: 'ls' }, raw: '' },
    } as Part;
    const result = classifyPart(part);
    expect(result).toEqual({
      kind: 'tool',
      id: 'p3',
      tool: { name: 'bash', title: 'Shell', status: 'pending', input: { command: 'ls' } },
    });
  });

  test('tool — running prefers the live title over the registry label', () => {
    const part = {
      id: 'p3b',
      sessionID: 's1',
      messageID: 'm1',
      type: 'tool',
      callID: 'c1',
      tool: 'bash',
      state: { status: 'running', input: {}, title: 'Running ls -la', time: { start: 0 } },
    } as Part;
    const result = classifyPart(part) as Extract<ClassifiedPart, { kind: 'tool' }>;
    expect(result.tool.status).toBe('running');
    expect(result.tool.title).toBe('Running ls -la');
  });

  test('tool — completed exposes output, not error', () => {
    const part = {
      id: 'p3c',
      sessionID: 's1',
      messageID: 'm1',
      type: 'tool',
      callID: 'c1',
      tool: 'read',
      state: {
        status: 'completed',
        input: {},
        output: 'file contents',
        title: 'Read',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    } as Part;
    const result = classifyPart(part) as Extract<ClassifiedPart, { kind: 'tool' }>;
    expect(result.tool.status).toBe('done');
    expect(result.tool.output).toBe('file contents');
    expect(result.tool.error).toBeUndefined();
  });

  test('tool — error exposes error, not output', () => {
    const part = {
      id: 'p3d',
      sessionID: 's1',
      messageID: 'm1',
      type: 'tool',
      callID: 'c1',
      tool: 'bash',
      state: { status: 'error', input: {}, error: 'command not found', time: { start: 0, end: 1 } },
    } as Part;
    const result = classifyPart(part) as Extract<ClassifiedPart, { kind: 'tool' }>;
    expect(result.tool.status).toBe('error');
    expect(result.tool.error).toBe('command not found');
    expect(result.tool.output).toBeUndefined();
  });

  test('tool — completed web_search wrapping a 402 as JSON reclassifies as error with the innermost message', () => {
    // Real prod transcript: web_search's router call failed with a 402, but
    // the tool itself catches the error and returns `state.status:
    // "completed"` with the failure serialized as its JSON *output* —
    // `{"query":"...","success":false,"error":"Error: 402 Error:
    // {\"error\":true,\"message\":\"Insufficient credits\",\"status\":402}"}`.
    // Before this fix, ToolView trusted `state.status` and rendered this as
    // a successful 'done' tool call with raw JSON garbage inside.
    const output = JSON.stringify({
      query: 'anthropic claude opus pricing',
      success: false,
      error:
        'Error: 402 Error: {"error":true,"message":"Insufficient credits","status":402}',
    });
    const part = {
      id: 'p20',
      sessionID: 's1',
      messageID: 'm1',
      type: 'tool',
      callID: 'c20',
      tool: 'web_search',
      state: {
        status: 'completed',
        input: { query: 'anthropic claude opus pricing' },
        output,
        title: 'Web Search',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    } as Part;
    const result = classifyPart(part) as Extract<ClassifiedPart, { kind: 'tool' }>;
    expect(result.tool.status).toBe('error');
    expect(result.tool.error).toBe('Insufficient credits');
    // The raw output stays available even once reclassified as an error.
    expect(result.tool.output).toBe(output);
    expect(result.tool.outputText).toBe(output);
    expect(result.tool.outputParsed).toEqual({
      query: 'anthropic claude opus pricing',
      success: false,
      error: 'Error: 402 Error: {"error":true,"message":"Insufficient credits","status":402}',
    });
  });

  test('tool — completed web_search with a top-level error object (no success flag) also reclassifies', () => {
    const output = JSON.stringify({ query: 'q', error: { message: 'Rate limited' } });
    const part = {
      id: 'p21',
      sessionID: 's1',
      messageID: 'm1',
      type: 'tool',
      callID: 'c21',
      tool: 'web_search',
      state: { status: 'completed', input: {}, output, title: 'Web Search', metadata: {}, time: { start: 0, end: 1 } },
    } as Part;
    const result = classifyPart(part) as Extract<ClassifiedPart, { kind: 'tool' }>;
    expect(result.tool.status).toBe('error');
    expect(result.tool.error).toBe('Rate limited');
  });

  test('tool — completed web_search with real results stays done, exposes outputParsed', () => {
    const output = JSON.stringify({
      query: 'kortix ai',
      success: true,
      answer: 'Kortix is an open AI command center.',
      results: [
        { title: 'Kortix', url: 'https://kortix.ai', snippet: 'The open AI command center.' },
      ],
    });
    const part = {
      id: 'p22',
      sessionID: 's1',
      messageID: 'm1',
      type: 'tool',
      callID: 'c22',
      tool: 'web_search',
      state: { status: 'completed', input: { query: 'kortix ai' }, output, title: 'Web Search', metadata: {}, time: { start: 0, end: 1 } },
    } as Part;
    const result = classifyPart(part) as Extract<ClassifiedPart, { kind: 'tool' }>;
    expect(result.tool.status).toBe('done');
    expect(result.tool.error).toBeUndefined();
    expect((result.tool.outputParsed as { success: boolean }).success).toBe(true);
  });

  test('tool — completed bash output parses to outputText but no outputParsed (plain text isn\'t JSON)', () => {
    const part = {
      id: 'p23',
      sessionID: 's1',
      messageID: 'm1',
      type: 'tool',
      callID: 'c23',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'ls -la' },
        output: 'total 0\ndrwxr-xr-x  2 me me 64 Jan 1 00:00 .',
        title: 'Shell',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    } as Part;
    const result = classifyPart(part) as Extract<ClassifiedPart, { kind: 'tool' }>;
    expect(result.tool.status).toBe('done');
    expect(result.tool.outputText).toBe('total 0\ndrwxr-xr-x  2 me me 64 Jan 1 00:00 .');
    expect(result.tool.outputParsed).toBeUndefined();
  });

  test('tool — an unparseable string output never throws and stays generic/done', () => {
    const part = {
      id: 'p24',
      sessionID: 's1',
      messageID: 'm1',
      type: 'tool',
      callID: 'c24',
      tool: 'read',
      state: {
        status: 'completed',
        input: {},
        output: '{not valid json at all',
        title: 'Read',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    } as Part;
    expect(() => classifyPart(part)).not.toThrow();
    const result = classifyPart(part) as Extract<ClassifiedPart, { kind: 'tool' }>;
    expect(result.tool.status).toBe('done');
    expect(result.tool.outputParsed).toBeUndefined();
    expect(result.tool.outputText).toBe('{not valid json at all');
  });

  test('tool — output over the parse-size cap is never JSON.parsed, even if it would parse', () => {
    // A huge but technically-valid JSON array — still must not be parsed;
    // the cap is a size circuit breaker, not a validity check.
    const hugeArray = `[${Array(80_000).fill('"x"').join(',')}]`; // > 256KB
    expect(hugeArray.length).toBeGreaterThan(256 * 1024);
    const part = {
      id: 'p25',
      sessionID: 's1',
      messageID: 'm1',
      type: 'tool',
      callID: 'c25',
      tool: 'web_search',
      state: {
        status: 'completed',
        input: {},
        output: hugeArray,
        title: 'Web Search',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    } as Part;
    const result = classifyPart(part) as Extract<ClassifiedPart, { kind: 'tool' }>;
    expect(result.tool.status).toBe('done');
    expect(result.tool.outputParsed).toBeUndefined();
    expect(result.tool.outputText).toBe(hugeArray);
  });

  test('file — image attachment', () => {
    const part = {
      id: 'p4',
      sessionID: 's1',
      messageID: 'm1',
      type: 'file',
      mime: 'image/png',
      filename: 'shot.png',
      url: 'file://shot.png',
    } as Part;
    expect(classifyPart(part)).toEqual({
      kind: 'file',
      id: 'p4',
      filename: 'shot.png',
      mime: 'image/png',
      url: 'file://shot.png',
      isImage: true,
      isPdf: false,
    });
  });

  test('file — pdf attachment', () => {
    const part = {
      id: 'p4b',
      sessionID: 's1',
      messageID: 'm1',
      type: 'file',
      mime: 'application/pdf',
      url: 'file://doc.pdf',
    } as Part;
    const result = classifyPart(part) as Extract<ClassifiedPart, { kind: 'file' }>;
    expect(result.isPdf).toBe(true);
    expect(result.isImage).toBe(false);
  });

  test('subtask', () => {
    const part = {
      id: 'p5',
      sessionID: 's1',
      messageID: 'm1',
      type: 'subtask',
      prompt: 'do the thing',
      description: 'Do the thing',
      agent: 'researcher',
    } as Part;
    expect(classifyPart(part)).toEqual({
      kind: 'subtask',
      id: 'p5',
      description: 'Do the thing',
      agent: 'researcher',
      prompt: 'do the thing',
      model: undefined,
    });
  });

  test('patch', () => {
    const part = {
      id: 'p6',
      sessionID: 's1',
      messageID: 'm1',
      type: 'patch',
      hash: 'abc123',
      files: ['a.ts', 'b.ts'],
    } as Part;
    expect(classifyPart(part)).toEqual({
      kind: 'patch',
      id: 'p6',
      hash: 'abc123',
      files: ['a.ts', 'b.ts'],
      fileCount: 2,
    });
  });

  test('snapshot', () => {
    const part = {
      id: 'p7',
      sessionID: 's1',
      messageID: 'm1',
      type: 'snapshot',
      snapshot: 'snap-1',
    } as Part;
    expect(classifyPart(part)).toEqual({ kind: 'snapshot', id: 'p7', snapshot: 'snap-1' });
  });

  test('agent', () => {
    const part = {
      id: 'p8',
      sessionID: 's1',
      messageID: 'm1',
      type: 'agent',
      name: 'kortix-worker',
    } as Part;
    expect(classifyPart(part)).toEqual({ kind: 'agent', id: 'p8', name: 'kortix-worker' });
  });

  test('retry — unwraps the structured error into a flat message', () => {
    const part = {
      id: 'p9',
      sessionID: 's1',
      messageID: 'm1',
      type: 'retry',
      attempt: 2,
      error: {
        name: 'ProviderAuthError',
        data: { providerID: 'anthropic', message: 'rate limited' },
      },
      time: { created: 1000 },
    } as unknown as Part;
    expect(classifyPart(part)).toEqual({
      kind: 'retry',
      id: 'p9',
      attempt: 2,
      message: 'rate limited',
      createdAt: 1000,
    });
  });

  test('compaction', () => {
    const part = {
      id: 'p10',
      sessionID: 's1',
      messageID: 'm1',
      type: 'compaction',
      auto: true,
      overflow: true,
      tail_start_id: 'msg-99',
    } as Part;
    expect(classifyPart(part)).toEqual({
      kind: 'compaction',
      id: 'p10',
      auto: true,
      overflow: true,
      tailStartId: 'msg-99',
    });
  });

  test('step-start', () => {
    const part = {
      id: 'p11',
      sessionID: 's1',
      messageID: 'm1',
      type: 'step-start',
      snapshot: 'snap-a',
    } as Part;
    expect(classifyPart(part)).toEqual({
      kind: 'step',
      id: 'p11',
      phase: 'start',
      snapshot: 'snap-a',
    });
  });

  test('step-finish carries cost/tokens', () => {
    const part = {
      id: 'p12',
      sessionID: 's1',
      messageID: 'm1',
      type: 'step-finish',
      reason: 'stop',
      cost: 0.02,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    } as Part;
    expect(classifyPart(part)).toEqual({
      kind: 'step',
      id: 'p12',
      phase: 'finish',
      snapshot: undefined,
      reason: 'stop',
      cost: 0.02,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    });
  });

  test('unknown — a part type not in the current union falls back gracefully at runtime', () => {
    const futurePart = {
      id: 'p13',
      sessionID: 's1',
      messageID: 'm1',
      type: 'future-thing',
    } as unknown as Part;
    const result = classifyPart(futurePart);
    expect(result.kind).toBe('unknown');
    expect((result as Extract<ClassifiedPart, { kind: 'unknown' }>).raw).toEqual(futurePart);
  });
});

function userMessage(id: string): Message {
  return {
    id,
    sessionID: 's1',
    role: 'user',
    time: { created: 0 },
    agent: 'build',
    model: { providerID: 'anthropic', modelID: 'claude' },
  } as Message;
}

function assistantMessage(id: string, overrides: Record<string, unknown> = {}): Message {
  return {
    id,
    sessionID: 's1',
    role: 'assistant',
    time: { created: 0 },
    parentID: 'u1',
    modelID: 'claude',
    providerID: 'anthropic',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  } as Message;
}

describe('classifyTurn — error normalization + isEmpty', () => {
  test('a plain text turn is not empty and has no error', () => {
    const message: MessageWithParts = {
      info: assistantMessage('a1'),
      parts: [textPart({ id: 't1' })],
    };
    const result = classifyTurn(message);
    expect(result.isEmpty).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.parts).toHaveLength(1);
  });

  test('user messages never carry an error', () => {
    const message: MessageWithParts = { info: userMessage('u1'), parts: [textPart({ id: 't1' })] };
    expect(classifyTurn(message).error).toBeUndefined();
  });

  test('regression: a failed turn with zero parts surfaces its error instead of rendering as silence', () => {
    const message: MessageWithParts = {
      info: assistantMessage('a1', {
        error: {
          name: 'ProviderAuthError',
          data: { providerID: 'anthropic', message: 'auth failed' },
        },
      }),
      parts: [],
    };
    const result = classifyTurn(message);
    expect(result.parts).toHaveLength(0);
    expect(result.error).toEqual({ name: 'ProviderAuthError', message: 'auth failed' });
    // Not "isEmpty" in the sense hosts should skip rendering — there's an error to show.
    expect(result.isEmpty).toBe(false);
  });

  test('a turn with only step markers and no error is empty', () => {
    const message: MessageWithParts = {
      info: assistantMessage('a1'),
      parts: [
        { id: 's1', sessionID: 's1', messageID: 'a1', type: 'step-start' } as Part,
        {
          id: 's2',
          sessionID: 's1',
          messageID: 'a1',
          type: 'step-finish',
          reason: 'stop',
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as Part,
      ],
    };
    expect(classifyTurn(message).isEmpty).toBe(true);
  });

  test('a turn with a whitespace-only text part is empty', () => {
    const message: MessageWithParts = {
      info: assistantMessage('a1'),
      parts: [textPart({ id: 't1', text: '   \n  ' })],
    };
    expect(classifyTurn(message).isEmpty).toBe(true);
  });

  test('a turn with a tool part is never empty, even with no text', () => {
    const message: MessageWithParts = {
      info: assistantMessage('a1'),
      parts: [
        {
          id: 'tool1',
          sessionID: 's1',
          messageID: 'a1',
          type: 'tool',
          callID: 'c1',
          tool: 'bash',
          state: { status: 'running', input: {}, time: { start: 0 } },
        } as Part,
      ],
    };
    expect(classifyTurn(message).isEmpty).toBe(false);
  });

  test('a MessageOutputLengthError (no data.message) falls back to the error name', () => {
    const message: MessageWithParts = {
      info: assistantMessage('a1', { error: { name: 'MessageOutputLengthError', data: {} } }),
      parts: [],
    };
    const result = classifyTurn(message);
    expect(result.error?.name).toBe('MessageOutputLengthError');
    expect(result.error?.message).toBe('An error occurred');
  });
});

describe('toolInfo registry', () => {
  test('maps known built-in tools', () => {
    expect(toolInfo('bash')).toEqual({ label: 'Shell', category: 'shell' });
    expect(toolInfo('read')).toEqual({ label: 'Read File', category: 'files' });
    expect(toolInfo('edit')).toEqual({ label: 'Edit File', category: 'edit' });
    expect(toolInfo('grep')).toEqual({ label: 'Search Code', category: 'search' });
    expect(toolInfo('webfetch')).toEqual({ label: 'Fetch Page', category: 'web' });
    expect(toolInfo('task')).toEqual({ label: 'Delegate to Agent', category: 'task' });
    expect(toolInfo('todowrite')).toEqual({ label: 'Plan Tasks', category: 'task' });
    expect(toolInfo('question')).toEqual({ label: 'Ask Question', category: 'task' });
  });

  test('normalizes dash and oc- prefixed variants to the same entry', () => {
    expect(toolInfo('apply_patch')).toEqual(toolInfo('apply-patch'));
    expect(toolInfo('session_spawn')).toEqual(toolInfo('oc-session_spawn'));
  });

  test('unknown tool in a known family falls back to the family category', () => {
    const result = toolInfo('agent_totally_new_thing');
    expect(result.category).toBe('task');
    expect(result.label).toBe('Agent Totally New Thing');
  });

  test('completely unknown tool humanizes the raw name with category other', () => {
    expect(toolInfo('mystery_tool')).toEqual({ label: 'Mystery Tool', category: 'other' });
  });
});

describe('humanizeToolName', () => {
  test('title-cases underscore/dash separated words', () => {
    expect(humanizeToolName('session_spawn')).toBe('Session Spawn');
    expect(humanizeToolName('oc-session-read')).toBe('Session Read');
  });
});
