import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type OpenCodeAuditEvent,
  auditRelayToken,
  createAuditRelay,
  sanitizeOpenCodeEvent,
} from '../opencode-audit-relay';

describe('OpenCode canonical audit relay', () => {
  test('uses the sandbox credential and never the session PAT', () => {
    expect(
      auditRelayToken({
        KORTIX_SANDBOX_TOKEN: 'kortix_sb_authoritative',
        KORTIX_TOKEN: 'kortix_sb_legacy',
        KORTIX_CLI_TOKEN: 'kortix_pat_must_not_be_used',
      }),
    ).toBe('kortix_sb_authoritative');
    expect(
      auditRelayToken({
        KORTIX_SANDBOX_TOKEN: undefined,
        KORTIX_TOKEN: 'kortix_sb_legacy',
        KORTIX_CLI_TOKEN: 'kortix_pat_must_not_be_used',
      }),
    ).toBe('kortix_sb_legacy');
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
