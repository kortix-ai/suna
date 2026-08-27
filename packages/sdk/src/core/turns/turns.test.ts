import { describe, expect, test } from 'bun:test';

import type {
  Message as OpencodeMessage,
  Part as OpencodePart,
  PermissionRequest as OpencodePermissionRequest,
  SessionStatus as OpencodeSessionStatus,
  ToolPart as OpencodeToolPart,
} from '../runtime/client';
import {
  COST_MARKUP,
  type MessageWithPartsLike,
  type ModelPricingLookup,
  type PartWithMessage,
  type RequestWithToolLike,
  type SessionStatusLike,
  type ToolPartLike,
  computeStatusFromPart,
  formatCost,
  getAgentCardLabel,
  getChildSessionError,
  getChildSessionId,
  getFileWithDir,
  getSessionCost,
  getToolInfo,
  getTurnCost,
  groupMessagesIntoTurns,
  stripAnsi,
} from './index';

type Extends<A, B> = A extends B ? true : false;

type _OpencodeMessageSatisfiesProtocol = Extends<
  { info: OpencodeMessage; parts: OpencodePart[] },
  MessageWithPartsLike
> extends true
  ? true
  : never;
type _OpencodeToolPartSatisfiesProtocol = Extends<OpencodeToolPart, ToolPartLike> extends true
  ? true
  : never;
type _OpencodeStatusSatisfiesProtocol = Extends<
  OpencodeSessionStatus,
  SessionStatusLike
> extends true
  ? true
  : never;
type _OpencodePermissionSatisfiesProtocol = Extends<
  OpencodePermissionRequest,
  RequestWithToolLike
> extends true
  ? true
  : never;

function userMsg(id: string, parts: MessageWithPartsLike['parts'] = []): MessageWithPartsLike {
  return { info: { id, role: 'user' }, parts };
}

function assistantMsg(
  id: string,
  parentID?: string,
  parts: MessageWithPartsLike['parts'] = [],
): MessageWithPartsLike {
  return { info: { id, role: 'assistant', parentID }, parts };
}

describe('groupMessagesIntoTurns — display order is by time.created, id is the tiebreak', () => {
  // The Essentia case (2026-08-18): a steering prompt into a child session went
  // out under a wire id minted 2 minutes in the past (the client's clock-skew
  // backdate, with no transcript to lift against). Ordered by id, that ONE
  // message teleported to the top of the thread. OpenCode stamps
  // `time.created` at persistence — the box's clock, not the client's — so
  // ordering by it degrades a bad id to slightly-odd placement at worst.
  const at = (id: string, role: 'user' | 'assistant', created: number, parentID?: string) =>
    ({ info: { id, role, parentID, time: { created } }, parts: [] }) as MessageWithPartsLike;

  test('wire ids define display order — arrival timestamps do not reorder a batch', () => {
    // OpenCode stamps `time.created` at PERSISTENCE (arrival wall-clock), and
    // a batch of queued prompts is posted concurrently — their arrival order
    // is the network's, not the user's. The wire id is the message's PLACED
    // position (the control plane lifts a stale client id before it reaches
    // the transcript), so for two wire ids the id decides. Here the batch
    // arrived scrambled (created 5000 before 1000): display follows the ids.
    const turns = groupMessagesIntoTurns([
      at('msg_000000000001first', 'user', 5_000),
      at('msg_000000000100second', 'user', 1_000),
      at('msg_000000000200reply', 'assistant', 2_000, 'msg_000000000001first'),
    ]);
    expect(turns.map((t) => t.userMessage.info.id)).toEqual([
      'msg_000000000001first',
      'msg_000000000100second',
    ]);
    expect(turns[0].assistantMessages.map((m) => m.info.id)).toEqual(['msg_000000000200reply']);
  });

  test('equal timestamps fall back to id order, so the sort is total and stable', () => {
    const turns = groupMessagesIntoTurns([
      at('msg_b', 'user', 1_000),
      at('msg_a', 'user', 1_000),
    ]);
    expect(turns.map((t) => t.userMessage.info.id)).toEqual(['msg_a', 'msg_b']);
  });

  test('a message with no timestamp sorts as newest — an optimistic stub is the latest thing', () => {
    const turns = groupMessagesIntoTurns([
      { info: { id: 'msg_0stub', role: 'user' }, parts: [] },
      at('msg_9real', 'user', 1_000),
    ]);
    expect(turns.map((t) => t.userMessage.info.id)).toEqual(['msg_9real', 'msg_0stub']);
  });

  test('sequential fallback linking follows the DISPLAY order, not the input order', () => {
    // An assistant message with no parentID attaches to the user turn that
    // precedes it in display order.
    const turns = groupMessagesIntoTurns([
      at('msg_2', 'assistant', 2_500),
      at('msg_1', 'user', 1_000),
      at('msg_3', 'user', 3_000),
    ]);
    expect(turns[0].userMessage.info.id).toBe('msg_1');
    expect(turns[0].assistantMessages.map((m) => m.info.id)).toEqual(['msg_2']);
    expect(turns[1].assistantMessages).toEqual([]);
  });
});

describe('groupMessagesIntoTurns', () => {
  test('groups assistant messages under their parent user message', () => {
    const turns = groupMessagesIntoTurns([
      userMsg('u1'),
      assistantMsg('a1', 'u1'),
      userMsg('u2'),
      assistantMsg('a2', 'u2'),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].assistantMessages.map((m) => m.info.id)).toEqual(['a1']);
    expect(turns[1].assistantMessages.map((m) => m.info.id)).toEqual(['a2']);
  });

  test('falls back to sequential ordering when parentID is absent', () => {
    const turns = groupMessagesIntoTurns([userMsg('u1'), assistantMsg('a1'), assistantMsg('a2')]);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistantMessages.map((m) => m.info.id)).toEqual(['a1', 'a2']);
  });

  test('regression: dedupes user messages sharing an id so list keys stay unique', () => {
    const optimistic = userMsg('u1');
    const reconciled = userMsg('u1');
    const turns = groupMessagesIntoTurns([
      optimistic,
      reconciled,
      assistantMsg('a1', 'u1'),
      userMsg('u2'),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.userMessage.info.id)).toEqual(['u1', 'u2']);
    expect(turns[0].userMessage).toBe(optimistic);
    expect(turns[0].assistantMessages.map((m) => m.info.id)).toEqual(['a1']);
  });

  test('regression: orphan assistant preceding every user message attaches to the FIRST turn', () => {
    const turns = groupMessagesIntoTurns([
      assistantMsg('init-failure'),
      userMsg('u1'),
      assistantMsg('a1', 'u1'),
      userMsg('u2'),
      assistantMsg('a2', 'u2'),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].assistantMessages.map((m) => m.info.id)).toEqual(['init-failure', 'a1']);
    expect(turns[1].assistantMessages.map((m) => m.info.id)).toEqual(['a2']);
  });

  test('a zero-part parentless assistant record never owns a later user prompt', () => {
    const emptyAssistant = {
      info: {
        id: 'empty-a1',
        role: 'assistant' as const,
        time: { created: 3 },
        tokens: { input: 0, output: 0, reasoning: 0 },
      },
      parts: [],
    };
    const turns = groupMessagesIntoTurns([
      { ...userMsg('u1'), info: { ...userMsg('u1').info, time: { created: 1 } } },
      { ...userMsg('u2'), info: { ...userMsg('u2').info, time: { created: 2 } } },
      emptyAssistant,
      { ...assistantMsg('a2', 'u2'), info: { ...assistantMsg('a2', 'u2').info, time: { created: 4 } } },
    ]);

    expect(turns.map((turn) => turn.assistantMessages.map((message) => message.info.id))).toEqual([
      [],
      ['a2'],
    ]);
  });

  test('creates a synthetic turn when no user messages exist at all', () => {
    const turns = groupMessagesIntoTurns([assistantMsg('a1')]);
    expect(turns).toHaveLength(1);
    expect(turns[0].userMessage.info.id).toBe('a1');
    expect(turns[0].assistantMessages).toHaveLength(0);
  });

  test('preserves the caller message type through grouping', () => {
    const messages = [userMsg('u1'), assistantMsg('a1', 'u1')].map((m, i) => ({
      ...m,
      custom: i,
    }));
    const turns = groupMessagesIntoTurns(messages);
    expect(turns[0].userMessage.custom).toBe(0);
    expect(turns[0].assistantMessages[0].custom).toBe(1);
  });
});

describe('getToolInfo agent/session tool mappings', () => {
  test('maps agent_task variants to task cards', () => {
    for (const tool of ['agent_task', 'agent-task', 'oc-agent_task', 'oc-agent-task']) {
      expect(getToolInfo(tool, { title: 'Ship it' })).toEqual({
        icon: 'check-square',
        title: 'Create Task',
        subtitle: 'Ship it',
      });
    }
    expect(getToolInfo('agent_task_update', { task_id: 't-1' }).title).toBe('Update Task');
    expect(getToolInfo('oc-agent_task_list').title).toBe('List Tasks');
    expect(getToolInfo('agent-task-get', { task_id: 't-2' }).title).toBe('Task Details');
  });

  test('maps session_spawn variants to worker cards', () => {
    for (const tool of [
      'session_spawn',
      'session-spawn',
      'session_start_background',
      'session-start-background',
      'oc-session_spawn',
      'oc-session-start-background',
    ]) {
      const info = getToolInfo(tool, { agent: 'Researcher', description: 'Dig in' });
      expect(info.icon).toBe('square-kanban');
      expect(info.title).toBe('Worker (Researcher)');
      expect(info.subtitle).toBe('Dig in');
    }
  });

  test('maps trigger tools', () => {
    expect(getToolInfo('trigger_create', { name: 'daily' })).toEqual({
      icon: 'clock',
      title: 'Create Trigger',
      subtitle: 'daily',
    });
    expect(getToolInfo('oc-trigger-list').title).toBe('List Triggers');
    expect(getToolInfo('trigger_pause', { name: 'daily' }).title).toBe('Pause Trigger');
  });

  test('supports oc- prefixed aliases for session tools', () => {
    expect(getToolInfo('oc-session_read', { mode: 'full' }).title).toBe('Session Read (full)');
    expect(getToolInfo('oc-session-search', { query: 'deploy' }).subtitle).toBe('deploy');
    expect(getToolInfo('session_context', { session_id: 'ses_abcdef123456789' }).title).toBe(
      'Session Context',
    );
  });

  test('falls back to a generic card for unknown tools', () => {
    expect(getToolInfo('mystery_tool')).toEqual({ icon: 'cpu', title: 'mystery_tool' });
  });

  test('task card subtitle falls back through description, title, prompt', () => {
    expect(getToolInfo('task', { description: 'Do the thing' }).subtitle).toBe('Do the thing');
    expect(getToolInfo('task', { title: 'Fallback title' }).subtitle).toBe('Fallback title');
    expect(getToolInfo('task', {}).subtitle).toBe('Worker task');
  });

  test('edit/write cards show filename with parent directory', () => {
    expect(getToolInfo('edit', { filePath: '/workspace/main.go' }).subtitle).toBe(
      'main.go /workspace',
    );
    expect(getToolInfo('write', { filePath: 'README.md' }).subtitle).toBe('README.md');
  });
});

describe('getAgentCardLabel', () => {
  test('prefers the first meaningful description line', () => {
    expect(getAgentCardLabel({ description: '\n  Build the API \nmore' })).toBe('Build the API');
  });

  test('walks fallbacks: title, message, prompt, agent_id, default', () => {
    expect(getAgentCardLabel({ title: 'A title' })).toBe('A title');
    expect(getAgentCardLabel({ message: 'A message' })).toBe('A message');
    expect(getAgentCardLabel({ prompt: 'A prompt' })).toBe('A prompt');
    expect(getAgentCardLabel({ agent_id: 'agent-7' })).toBe('Agent agent-7');
    expect(getAgentCardLabel({})).toBe('Worker task');
  });

  test('truncates long lines with an ellipsis', () => {
    const label = getAgentCardLabel({ description: 'x'.repeat(200) });
    expect(label.length).toBeLessThanOrEqual(121);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('getFileWithDir', () => {
  test('appends the parent directory segment', () => {
    expect(getFileWithDir('/workspace/main.go')).toBe('main.go /workspace');
    expect(getFileWithDir('a/b/c.ts')).toBe('c.ts /b');
  });

  test('returns bare filenames unchanged', () => {
    expect(getFileWithDir('main.go')).toBe('main.go');
    expect(getFileWithDir(undefined)).toBeUndefined();
  });
});

describe('computeStatusFromPart', () => {
  function toolPart(tool: string): ToolPartLike {
    return { type: 'tool', tool, callID: 'c1', state: { status: 'running' } };
  }

  test('maps agent orchestration tools to delegation status', () => {
    for (const tool of ['task', 'session_spawn', 'session-start-background', 'agent_task']) {
      expect(computeStatusFromPart(toolPart(tool))).toBe('Handing off to an agent...');
    }
  });

  test('maps task lifecycle tools', () => {
    expect(computeStatusFromPart(toolPart('task_update'))).toBe('Updating progress...');
    expect(computeStatusFromPart(toolPart('task_done'))).toBe('Updating progress...');
    expect(computeStatusFromPart(toolPart('task_create'))).toBe('Starting a new task...');
    expect(computeStatusFromPart(toolPart('agent_message'))).toBe('Checking in with an agent...');
  });

  test('maps file and command tools to plain-language labels', () => {
    expect(computeStatusFromPart(toolPart('read'))).toBe('Reading files...');
    expect(computeStatusFromPart(toolPart('grep'))).toBe('Searching files...');
    expect(computeStatusFromPart(toolPart('edit'))).toBe('Making changes...');
    expect(computeStatusFromPart(toolPart('apply_patch'))).toBe('Making changes...');
    expect(computeStatusFromPart(toolPart('bash'))).toBe('Working on the computer...');
    expect(computeStatusFromPart(toolPart('prune'))).toBe('Tidying up memory...');
    expect(computeStatusFromPart(toolPart('compress'))).toBe('Tidying up memory...');
  });

  test('falls back to a generic working label without exposing the tool name', () => {
    expect(computeStatusFromPart(toolPart('unknown_tool'))).toBe('Working on it...');
    expect(computeStatusFromPart(toolPart('mcp__server__weird_tool'))).toBe('Working on it...');
  });
});

describe('getChildSessionId', () => {
  test('reads sessionId from task tool metadata', () => {
    const part: ToolPartLike = {
      type: 'tool',
      tool: 'task',
      callID: 'c1',
      state: { status: 'running', metadata: { sessionId: 'ses_meta1' } },
    };
    expect(getChildSessionId(part)).toBe('ses_meta1');
  });

  test('falls back to title then output for agent_task tools', () => {
    const fromTitle: ToolPartLike = {
      type: 'tool',
      tool: 'agent_task',
      callID: 'c1',
      state: { status: 'running', title: 'Task in ses_title99' },
    };
    expect(getChildSessionId(fromTitle)).toBe('ses_title99');

    const fromOutput: ToolPartLike = {
      type: 'tool',
      tool: 'agent-task',
      callID: 'c2',
      state: { status: 'completed', output: 'started ses_out42' },
    };
    expect(getChildSessionId(fromOutput)).toBe('ses_out42');
  });

  test('extracts the session id from session_spawn markdown output', () => {
    const part: ToolPartLike = {
      type: 'tool',
      tool: 'session-spawn',
      callID: 'c3',
      state: { status: 'completed', output: '- **Session:** ses_spawned7' },
    };
    expect(getChildSessionId(part)).toBe('ses_spawned7');
  });

  test('returns undefined for unrelated tools', () => {
    const part: ToolPartLike = {
      type: 'tool',
      tool: 'bash',
      callID: 'c4',
      state: { status: 'completed', output: 'ses_shouldnotmatch' },
    };
    expect(getChildSessionId(part)).toBeUndefined();
  });
});

const deepseekRates = {
  inputPer1M: 0.435,
  outputPer1M: 0.87,
};

const lookup: ModelPricingLookup = (providerID, modelID) => {
  if (providerID === 'kortix' && modelID === 'deepseek-v4-pro') return deepseekRates;
  return null;
};

interface CostAssistantInfo extends MessageWithPartsLike {
  info: MessageWithPartsLike['info'] & {
    providerID?: string;
    modelID?: string;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
}

function assistantInfo(overrides: Partial<CostAssistantInfo['info']> = {}): CostAssistantInfo {
  return {
    info: {
      id: 'msg-assistant-1',
      role: 'assistant',
      providerID: 'kortix',
      modelID: 'deepseek-v4-pro',
      ...overrides,
    },
    parts: [],
  };
}

function stepFinishPart(overrides: Record<string, unknown> = {}) {
  return {
    type: 'step-finish',
    id: 'step-1',
    cost: 0,
    tokens: { input: 1_000_000, output: 0 },
    ...overrides,
  };
}

describe('getSessionCost', () => {
  test('returns zero when step-finish cost is unset and no pricing lookup is provided', () => {
    const messages = [{ ...assistantInfo(), parts: [stepFinishPart()] }];
    expect(getSessionCost(messages)).toBe(0);
  });

  test('estimates billed cost from step-finish tokens when reported cost is zero', () => {
    const messages = [
      { ...assistantInfo(), parts: [stepFinishPart({ tokens: { input: 1_000_000, output: 0 } })] },
    ];
    const raw = 1 * deepseekRates.inputPer1M;
    expect(getSessionCost(messages, lookup)).toBeCloseTo(raw * COST_MARKUP, 8);
  });

  test('uses reported step-finish cost without re-estimating from tokens', () => {
    const messages = [
      {
        ...assistantInfo(),
        parts: [stepFinishPart({ cost: 0.5, tokens: { input: 1, output: 1 } })],
      },
    ];
    expect(getSessionCost(messages, lookup)).toBeCloseTo(0.5 * COST_MARKUP, 8);
  });

  test('falls back to assistant message tokens when no step-finish parts exist', () => {
    const messages = [
      assistantInfo({
        tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ];
    const raw = 1 * deepseekRates.inputPer1M;
    expect(getSessionCost(messages, lookup)).toBeCloseTo(raw * COST_MARKUP, 8);
  });

  test('sums costs across multiple assistant messages', () => {
    const messages = [
      {
        ...assistantInfo({ id: 'a1' }),
        parts: [stepFinishPart({ id: 's1', tokens: { input: 500_000, output: 0 } })],
      },
      {
        ...assistantInfo({ id: 'a2' }),
        parts: [stepFinishPart({ id: 's2', tokens: { input: 500_000, output: 0 } })],
      },
    ];
    const raw = 1 * deepseekRates.inputPer1M;
    expect(getSessionCost(messages, lookup)).toBeCloseTo(raw * COST_MARKUP, 8);
  });

  test('regression: gateway session with tokens but step-finish.cost zero shows billed spend', () => {
    const messages = [
      {
        ...assistantInfo(),
        parts: [stepFinishPart({ cost: 0, tokens: { input: 23_330, output: 217, reasoning: 40 } })],
      },
    ];
    const raw =
      (23_330 / 1_000_000) * deepseekRates.inputPer1M +
      ((217 + 40) / 1_000_000) * deepseekRates.outputPer1M;
    const billed = getSessionCost(messages, lookup);
    expect(billed).toBeGreaterThan(0);
    expect(billed).toBeCloseTo(raw * COST_MARKUP, 8);
    expect(formatCost(billed)).not.toBe('$0.00');
  });

  test('includes reasoning tokens in output-side pricing', () => {
    const messages = [
      {
        ...assistantInfo(),
        parts: [stepFinishPart({ tokens: { input: 0, output: 0, reasoning: 1_000_000 } })],
      },
    ];
    const raw = 1 * deepseekRates.outputPer1M;
    expect(getSessionCost(messages, lookup)).toBeCloseTo(raw * COST_MARKUP, 8);
  });

  test('uses the supplied cache-write rate', () => {
    const cacheWriteLookup: ModelPricingLookup = () => ({
      inputPer1M: 1,
      outputPer1M: 4,
      cacheReadPer1M: 0.2,
      cacheWritePer1M: 1.5,
    });
    const messages = [
      {
        ...assistantInfo({ modelID: 'glm-5.2' }),
        parts: [
          stepFinishPart({
            tokens: {
              input: 1_000_000,
              output: 0,
              cache: { read: 0, write: 1_000_000 },
            },
          }),
        ],
      },
    ];
    expect(getSessionCost(messages, cacheWriteLookup)).toBeCloseTo(1.5 * COST_MARKUP, 8);
  });
});

describe('getTurnCost', () => {
  test('returns undefined when the turn has no billable usage', () => {
    expect(getTurnCost([])).toBeUndefined();
  });

  test('estimates turn cost from zero-cost step-finish parts', () => {
    const parts: PartWithMessage[] = [
      {
        part: stepFinishPart({ tokens: { input: 1_000_000, output: 0 } }),
        message: assistantInfo(),
      },
    ];
    const raw = 1 * deepseekRates.inputPer1M;
    const result = getTurnCost(parts, lookup);
    expect(result?.cost).toBeCloseTo(raw * COST_MARKUP, 8);
    expect(result?.tokens.input).toBe(1_000_000);
  });

  test('falls back to assistant tokens when step-finish parts are missing', () => {
    const parts: PartWithMessage[] = [
      {
        part: { type: 'text', id: 'text-1', text: 'hello' } as PartWithMessage['part'],
        message: assistantInfo({
          tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      },
    ];
    const raw = 1 * deepseekRates.inputPer1M;
    expect(getTurnCost(parts, lookup)?.cost).toBeCloseTo(raw * COST_MARKUP, 8);
  });
});

describe('formatCost', () => {
  test('formats sub-cent amounts with extra precision', () => {
    expect(formatCost(0.00032)).toBe('$0.0003');
    expect(formatCost(0.0032)).toBe('$0.003');
  });

  test('formats whole-cent amounts with two decimals', () => {
    expect(formatCost(2.22)).toBe('$2.22');
  });
});

describe('getChildSessionError', () => {
  function childMsg(error?: unknown): MessageWithPartsLike {
    return { info: { id: 'child-1', role: 'assistant', error }, parts: [] };
  }

  test('returns undefined for no messages', () => {
    expect(getChildSessionError(undefined)).toBeUndefined();
    expect(getChildSessionError([])).toBeUndefined();
  });

  test('returns undefined when no assistant message has an error', () => {
    expect(getChildSessionError([childMsg(), childMsg()])).toBeUndefined();
  });

  test('surfaces a sub-agent error string (e.g. free usage exceeded)', () => {
    const messages = [childMsg(), childMsg('Free usage exceeded, subscribe to Go')];
    expect(getChildSessionError(messages)).toBe('Free usage exceeded, subscribe to Go');
  });

  test('unwraps a structured error onto its message', () => {
    const messages = [childMsg({ data: { message: 'Free usage exceeded, subscribe to Go' } })];
    expect(getChildSessionError(messages)).toBe('Free usage exceeded, subscribe to Go');
  });

  test('returns the most recent error when several exist', () => {
    const messages = [childMsg('older error'), childMsg('newest error')];
    expect(getChildSessionError(messages)).toBe('newest error');
  });
});

describe('stripAnsi', () => {
  test('returns empty string for falsy input', () => {
    expect(stripAnsi('')).toBe('');
  });

  test('strips SGR color/style codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m text')).toBe('red text');
  });

  test('strips cursor-movement sequences', () => {
    expect(stripAnsi('\x1b[2J\x1b[Hhello')).toBe('hello');
  });

  test('strips a terminated OSC sequence (e.g. terminal title)', () => {
    expect(stripAnsi('before\x1b]0;window title\x07after')).toBe('beforeafter');
  });

  test('strips a terminated OSC-8 hyperlink with a realistic-length URL', () => {
    const url = `https://example.com/${'a'.repeat(200)}`;
    expect(stripAnsi(`\x1b]8;;${url}\x07link text\x1b]8;;\x07`)).toBe('link text');
  });

  test('leaves plain text untouched', () => {
    expect(stripAnsi('no escapes here')).toBe('no escapes here');
  });

  test('does not hang on a single long unterminated OSC sequence (ReDoS guard)', () => {
    const malicious = `\x1b]${'0'.repeat(50_000)}`;
    const start = performance.now();
    stripAnsi(malicious);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test('does not hang on many repeated unterminated OSC starts (ReDoS guard, /g multi-anchor)', () => {
    // str.replace with a /g regex retries the scan from every OSC start it finds;
    // without a bounded run length this is O(n^2) even though no single match is ambiguous.
    const malicious = '\x1b]'.repeat(200_000);
    const start = performance.now();
    stripAnsi(malicious);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
