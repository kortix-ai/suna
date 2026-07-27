/**
 * Orchestrator behaviour, with every edge faked: the semantics that decide
 * whether this feels like a client onto a cloud session or like a REST client
 * with a prompt — interrupt-the-turn-not-the-process, detach-does-not-kill,
 * queue-instead-of-gamble, and the honest ACP degradation.
 */

import { describe, expect, test } from 'bun:test';

import type { SandboxEvent } from '../api/sandbox-events.ts';
import { wantsInteractiveChat } from '../commands/chat-tui.ts';
import type { OpencodeMessageWithParts } from '../api/sandbox-proxy.ts';
import type { Renderer } from '../chat/render.ts';
import { runChatTui, type ChatTuiDeps, type StreamHandlers } from '../chat/tui.ts';
import { stripAnsi } from '../style.ts';

const OC_SESSION = 'ses_oc';

interface Rig {
  deps: ChatTuiDeps;
  committed: string[];
  appended: string[];
  tail: string[];
  calls: string[];
  submitted: string[];
  handlers: StreamHandlers | null;
  send: (chunk: string) => void;
  emit: (event: SandboxEvent) => void;
  streamOpened: number;
  streamClosed: number;
  setNow: (ms: number) => void;
  history: OpencodeMessageWithParts[];
}

function rig(
  overrides: {
    history?: OpencodeMessageWithParts[];
    env?: Record<string, string>;
    /** Replay the submitted user message on the bus while the submit call is
     *  still in flight — the race the suppression has to win. */
    echoOwnMessage?: boolean;
  } = {},
): Rig {
  const state = {
    committed: [] as string[],
    appended: [] as string[],
    tail: [] as string[],
    calls: [] as string[],
    submitted: [] as string[],
    handlers: null as StreamHandlers | null,
    streamOpened: 0,
    streamClosed: 0,
    history: overrides.history ?? [],
  };
  let onData: ((chunk: Buffer | string) => void) | null = null;
  let now = 1_000;

  const renderer: Renderer = {
    append: (text) => state.appended.push(stripAnsi(text)),
    commit: (lines) => state.committed.push(...lines.map(stripAnsi)),
    setTail: (lines) => {
      state.tail = lines.map(stripAnsi);
    },
    clearTail: () => {
      state.tail = [];
    },
    handleResize: () => {},
    bell: () => {},
  };

  const deps: ChatTuiDeps = {
    oc: {
      listMessages: async () => {
        state.calls.push('listMessages');
        return state.history;
      },
      submitPrompt: async (_sessionId, parts, _extra, _key, messageID) => {
        state.calls.push('submitPrompt');
        const text = (parts[0] as { text: string }).text;
        state.submitted.push(text);
        if (overrides.echoOwnMessage) {
          // The bus can hand our own user message back BEFORE this call
          // resolves — the id must already be suppressed by then.
          state.handlers?.onEvent({
            type: 'message.part.updated',
            properties: {
              sessionID: OC_SESSION,
              part: { id: 'pu', messageID, type: 'text', text },
            },
          });
        }
        return messageID ?? 'msg_submitted';
      },
      sendPrompt: async (_sessionId, parts) => {
        state.calls.push('sendPrompt');
        state.submitted.push((parts[0] as { text: string }).text);
        return {
          info: { id: 'm_reply', role: 'assistant' },
          parts: [{ id: 'p_reply', type: 'text', text: 'polled reply' }],
        };
      },
      abortSession: async () => {
        state.calls.push('abortSession');
        return true;
      },
      replyPermission: async (_id, reply) => {
        state.calls.push(`replyPermission:${reply}`);
        return true;
      },
      replyQuestion: async (_id, answers) => {
        state.calls.push(`replyQuestion:${JSON.stringify(answers)}`);
        return true;
      },
    },
    renderer,
    openStream: (handlers) => {
      state.streamOpened += 1;
      state.handlers = handlers;
      return {
        close: () => {
          state.streamClosed += 1;
        },
      };
    },
    attachInput: (handler) => {
      onData = handler;
      return () => {
        onData = null;
      };
    },
    onResize: () => () => {},
    select: async (opts) => opts.items[0]?.value ?? null,
    now: () => now,
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => {},
    env: (name) => overrides.env?.[name],
  };

  return {
    deps,
    get committed() {
      return state.committed;
    },
    get appended() {
      return state.appended;
    },
    get tail() {
      return state.tail;
    },
    get calls() {
      return state.calls;
    },
    get submitted() {
      return state.submitted;
    },
    get handlers() {
      return state.handlers;
    },
    get streamOpened() {
      return state.streamOpened;
    },
    get streamClosed() {
      return state.streamClosed;
    },
    history: state.history,
    send: (chunk) => onData?.(chunk),
    emit: (event) => state.handlers?.onEvent(event),
    setNow: (ms) => {
      now = ms;
    },
  } as Rig;
}

function start(r: Rig, opts: Partial<Parameters<typeof runChatTui>[0]> = {}) {
  let settled: number | null = null;
  const promise = runChatTui({
    sessionId: 'kortix-session-1',
    label: 'yo',
    agentName: 'kortix-agi',
    ocSessionId: OC_SESSION,
    verbose: false,
    transport: 'stream',
    deps: r.deps,
    ...opts,
  }).then((code) => {
    settled = code;
    return code;
  });
  return { promise, code: () => settled };
}

async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
  await Bun.sleep(1);
}

function partEvent(text: string, partId = 'p1'): SandboxEvent {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID: OC_SESSION,
      part: { id: partId, messageID: 'm1', type: 'text', text },
    },
  };
}

describe('who gets the TUI', () => {
  // This test process has piped stdio — the same shape CI, shell scripts and
  // agents invoke the CLI with. None of them may ever enter the TUI.
  test('a non-TTY never gets it, whatever the flags say', () => {
    expect(wantsInteractiveChat([])).toBe(false);
    expect(wantsInteractiveChat(['abc123'])).toBe(false);
  });

  test('--json, --prompt and --help opt out on their own', () => {
    expect(wantsInteractiveChat(['--json'])).toBe(false);
    expect(wantsInteractiveChat(['--prompt', 'hi'])).toBe(false);
    expect(wantsInteractiveChat(['-p', 'hi'])).toBe(false);
    expect(wantsInteractiveChat(['--help'])).toBe(false);
    expect(wantsInteractiveChat(['-h'])).toBe(false);
  });
});

describe('startup', () => {
  test('replays history and opens the stream BEFORE anything is sent', async () => {
    const r = rig({
      history: [
        {
          info: { id: 'm0', role: 'assistant' },
          parts: [{ id: 'p0', type: 'text', text: 'earlier' }],
        } as unknown as OpencodeMessageWithParts,
      ],
    });
    const run = start(r);
    await tick();

    expect(r.appended).toEqual(['earlier']);
    // Open BEFORE the first send, so no early event of the first turn is lost.
    expect(r.streamOpened).toBe(1);
    expect(r.calls).toEqual(['listMessages']);

    r.send('hi');
    r.send('\r');
    await tick();
    expect(r.calls).toEqual(['listMessages', 'submitPrompt']);

    r.send('\x04');
    await run.promise;
  });

  test('the header says the session outlives the terminal', async () => {
    const r = rig();
    const run = start(r);
    await tick();

    expect(r.committed.join('\n')).toContain('closing this window does not stop it');

    r.send('\x04');
    await run.promise;
  });
});

describe('streaming a turn', () => {
  test('tokens reach the screen as suffixes, never as a wall of text', async () => {
    const r = rig();
    const run = start(r);
    await tick();

    r.send('hi');
    r.send('\r');
    await tick();
    r.emit(partEvent('He'));
    r.emit(partEvent('Hello'));
    r.emit(partEvent('Hello there'));
    await tick();

    expect(r.submitted).toEqual(['hi']);
    expect(r.appended).toEqual(['He', 'llo', ' there']);

    r.send('\x04');
    await run.promise;
  });

  test('what you typed is echoed immediately, and the server copy is not doubled', async () => {
    // The echo arrives DURING the submit round trip, which is exactly when a
    // client that waited for the id to come back would print it twice.
    const r = rig({ echoOwnMessage: true });
    const run = start(r);
    await tick();

    r.send('hello agent');
    r.send('\r');
    await tick();

    expect(r.committed.filter((l) => l === '  hello agent')).toHaveLength(1);
    expect(r.appended).toEqual([]);

    r.send('\x04');
    await run.promise;
  });
});

describe('interrupt semantics', () => {
  test('Ctrl-C mid-turn aborts the TURN and keeps the client alive', async () => {
    const r = rig();
    const run = start(r);
    await tick();

    r.send('do a thing');
    r.send('\r');
    await tick();
    r.send('\x03');
    await tick();

    expect(r.calls).toContain('abortSession');
    expect(r.committed).toContain('  interrupted');
    // The process is still here — that is the whole point.
    expect(run.code()).toBeNull();

    r.send('\x04');
    await run.promise;
  });

  test('a second Ctrl-C within two seconds detaches', async () => {
    const r = rig();
    const run = start(r);
    await tick();

    r.send('work');
    r.send('\r');
    await tick();
    r.send('\x03');
    r.setNow(1_500);
    r.send('\x03');

    expect(await run.promise).toBe(0);
    expect(r.streamClosed).toBe(1);
  });

  test('Ctrl-C on an idle empty prompt asks again rather than detaching', async () => {
    const r = rig();
    const run = start(r);
    await tick();

    r.send('\x03');
    await tick();

    expect(r.committed.join('\n')).toContain('press Ctrl-C again to detach');
    expect(run.code()).toBeNull();

    r.send('\x04');
    await run.promise;
  });

  test('Ctrl-C with text typed clears the line instead of interrupting', async () => {
    const r = rig();
    const run = start(r);
    await tick();

    r.send('half written');
    r.send('\x03');
    await tick();

    expect(r.calls).not.toContain('abortSession');
    expect(r.tail.join('')).not.toContain('half written');

    r.send('\x04');
    await run.promise;
  });

  test('detaching says the work continues and how to get back', async () => {
    const r = rig();
    const run = start(r);
    await tick();

    r.send('\x04');
    await run.promise;

    const farewell = r.committed.join('\n');
    expect(farewell).toContain('kortix chat kortix-session-1');
    expect(farewell).toContain('keeps running');
  });
});

describe('queueing during a turn', () => {
  test('a message typed mid-turn is buffered and sent on idle, not gambled', async () => {
    const r = rig();
    const run = start(r);
    await tick();

    r.send('first');
    r.send('\r');
    await tick();
    r.send('second');
    r.send('\r');
    await tick();

    expect(r.submitted).toEqual(['first']);
    expect(r.tail.join(' ')).toContain('queued');

    r.emit({ type: 'session.idle', properties: { sessionID: OC_SESSION } });
    await tick();

    expect(r.submitted).toEqual(['first', 'second']);

    r.send('\x04');
    await run.promise;
  });

  test('the escape hatch sends immediately instead of queueing', async () => {
    const r = rig({ env: { KORTIX_CHAT_SEND_DURING_TURN: '1' } });
    const run = start(r);
    await tick();

    r.send('first');
    r.send('\r');
    await tick();
    r.send('second');
    r.send('\r');
    await tick();

    expect(r.submitted).toEqual(['first', 'second']);

    r.send('\x04');
    await run.promise;
  });
});

describe('connection health', () => {
  test('a gap re-reads history and appends only the unseen suffix', async () => {
    const r = rig();
    const run = start(r);
    await tick();

    r.emit(partEvent('Hel'));
    await tick();
    r.history.push({
      info: { id: 'm1', role: 'assistant' },
      parts: [{ id: 'p1', type: 'text', text: 'Hello there' }],
    } as unknown as OpencodeMessageWithParts);
    r.handlers!.onGapRehydrate(6_000);
    await tick();

    expect(r.appended).toEqual(['Hel', 'lo there']);

    r.send('\x04');
    await run.promise;
  });

  test('reconnecting is a dim status line, never an error', async () => {
    const r = rig();
    const run = start(r);
    await tick();

    r.handlers!.onReconnecting(1_000);
    await tick();

    expect(r.tail.join(' ')).toContain('reconnecting');
    expect(r.committed.join('\n')).not.toContain('reconnecting');

    r.send('\x04');
    await run.promise;
  });

  test('a parked stream tells the truth and says how to reattach', async () => {
    const r = rig();
    const run = start(r);
    await tick();

    r.handlers!.onParked();
    await tick();

    const text = r.committed.join('\n');
    expect(text).toContain('Lost the event stream');
    expect(text).toContain('still working');
    expect(text).toContain('kortix chat kortix-session-1');

    r.send('\x04');
    await run.promise;
  });
});

describe('ACP projects', () => {
  test('poll transport never opens the event bus and says so', async () => {
    const r = rig();
    const run = start(r, { transport: 'poll' });
    await tick();

    expect(r.streamOpened).toBe(0);
    expect(r.tail.join(' ')).toContain('polling');

    r.send('ping');
    r.send('\r');
    await tick();

    expect(r.calls).toContain('sendPrompt');
    expect(r.calls).not.toContain('submitPrompt');
    expect(r.appended).toContain('polled reply');

    r.send('\x04');
    await run.promise;
  });
});

describe('blocked on you', () => {
  test('a permission ask is answered inline through the existing reply call', async () => {
    const r = rig();
    const run = start(r);
    await tick();

    r.emit({
      type: 'permission.asked',
      properties: { sessionID: OC_SESSION, id: 'perm_1', permission: 'bash', patterns: ['rm *'] },
    });
    await tick();

    expect(r.calls).toContain('replyPermission:once');

    r.send('\x04');
    await run.promise;
  });

  test('a question is answered inline through the existing reply call', async () => {
    const r = rig();
    const run = start(r);
    await tick();

    r.emit({
      type: 'question.asked',
      properties: {
        sessionID: OC_SESSION,
        id: 'q_1',
        questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }],
      },
    });
    await tick();

    expect(r.calls).toContain('replyQuestion:[["A"]]');

    r.send('\x04');
    await run.promise;
  });
});

describe('event scoping', () => {
  test('another session on the same sandbox bus is ignored', async () => {
    const r = rig();
    const run = start(r);
    await tick();

    r.emit({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_someone_else',
        part: { id: 'zz', messageID: 'mz', type: 'text', text: 'not mine' },
      },
    });
    await tick();

    expect(r.appended).toEqual([]);

    r.send('\x04');
    await run.promise;
  });
});
