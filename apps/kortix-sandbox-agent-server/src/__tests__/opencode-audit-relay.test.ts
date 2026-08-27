import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_COALESCED_EVENT_TYPES,
  DEFAULT_DROPPED_EVENT_TYPES,
  DEFAULT_FLUSH_MS,
  MAX_RELAY_BATCH_SIZE,
  MAX_RETRY_MS_DEFAULT,
  auditRelayConfigFromEnv,
  type OpenCodeAuditEvent,
  auditRelayToken,
  computeRetryDelay,
  createAuditRelay,
  retryAfterMs,
  sanitizeOpenCodeEvent,
} from '../opencode-audit-relay';

describe('OpenCode canonical audit relay', () => {
  test('uses the single session credential', () => {
    expect(auditRelayToken({ KORTIX_TOKEN: 'kortix_pat_session' })).toBe('kortix_pat_session');
    expect(auditRelayToken({})).toBeNull();
  });

  test('uses deterministic ids and never forwards prompts, credentials, or raw output', () => {
    const raw = {
      type: 'tool.execute.after',
      properties: {
        sessionID: 'ses_1',
        callID: 'call_1',
        tool: 'bash',
        path: 'https://user:password@example.test/private?token=hidden#fragment',
        args: { headers: { 'x-private-credential': 'opaque-private-value' } },
        prompt: 'private prompt body',
        output: 'sk-super-secret raw tool output',
      },
    };
    const first = sanitizeOpenCodeEvent(raw, new Date('2026-08-07T12:00:00Z'));
    const second = sanitizeOpenCodeEvent(raw, new Date('2026-08-07T13:00:00Z'));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (!first || !second) throw new Error('expected sanitizable OpenCode event');
    expect(first.event_id).toBe(second.event_id);
    expect(first.tool_call_id).toBe('call_1');
    expect(first.input_sha256).toHaveLength(64);
    expect(first.output_sha256).toHaveLength(64);
    const wire = JSON.stringify(first);
    expect(wire).not.toContain('private prompt body');
    expect(wire).not.toContain('opaque-private-value');
    expect(wire).not.toContain('raw tool output');
    expect(first.input_summary).toMatchObject({
      sessionID: 'ses_1',
      callID: 'call_1',
      tool: 'bash',
      path: 'https://example.test',
    });
  });

  test('fingerprints provider errors without persisting the raw error message', () => {
    const event = sanitizeOpenCodeEvent({
      type: 'session.error',
      properties: {
        sessionID: 'ses_error',
        error: {
          name: 'ProviderError',
          data: { message: 'provider echoed private prompt and sk-private-credential' },
        },
      },
    });
    expect(event).not.toBeNull();
    if (!event) throw new Error('expected sanitizable OpenCode event');
    expect(event.error_code).toBe('ProviderError');
    expect(event.error_message).toBeNull();
    expect(event.output_sha256).toHaveLength(64);
    expect(JSON.stringify(event)).not.toContain('private prompt');
    expect(JSON.stringify(event)).not.toContain('private-credential');
  });

  test('drops primitive structural wrappers before writing or sending an event', () => {
    const event = sanitizeOpenCodeEvent({
      type: 'message.updated',
      properties: {
        sessionID: 'ses_wrappers',
        message: 'private prompt body',
        error: 'provider echoed raw output',
        part: 'raw tool input',
        info: 'private message metadata',
      },
    });
    expect(event).not.toBeNull();
    if (!event) throw new Error('expected sanitizable OpenCode event');
    expect(event.input_summary).toEqual({ sessionID: 'ses_wrappers' });
    const persisted = JSON.stringify(event);
    expect(persisted).not.toContain('private prompt body');
    expect(persisted).not.toContain('provider echoed raw output');
    expect(persisted).not.toContain('raw tool input');
    expect(persisted).not.toContain('private message metadata');
  });

  test('classifies the real OpenCode message.part.updated tool lifecycle shape', () => {
    const event = sanitizeOpenCodeEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_root',
        part: {
          id: 'part_1',
          sessionID: 'ses_root',
          messageID: 'msg_assistant',
          type: 'tool',
          callID: 'call_1',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'private command' },
            output: 'private output',
            title: 'Ran a command',
            metadata: {},
            time: { start: 100, end: 200 },
          },
        },
        time: 200,
      },
    });
    expect(event).not.toBeNull();
    if (!event) throw new Error('expected sanitizable OpenCode event');
    expect(event).toMatchObject({
      opencode_session_id: 'ses_root',
      turn_id: 'msg_assistant',
      message_id: 'msg_assistant',
      tool_call_id: 'call_1',
      execution_id: 'call_1',
      outcome: 'success',
      phase: 'completed',
      input_summary: {
        sessionID: 'ses_root',
        part: {
          id: 'part_1',
          sessionID: 'ses_root',
          messageID: 'msg_assistant',
          type: 'tool',
          callID: 'call_1',
          tool: 'bash',
          state: { status: 'completed', time: { start: 100, end: 200 } },
        },
        time: 200,
      },
    });
    expect(event.input_sha256).toHaveLength(64);
    expect(event.output_sha256).toHaveLength(64);
    expect(JSON.stringify(event)).not.toContain('private command');
    expect(JSON.stringify(event)).not.toContain('private output');
  });

  test('extracts message identity and agent attribution from OpenCode info', () => {
    const event = sanitizeOpenCodeEvent({
      type: 'message.updated',
      properties: {
        sessionID: 'ses_child',
        info: {
          id: 'msg_child',
          sessionID: 'ses_child',
          role: 'assistant',
          parentID: 'msg_parent',
          agent: 'researcher',
          time: { created: 100, completed: 200 },
        },
      },
    });
    expect(event).toMatchObject({
      opencode_session_id: 'ses_child',
      turn_id: 'msg_child',
      message_id: 'msg_child',
      agent_id: 'researcher',
      agent_name: 'researcher',
      outcome: 'success',
      phase: 'completed',
    });
  });

  test('reloads a spool containing the real nested part, state, info, and time summaries', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortix-audit-spool-real-shape-'));
    const spoolPath = join(directory, 'events.json');
    try {
      const first = createAuditRelay(async () => {}, { flushMs: 60_000, spoolPath });
      first.enqueue({
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_real',
          part: {
            id: 'part_real',
            sessionID: 'ses_real',
            messageID: 'msg_real',
            type: 'tool',
            callID: 'call_real',
            tool: 'bash',
            state: { status: 'running', input: { command: 'private' }, time: { start: 100 } },
          },
          time: 100,
        },
      });
      await first.stop({ flush: false });
      expect(() => createAuditRelay(async () => {}, { spoolPath })).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('attributes nested sub-agent events to the root and immediate parent', async () => {
    const delivered: OpenCodeAuditEvent[][] = [];
    const relay = createAuditRelay(
      async (events) => {
        delivered.push(events);
      },
      { batchSize: 4, flushMs: 60_000 },
    );
    relay.enqueue({
      type: 'session.created',
      properties: { sessionID: 'ses_root', info: { id: 'ses_root', agent: 'root-agent' } },
    });
    relay.enqueue({
      type: 'session.created',
      properties: {
        sessionID: 'ses_child',
        info: { id: 'ses_child', parentID: 'ses_root', agent: 'researcher' },
      },
    });
    relay.enqueue({
      type: 'session.created',
      properties: {
        sessionID: 'ses_grandchild',
        info: { id: 'ses_grandchild', parentID: 'ses_child', agent: 'analyst' },
      },
    });
    relay.enqueue({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_grandchild',
        part: {
          id: 'part_nested',
          sessionID: 'ses_grandchild',
          messageID: 'msg_nested',
          type: 'tool',
          callID: 'call_nested',
          tool: 'bash',
          state: { status: 'running', input: { command: 'private' }, time: { start: 100 } },
        },
      },
    });
    await Bun.sleep(5);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.[3]).toMatchObject({
      opencode_session_id: 'ses_grandchild',
      correlation_id: 'ses_root',
      causation_id: 'ses_child',
      delegation_depth: 2,
      agent_id: 'analyst',
      agent_name: 'analyst',
    });
    await relay.stop();
  });

  test('batches events and retries the same deterministic event after failure', async () => {
    const attempts: string[][] = [];
    const relay = createAuditRelay(
      async (events) => {
        attempts.push(events.map((event) => event.event_id));
        if (attempts.length === 1) throw new Error('offline');
      },
      { batchSize: 2, flushMs: 60_000, retryMs: 60_000 },
    );
    relay.enqueue({ type: 'session.created', properties: { sessionID: 'one' } });
    relay.enqueue({ type: 'session.idle', properties: { sessionID: 'one' } });
    await Bun.sleep(5);
    expect(attempts).toHaveLength(1);
    await relay.flush();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await relay.stop();
  });

  test('recovers an unsent redacted batch from the atomic spool after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortix-audit-spool-'));
    const spoolPath = join(directory, 'events.json');
    try {
      const first = createAuditRelay(
        async () => {
          throw new Error('offline');
        },
        { flushMs: 60_000, retryMs: 60_000, spoolPath },
      );
      first.enqueue({
        type: 'tool.execute.after',
        properties: {
          sessionID: 'ses_spool',
          tool: 'bash',
          prompt: 'private prompt',
          output: 'Bearer private-credential',
        },
      });
      await expect(first.flush()).rejects.toThrow('offline');
      await first.stop({ flush: false });
      const persisted = readFileSync(spoolPath, 'utf8');
      expect(persisted).not.toContain('private prompt');
      expect(persisted).not.toContain('private-credential');

      const delivered: OpenCodeAuditEvent[][] = [];
      const recovered = createAuditRelay(
        async (events) => {
          delivered.push(events);
        },
        { flushMs: 5, spoolPath },
      );
      await Bun.sleep(20);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.[0]?.opencode_session_id).toBe('ses_spool');
      expect(JSON.parse(readFileSync(spoolPath, 'utf8'))).toMatchObject({
        version: 2,
        queue: [],
      });
      await recovered.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects a new event before replacing a full durable spool', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortix-audit-spool-capacity-'));
    const spoolPath = join(directory, 'events.json');
    try {
      const relay = createAuditRelay(async () => {}, {
        flushMs: 60_000,
        spoolPath,
        maxSpoolBytes: 1_100,
      });
      relay.enqueue({ type: 'session.created', properties: { sessionID: 'ses_kept' } });
      const persisted = readFileSync(spoolPath, 'utf8');
      expect(() =>
        relay.enqueue({
          type: 'tool.execute.after',
          properties: {
            sessionID: 'ses_rejected',
            path: 'x'.repeat(512),
          },
        }),
      ).toThrow('audit spool capacity exceeded');
      expect(readFileSync(spoolPath, 'utf8')).toBe(persisted);
      await relay.stop({ flush: false });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fails closed when a spool contains an unknown raw-content field', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortix-audit-spool-invalid-'));
    const spoolPath = join(directory, 'events.json');
    try {
      const relay = createAuditRelay(async () => {}, { flushMs: 60_000, spoolPath });
      relay.enqueue({ type: 'session.created', properties: { sessionID: 'ses_safe' } });
      await relay.stop({ flush: false });
      const spool = JSON.parse(readFileSync(spoolPath, 'utf8')) as {
        queue: Array<Record<string, unknown>>;
      };
      const queued = spool.queue[0];
      if (!queued) throw new Error('expected one queued audit event');
      queued.prompt = 'raw prompt must not be relayed';
      writeFileSync(spoolPath, JSON.stringify(spool), 'utf8');
      expect(() => createAuditRelay(async () => {}, { spoolPath })).toThrow(
        'invalid OpenCode audit spool',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('recovers lineage after the session events were delivered before restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortix-audit-spool-lineage-'));
    const spoolPath = join(directory, 'events.json');
    try {
      const first = createAuditRelay(async () => {}, { batchSize: 2, flushMs: 60_000, spoolPath });
      first.enqueue({
        type: 'session.created',
        properties: { sessionID: 'ses_root', info: { id: 'ses_root', agent: 'root' } },
      });
      first.enqueue({
        type: 'session.created',
        properties: {
          sessionID: 'ses_child',
          info: { id: 'ses_child', parentID: 'ses_root', agent: 'researcher' },
        },
      });
      await Bun.sleep(5);
      await first.stop();

      const delivered: OpenCodeAuditEvent[][] = [];
      const recovered = createAuditRelay(
        async (events) => {
          delivered.push(events);
        },
        {
          batchSize: 1,
          flushMs: 60_000,
          spoolPath,
        },
      );
      recovered.enqueue({
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_child',
          part: {
            id: 'part_after_restart',
            sessionID: 'ses_child',
            messageID: 'msg_after_restart',
            type: 'tool',
            callID: 'call_after_restart',
            tool: 'bash',
            state: { status: 'running', input: { command: 'private' } },
          },
        },
      });
      await Bun.sleep(5);
      expect(delivered[0]?.[0]).toMatchObject({
        correlation_id: 'ses_root',
        causation_id: 'ses_root',
        delegation_depth: 1,
        agent_id: 'researcher',
      });
      await recovered.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/**
 * Essentia 2026-08-26: the API returned 500 [57014] to this relay 445 times in
 * 3 hours because every audit insert for one session queues on that session's
 * `audit_session_sequences` row lock. The relay's flat 1s retry re-entered the
 * lock queue every ~11s and kept the convoy alive.
 */
describe('audit relay backoff', () => {
  const base = {
    retryMs: 1_000,
    maxRetryMs: MAX_RETRY_MS_DEFAULT,
    jitter: 0.5,
    serverRetryAfterMs: null,
  };

  test('doubles the wait for each consecutive rejection', () => {
    // jitter 0.5 => multiplier exactly 1.0, so these are the raw steps.
    expect([1, 2, 3, 4, 5].map((failures) => computeRetryDelay({ ...base, failures }))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
  });

  test('caps the wait so a recovered API is picked up promptly', () => {
    expect(computeRetryDelay({ ...base, failures: 20 })).toBe(MAX_RETRY_MS_DEFAULT);
    expect(computeRetryDelay({ ...base, failures: 200 })).toBe(MAX_RETRY_MS_DEFAULT);
  });

  test('jitters +/-25% so two sandboxes never resynchronize their retries', () => {
    expect(computeRetryDelay({ ...base, failures: 3, jitter: 0 })).toBe(3_000);
    expect(computeRetryDelay({ ...base, failures: 3, jitter: 0.999 })).toBe(4_998);
  });

  test("never undercuts the server's Retry-After", () => {
    // The 503 the API now returns for a contended session sequence lock.
    expect(computeRetryDelay({ ...base, failures: 1, serverRetryAfterMs: 5_000 })).toBe(5_000);
    // ...but a longer self-imposed backoff wins over a short server hint.
    expect(computeRetryDelay({ ...base, failures: 6, serverRetryAfterMs: 5_000 })).toBe(30_000);
  });

  test('reads Retry-After only off an error that carries it', () => {
    expect(retryAfterMs(Object.assign(new Error('503'), { retryAfterMs: 5_000 }))).toBe(5_000);
    expect(retryAfterMs(new Error('503'))).toBeNull();
    expect(retryAfterMs(Object.assign(new Error('503'), { retryAfterMs: -1 }))).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });

  test('a recovered batch resets the ladder', async () => {
    const attempts: number[] = [];
    let now = Date.now();
    let fail = true;
    const relay = createAuditRelay(
      async () => {
        attempts.push(Date.now() - now);
        if (fail) throw new Error('audit batch rejected: 503');
      },
      { batchSize: 1, flushMs: 5, retryMs: 5, maxRetryMs: 40, jitter: () => 0.5 },
    );
    relay.enqueue({ type: 'session.idle', properties: { info: { id: 'ses_a' } } });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const failedAttempts = attempts.length;
    expect(failedAttempts).toBeGreaterThan(1);

    fail = false;
    now = Date.now();
    await relay.stop();
    // The queue drains once the server recovers; nothing was dropped.
    expect(attempts.length).toBeGreaterThan(failedAttempts);
  });
});

// ---------------------------------------------------------------------------
// Emission volume. Essentia 2026-08-26: 3,395 POSTs to
// /v1/projects/:p/sessions/:s/audit/events across 20 sessions in one hour,
// 680 ms median, 2,265 s cumulative. One local session
// (08891820-0cd9-4fe7-bcfd-2431375ff75d) shows the mechanism: 117,437 relayed
// OpenCode events in 64 minutes, of which 107,394 (91.4%) are per-token
// `message.part.delta` and 384 are `server.heartbeat`. At the old
// batchSize=50 that is 4,848 POSTs for ONE session.
// ---------------------------------------------------------------------------
describe('audit relay emission volume', () => {
  const drain = () => new Promise((resolve) => setTimeout(resolve, 40));

  test('never relays a per-token stream delta or a server heartbeat', async () => {
    const sent: OpenCodeAuditEvent[][] = [];
    const relay = createAuditRelay(
      async (events) => {
        sent.push(events);
      },
      { flushMs: 5 },
    );
    for (let i = 0; i < 500; i += 1) {
      relay.enqueue({
        type: 'message.part.delta',
        properties: { sessionID: 'ses_a', messageID: 'msg_a', partID: 'prt_a', delta: `t${i}` },
      });
      relay.enqueue({ type: 'server.heartbeat', properties: { sessionID: 'ses_a' } });
    }
    relay.enqueue({ type: 'session.idle', properties: { sessionID: 'ses_a' } });
    await relay.stop();
    const flat = sent.flat();
    expect(flat.map((event) => event.type)).toEqual(['session.idle']);
    expect(relay.stats().dropped).toBe(1_000);
  });

  test('a dropped class never reaches the durable spool either', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-drop-'));
    const spoolPath = join(dir, 'spool.json');
    try {
      const relay = createAuditRelay(async () => {}, { spoolPath, flushMs: 100_000 });
      relay.enqueue({ type: 'session.created', properties: { sessionID: 'ses_a' } });
      relay.enqueue({ type: 'message.part.delta', properties: { sessionID: 'ses_a' } });
      const spool = JSON.parse(readFileSync(spoolPath, 'utf8')) as { queue: OpenCodeAuditEvent[] };
      expect(spool.queue.map((event) => event.type)).toEqual(['session.created']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('collapses repeated streaming states but never a transition', async () => {
    const sent: OpenCodeAuditEvent[][] = [];
    const relay = createAuditRelay(
      async (events) => {
        sent.push(events);
      },
      { flushMs: 100_000 },
    );
    // 400 text-part updates for ONE part: identical identity, identical phase.
    for (let i = 0; i < 400; i += 1) {
      relay.enqueue({
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_a',
          part: { id: 'prt_text', type: 'text', messageID: 'msg_a', sessionID: 'ses_a' },
          time: 1_787_043_616_510 + i,
        },
      });
    }
    // One tool part walking pending -> running -> completed. Each state is a
    // distinct forensic fact and must survive.
    for (const status of ['pending', 'running', 'completed']) {
      relay.enqueue({
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_a',
          part: {
            id: 'prt_tool',
            type: 'tool',
            callID: 'call_1',
            messageID: 'msg_a',
            state: { status },
          },
        },
      });
    }
    await relay.flush();
    const flat = sent.flat();
    const partType = (event: OpenCodeAuditEvent): unknown =>
      (event.input_summary.part as Record<string, unknown> | undefined)?.type;
    expect(flat.filter((event) => partType(event) === 'text')).toHaveLength(1);
    expect(
      flat.filter((event) => event.tool_call_id === 'call_1').map((event) => event.phase),
    ).toEqual(['pending', 'running', 'completed']);
    expect(relay.stats().coalesced).toBe(399);
  });

  test('coalescing keeps the newest state and preserves relative order', async () => {
    const sent: OpenCodeAuditEvent[][] = [];
    const relay = createAuditRelay(
      async (events) => {
        sent.push(events);
      },
      { flushMs: 100_000 },
    );
    const partUpdate = (time: number) => ({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_a',
        part: { id: 'prt_text', type: 'text', messageID: 'msg_a' },
        time,
      },
    });
    relay.enqueue(partUpdate(1));
    relay.enqueue({ type: 'permission.asked', properties: { sessionID: 'ses_a', id: 'perm_1' } });
    relay.enqueue(partUpdate(2));
    await relay.flush();
    const flat = sent.flat();
    // The superseded copy is gone; the survivor sits AFTER the permission event
    // it now post-dates, so occurred_at stays monotonic within the batch.
    expect(flat.map((event) => event.type)).toEqual([
      'permission.asked',
      'message.part.updated',
    ]);
    expect(flat[1]?.input_summary.time).toBe(2);
  });

  test('a forensic class is never coalesced', async () => {
    const sent: OpenCodeAuditEvent[][] = [];
    const relay = createAuditRelay(
      async (events) => {
        sent.push(events);
      },
      { flushMs: 100_000 },
    );
    for (let i = 0; i < 5; i += 1) {
      relay.enqueue({ type: 'permission.asked', properties: { sessionID: 'ses_a', id: 'perm_1' } });
      relay.enqueue({ type: 'file.edited', properties: { sessionID: 'ses_a', path: 'a.ts' } });
      relay.enqueue({ type: 'question.asked', properties: { sessionID: 'ses_a', id: 'q_1' } });
    }
    await relay.flush();
    expect(sent.flat()).toHaveLength(15);
    expect(relay.stats().coalesced).toBe(0);
  });

  test('defaults to one POST per 200 events, the API batch ceiling', async () => {
    const sizes: number[] = [];
    const relay = createAuditRelay(
      async (events) => {
        sizes.push(events.length);
      },
      { flushMs: 100_000 },
    );
    for (let i = 0; i < 200; i += 1) {
      relay.enqueue({ type: 'file.edited', properties: { sessionID: 'ses_a', path: `f${i}.ts` } });
    }
    await drain();
    expect(sizes).toEqual([200]);
  });

  test('a partial batch still leaves on the timer, and the timer runs from the oldest pending event', async () => {
    const at: number[] = [];
    const t0 = Date.now();
    const relay = createAuditRelay(
      async () => {
        at.push(Date.now() - t0);
      },
      { flushMs: 400 },
    );
    // A steady trickle far below batchSize, spread over 150 ms. One POST goes
    // out 400 ms after the FIRST event — not 400 ms after the last one, which
    // a steady stream could postpone forever.
    for (let i = 0; i < 6; i += 1) {
      relay.enqueue({ type: 'file.edited', properties: { sessionID: 'ses_a', path: `f${i}.ts` } });
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(at).toHaveLength(1);
    expect(at[0]).toBeGreaterThanOrEqual(380);
    expect(at[0]).toBeLessThan(560);
    await relay.stop();
    expect(relay.stats().sent).toBe(6);
  });

  test('clamps a misconfigured batch size to the API ceiling', () => {
    expect(auditRelayConfigFromEnv({ KORTIX_AUDIT_RELAY_BATCH_SIZE: '5000' }).batchSize).toBe(
      MAX_RELAY_BATCH_SIZE,
    );
    expect(auditRelayConfigFromEnv({ KORTIX_AUDIT_RELAY_BATCH_SIZE: '0' }).batchSize).toBe(
      DEFAULT_BATCH_SIZE,
    );
    expect(auditRelayConfigFromEnv({ KORTIX_AUDIT_RELAY_BATCH_SIZE: '25' }).batchSize).toBe(25);
  });

  test('batch size, cadence, drops and coalescing are all configurable', () => {
    expect(auditRelayConfigFromEnv({})).toEqual({
      batchSize: DEFAULT_BATCH_SIZE,
      flushMs: DEFAULT_FLUSH_MS,
      dropTypes: [...DEFAULT_DROPPED_EVENT_TYPES],
      coalesceTypes: [...DEFAULT_COALESCED_EVENT_TYPES],
    });
    expect(auditRelayConfigFromEnv({ KORTIX_AUDIT_RELAY_FLUSH_MS: '750' }).flushMs).toBe(750);
    // An explicitly empty list turns the filter off; unset keeps the default.
    expect(auditRelayConfigFromEnv({ KORTIX_AUDIT_RELAY_DROP_TYPES: '' }).dropTypes).toEqual([]);
    expect(
      auditRelayConfigFromEnv({ KORTIX_AUDIT_RELAY_DROP_TYPES: 'a.b, c.d' }).dropTypes,
    ).toEqual(['a.b', 'c.d']);
    expect(auditRelayConfigFromEnv({ KORTIX_AUDIT_RELAY_COALESCE: '0' }).coalesceTypes).toEqual([]);
  });

  test('replays the real Essentia-shaped event mix into ~1 POST per 200 kept events', async () => {
    // Ratios measured on kortix.audit_events for session
    // 08891820-0cd9-4fe7-bcfd-2431375ff75d (117,437 relayed events / 64 min).
    const sent: OpenCodeAuditEvent[][] = [];
    const relay = createAuditRelay(
      async (events) => {
        sent.push(events);
      },
      { flushMs: 100_000 },
    );
    let relayed = 0;
    for (let turn = 0; turn < 20; turn += 1) {
      const messageId = `msg_${turn}`;
      relay.enqueue({ type: 'message.updated', properties: { sessionID: 'ses_a', info: { id: messageId, role: 'assistant' } } });
      relayed += 1;
      for (let token = 0; token < 500; token += 1) {
        relay.enqueue({ type: 'message.part.delta', properties: { sessionID: 'ses_a', messageID: messageId, partID: 'prt_t', delta: 'x' } });
        relay.enqueue({ type: 'message.part.updated', properties: { sessionID: 'ses_a', part: { id: 'prt_t', type: 'text', messageID: messageId }, time: token } });
        relay.enqueue({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'busy' } } });
        relayed += 3;
      }
      relay.enqueue({ type: 'server.heartbeat', properties: { sessionID: 'ses_a' } });
      relay.enqueue({ type: 'session.idle', properties: { sessionID: 'ses_a' } });
      relayed += 2;
    }
    await relay.stop();
    expect(relayed).toBe(30_060);
    // Before this change: ceil(30060 / 50) = 602 POSTs.
    expect(sent.length).toBeLessThanOrEqual(3);
    expect(sent.flat().length).toBeLessThanOrEqual(200);
  });
});
