import { describe, expect, test } from 'bun:test';
import { handleVoiceMcp, type VoiceMcpContext } from '../channels/voice/mcp';

function ctx(overrides: Partial<VoiceMcpContext> = {}): VoiceMcpContext {
  return {
    projectId: 'proj-1',
    sessionId: 'sess-1',
    callId: 'sess-1',
    askKortix: async () => ({ ok: true }) as const,
    runCommand: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
    postTurn: async () => {},
    ...overrides,
  };
}

async function call(method: string, params?: Record<string, unknown>, c = ctx()) {
  return (await handleVoiceMcp(c, { jsonrpc: '2.0', id: 1, method, params })) as any;
}

describe('voice MCP', () => {
  test('initialize advertises tools', async () => {
    const res = await call('initialize');
    expect(res.result.serverInfo.name).toBe('kortix-voice-worker');
    expect(res.result.capabilities.tools).toBeDefined();
  });

  test('notifications/initialized returns nothing (it is a notification)', async () => {
    expect(await handleVoiceMcp(ctx(), { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  test('exposes exactly the non-blocking (or short-bounded) tool set', async () => {
    const res = await call('tools/list');
    const names = res.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(['ask_kortix', 'post_turn', 'run_command']);
    // A follow/tail/stream tool would wedge the single-threaded worker. If
    // one ever appears here, that is the bug this assertion exists to catch.
    // run_command is the one deliberate, SHORT-bounded exception (see mcp.ts).
    expect(names.some((n: string) => /follow|tail|stream|wait/.test(n))).toBe(false);
    // The old Kortix-facing MCP's `send_prompt` meant "speak into the call" —
    // the worker's own tool of the same name means "ask Kortix to work". This
    // MCP must never expose a `send_prompt` tool name, or that collision is back.
    expect(names).not.toContain('send_prompt');
  });

  test('ask_kortix queues the request and returns immediately, never propagating a slow turn', async () => {
    let seen: string | undefined;
    const c = ctx({
      askKortix: async (request) => {
        seen = request;
        return { ok: true } as const;
      },
    });
    const res = await call('tools/call', { name: 'ask_kortix', arguments: { request: 'what is the weather' } }, c);
    expect(seen).toBe('what is the weather');
    expect(res.result.isError).toBeUndefined();
    expect(res.result.structuredContent.queued).toBe(true);
  });

  test('ask_kortix requires a non-empty request', async () => {
    const res = await call('tools/call', { name: 'ask_kortix', arguments: {} });
    expect(res.result.isError).toBe(true);
  });

  test('ask_kortix surfaces a delivery failure as a tool error, not a protocol error', async () => {
    const c = ctx({ askKortix: async () => ({ ok: false, error: 'empty request' }) });
    const res = await call('tools/call', { name: 'ask_kortix', arguments: { request: 'hi' } }, c);
    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('empty request');
  });

  test('ask_kortix writes NO transcript line here — that row is the in-flight flag', async () => {
    // It used to be logged from this layer, fire-and-forget. It cannot be any
    // more: the `ask_kortix: …` row is what stops a second overlapping hand-off
    // (channels/voice/ask-ledger.ts), so it has to be written and awaited inside
    // askKortix before the next ask reads the ledger. Two rapid asks would
    // otherwise both see an empty ledger, and a hand-off that failed instantly
    // could get its settle row in BEFORE its own ask row — a permanently
    // outstanding ask. See unit-voice-recording.test.ts for the write itself.
    const seen: unknown[] = [];
    const c = ctx({
      postTurn: async (role, text, speaker) => {
        seen.push({ role, text, speaker });
      },
    });
    await call('tools/call', { name: 'ask_kortix', arguments: { request: 'what is the weather' } }, c);
    expect(seen).toEqual([]);
  });

  test('a refused ask comes back as a tool error carrying the sentence to relay', async () => {
    // apps/api refuses a second in-flight hand-off with guidance written for the
    // voice model ("you already asked — wait"), not with a fault string. It has
    // to reach the model intact, which is why it rides `isError` rather than
    // being swallowed or rewritten here.
    const c = ctx({
      askKortix: async () => ({
        ok: false,
        error: 'You already handed a request to Kortix and the answer has not come back yet.',
      }),
      postTurn: async () => {
        throw new Error('a refused ask must not be recorded as a hand-off');
      },
    });
    const res = await call('tools/call', { name: 'ask_kortix', arguments: { request: 'hi again' } }, c);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('already handed a request to Kortix');
  });

  test('the tool description tells the model there is one hand-off at a time', async () => {
    const res = await call('tools/list');
    const askKortix = res.result.tools.find((t: { name: string }) => t.name === 'ask_kortix');
    expect(askKortix.description).toContain('ONE request at a time');
    expect(askKortix.description).toContain('Do not re-send a request');
  });

  test('run_command returns stdout/stderr/exit_code/timed_out', async () => {
    const c = ctx({
      runCommand: async (command) => ({
        stdout: `ran ${command}`,
        stderr: '',
        exitCode: 0,
        timedOut: false,
      }),
    });
    const res = await call('tools/call', { name: 'run_command', arguments: { command: 'echo hi' } }, c);
    expect(res.result.structuredContent.stdout).toBe('ran echo hi');
    expect(res.result.structuredContent.exit_code).toBe(0);
    expect(res.result.structuredContent.timed_out).toBe(false);
  });

  test('run_command passes cwd through when provided', async () => {
    let seenCwd: string | undefined;
    const c = ctx({
      runCommand: async (_command, cwd) => {
        seenCwd = cwd;
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
      },
    });
    await call('tools/call', { name: 'run_command', arguments: { command: 'ls', cwd: 'src' } }, c);
    expect(seenCwd).toBe('src');
  });

  test('run_command requires a command', async () => {
    const res = await call('tools/call', { name: 'run_command', arguments: {} });
    expect(res.result.isError).toBe(true);
  });

  test('run_command surfaces a thrown error as a tool error', async () => {
    const c = ctx({
      runCommand: async () => {
        throw new Error('sandbox not ready');
      },
    });
    const res = await call('tools/call', { name: 'run_command', arguments: { command: 'echo hi' } }, c);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('sandbox not ready');
  });

  test('run_command logs a tool-role transcript line summarizing a clean exit', async () => {
    const seen: { role?: string; text?: string; speaker?: string | null }[] = [];
    const c = ctx({
      runCommand: async () => ({ stdout: 'hi', stderr: '', exitCode: 0, timedOut: false }),
      postTurn: async (role, text, speaker) => {
        seen.push({ role, text, speaker });
      },
    });
    await call('tools/call', { name: 'run_command', arguments: { command: 'echo hi' } }, c);
    expect(seen).toEqual([{ role: 'tool', text: 'run_command: echo hi → ok', speaker: 'run_command' }]);
  });

  test('run_command logs a non-zero exit and a timeout distinctly, not as "ok"', async () => {
    const seenExit: { text?: string }[] = [];
    await call(
      'tools/call',
      { name: 'run_command', arguments: { command: 'false' } },
      ctx({
        runCommand: async () => ({ stdout: '', stderr: '', exitCode: 1, timedOut: false }),
        postTurn: async (_role, text) => {
          seenExit.push({ text });
        },
      }),
    );
    expect(seenExit).toEqual([{ text: 'run_command: false → exit 1' }]);

    const seenTimeout: { text?: string }[] = [];
    await call(
      'tools/call',
      { name: 'run_command', arguments: { command: 'sleep 999' } },
      ctx({
        runCommand: async () => ({ stdout: '', stderr: '', exitCode: null, timedOut: true }),
        postTurn: async (_role, text) => {
          seenTimeout.push({ text });
        },
      }),
    );
    expect(seenTimeout).toEqual([{ text: 'run_command: sleep 999 → timed out' }]);
  });

  test('run_command logs a "failed" transcript line when the tool throws', async () => {
    const seen: { text?: string }[] = [];
    const c = ctx({
      runCommand: async () => {
        throw new Error('sandbox not ready');
      },
      postTurn: async (_role, text) => {
        seen.push({ text });
      },
    });
    await call('tools/call', { name: 'run_command', arguments: { command: 'echo hi' } }, c);
    expect(seen).toEqual([{ text: 'run_command: echo hi → failed' }]);
  });

  test('post_turn persists a turn and returns immediately', async () => {
    let seen: { role?: string; text?: string; speaker?: string | null } = {};
    const c = ctx({
      postTurn: async (role, text, speaker) => {
        seen = { role, text, speaker };
      },
    });
    const res = await call(
      'tools/call',
      { name: 'post_turn', arguments: { role: 'user', text: 'hello there', speaker: 'Alex' } },
      c,
    );
    expect(res.result.isError).toBeUndefined();
    expect(seen).toEqual({ role: 'user', text: 'hello there', speaker: 'Alex' });
  });

  test('post_turn requires role and text', async () => {
    const res = await call('tools/call', { name: 'post_turn', arguments: { role: 'agent' } });
    expect(res.result.isError).toBe(true);
  });

  test('post_turn rejects an invalid role', async () => {
    const res = await call('tools/call', { name: 'post_turn', arguments: { role: 'system', text: 'hi' } });
    expect(res.result.isError).toBe(true);
  });

  test('post_turn cannot write a tool-role line — only this file records those', async () => {
    // 'tool' rows are a record of what the worker asked KORTIX to do, written
    // by callTool below with the tool's real name and outcome. If the model
    // could post them itself, a line saying `run_command: rm -rf / → ok` would
    // be indistinguishable from one that actually ran.
    const seen: unknown[] = [];
    const c = ctx({
      postTurn: async (role, text) => {
        seen.push({ role, text });
      },
    });
    const res = await call('tools/call', { name: 'post_turn', arguments: { role: 'tool', text: 'i ran something' } }, c);
    expect(res.result.isError).toBe(true);
    expect(seen).toEqual([]);

    const list = await call('tools/list');
    const postTurn = list.result.tools.find((t: { name: string }) => t.name === 'post_turn');
    expect(postTurn.inputSchema.properties.role.enum).toEqual(['user', 'agent']);
  });

  test("every tool line names its tool and, where there is one, its outcome", async () => {
    // Requirement on the record itself: a reader must be able to tell a human
    // utterance from the agent's speech from a tool call — and for a tool call,
    // WHICH tool and how it ended.
    const seen: Array<{ role?: string; text?: string; speaker?: string | null }> = [];
    const record = ctx({
      runCommand: async () => ({ stdout: '', stderr: '', exitCode: 2, timedOut: false }),
      postTurn: async (role, text, speaker) => {
        seen.push({ role, text, speaker });
      },
    });
    await call('tools/call', { name: 'run_command', arguments: { command: 'bun test' } }, record);

    expect(seen.every((t) => t.role === 'tool')).toBe(true);
    expect(seen.map((t) => t.speaker)).toEqual(['run_command']);
    expect(seen[0]!.text).toBe('run_command: bun test → exit 2');
  });

  test('unknown tool is an error, not a crash', async () => {
    const res = await call('tools/call', { name: 'voice_follow', arguments: {} });
    expect(res.result.isError).toBe(true);
  });

  test('unknown method is a JSON-RPC method-not-found', async () => {
    const res = await call('resources/list');
    expect(res.error.code).toBe(-32601);
  });
});
