import { describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AuditDurabilityHealth,
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

  test('recovers an unsent redacted batch from the append-only journal after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortix-audit-spool-'));
    const spoolPath = join(directory, 'events.json');
    try {
      const attemptedRevisions: string[] = [];
      const first = createAuditRelay(
        async (events) => {
          attemptedRevisions.push(...events.map((event) => event.source_revision));
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
      expect(delivered[0]?.[0]?.source_revision).toBe(attemptedRevisions[0]);
      await recovered.stop();

      const replayed: OpenCodeAuditEvent[][] = [];
      const verifier = createAuditRelay(
        async (events) => {
          replayed.push(events);
        },
        {
          flushMs: 60_000,
          spoolPath,
        },
      );
      await verifier.flush();
      expect(replayed).toHaveLength(0);
      await verifier.stop({ flush: false });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('keeps and directly delivers an event when the local journal reaches capacity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortix-audit-spool-capacity-'));
    const spoolPath = join(directory, 'events.json');
    try {
      const delivered: OpenCodeAuditEvent[][] = [];
      const relay = createAuditRelay(
        async (events) => {
          delivered.push(events);
        },
        {
          batchSize: 2,
          flushMs: 60_000,
          spoolPath,
          maxSpoolBytes: 1_100,
        },
      );
      relay.enqueue({ type: 'session.created', properties: { sessionID: 'ses_kept' } });
      expect(() =>
        relay.enqueue({
          type: 'tool.execute.after',
          properties: {
            sessionID: 'ses_rejected',
            path: 'x'.repeat(512),
          },
        }),
      ).not.toThrow();
      expect(relay.getDurability()).toMatchObject({ status: 'degraded' });
      await Bun.sleep(5);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toHaveLength(2);
      expect(relay.getDurability()).toEqual({ status: 'ok', error: null });
      await relay.stop({ flush: false });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('ignores and truncates a partial final journal record while replaying all preceding records', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortix-audit-journal-partial-'));
    const spoolPath = join(directory, 'events.json');
    try {
      const first = createAuditRelay(async () => {}, { flushMs: 60_000, spoolPath });
      first.enqueue({ type: 'session.created', properties: { sessionID: 'ses_before_partial' } });
      await first.stop({ flush: false });
      appendFileSync(spoolPath, '{"version":3,"sequence":2');

      const delivered: OpenCodeAuditEvent[][] = [];
      const recovered = createAuditRelay(
        async (events) => {
          delivered.push(events);
        },
        {
          flushMs: 60_000,
          spoolPath,
        },
      );
      expect(readFileSync(spoolPath, 'utf8')).toEndWith('\n');
      await recovered.flush();
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.[0]?.opencode_session_id).toBe('ses_before_partial');
      await recovered.stop({ flush: false });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fails closed on a checksum mismatch in a completed journal record', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortix-audit-journal-checksum-'));
    const spoolPath = join(directory, 'events.json');
    try {
      const relay = createAuditRelay(async () => {}, { flushMs: 60_000, spoolPath });
      relay.enqueue({ type: 'session.created', properties: { sessionID: 'ses_checksum' } });
      await relay.stop({ flush: false });
      const record = JSON.parse(readFileSync(spoolPath, 'utf8')) as Record<string, unknown>;
      record.checksum = '0'.repeat(64);
      writeFileSync(spoolPath, `${JSON.stringify(record)}\n`, 'utf8');
      expect(() => createAuditRelay(async () => {}, { spoolPath })).toThrow('checksum mismatch');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('migrates V1 and V2 JSON spools into the checksummed journal without event loss', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortix-audit-journal-migrate-'));
    try {
      const event = sanitizeOpenCodeEvent({
        type: 'session.created',
        properties: { sessionID: 'ses_migrated' },
      });
      if (!event) throw new Error('expected a sanitized event');
      const { source_revision: _legacyRevision, ...v1Event } = event;
      const fixtures = [
        [v1Event],
        {
          version: 2,
          queue: [event],
          lineage: [
            {
              session_id: 'ses_migrated',
              parent_id: null,
              agent_id: 'root',
              agent_name: 'root',
            },
          ],
        },
      ];

      for (const [index, fixture] of fixtures.entries()) {
        const spoolPath = join(directory, `events-${index}.json`);
        writeFileSync(spoolPath, JSON.stringify(fixture), 'utf8');
        const delivered: OpenCodeAuditEvent[][] = [];
        const relay = createAuditRelay(
          async (events) => {
            delivered.push(events);
          },
          {
            flushMs: 60_000,
            spoolPath,
          },
        );
        const firstRecord = JSON.parse(readFileSync(spoolPath, 'utf8')) as {
          version: number;
          kind: string;
        };
        expect(firstRecord).toMatchObject({ version: 3, kind: 'snapshot' });
        await relay.flush();
        expect(delivered).toHaveLength(1);
        expect(delivered[0]?.[0]?.opencode_session_id).toBe('ses_migrated');
        expect(delivered[0]?.[0]?.source_revision).toMatch(/^[0-9a-f-]{36}$/i);
        await relay.stop({ flush: false });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('keeps an event in memory, attempts direct delivery, and recovers after local persistence returns', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortix-audit-journal-degraded-'));
    const blocker = join(directory, 'not-a-directory');
    const spoolPath = join(blocker, 'events.json');
    writeFileSync(blocker, 'block journal creation', 'utf8');
    try {
      let serverAvailable = false;
      const attempts: string[][] = [];
      const transitions: string[] = [];
      const relay = createAuditRelay(
        async (events) => {
          attempts.push(events.map((event) => event.source_revision));
          if (!serverAvailable) throw new Error('central API unavailable');
        },
        {
          batchSize: 1,
          flushMs: 60_000,
          retryMs: 60_000,
          spoolPath,
          onDurabilityChange: (health) => transitions.push(health.status),
        },
      );

      expect(() =>
        relay.enqueue({ type: 'session.created', properties: { sessionID: 'ses_degraded' } }),
      ).not.toThrow();
      await Bun.sleep(5);
      expect(attempts).toHaveLength(1);
      expect(relay.getDurability()).toMatchObject({ status: 'degraded' });

      rmSync(blocker);
      mkdirSync(blocker);
      relay.enqueue({ type: 'session.updated', properties: { sessionID: 'ses_degraded' } });
      await Bun.sleep(5);
      expect(relay.getDurability()).toEqual({ status: 'ok', error: null });
      expect(transitions).toContain('degraded');
      expect(transitions.at(-1)).toBe('ok');
      await relay.stop({ flush: false });

      serverAvailable = true;
      const replayed: OpenCodeAuditEvent[][] = [];
      const recovered = createAuditRelay(
        async (events) => {
          replayed.push(events);
        },
        { batchSize: 10, flushMs: 60_000, spoolPath },
      );
      await recovered.flush();
      expect(replayed).toHaveLength(1);
      expect(replayed[0]).toHaveLength(2);
      expect(replayed[0]?.[0]?.source_revision).toBe(attempts[0]?.[0]);
      await recovered.stop({ flush: false });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('tracks memory-only durability across direct delivery failure and recovery', async () => {
    let serverAvailable = false;
    const durability: AuditDurabilityHealth[] = [];
    const relay = createAuditRelay(
      async () => {
        if (!serverAvailable) throw new Error('central API unavailable');
      },
      {
        batchSize: 1,
        retryMs: 60_000,
        initialDurabilityError: 'journal checksum mismatch',
        onDurabilityChange: (health) => durability.push(health),
      },
    );

    relay.enqueue({ type: 'session.updated', properties: { sessionID: 'ses_memory_only' } });
    await Bun.sleep(5);
    expect(relay.getDurability()).toEqual({
      status: 'degraded',
      error: 'central API unavailable',
    });

    serverAvailable = true;
    await relay.flush();
    expect(relay.getDurability()).toEqual({ status: 'ok', error: null });
    expect(durability.at(0)).toEqual({
      status: 'degraded',
      error: 'journal checksum mismatch',
    });
    expect(durability.at(-1)).toEqual({ status: 'ok', error: null });
    await relay.stop({ flush: false });
  });

  test('compaction preserves the pending queue and session lineage across restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortix-audit-journal-compact-'));
    const spoolPath = join(directory, 'events.json');
    try {
      const first = createAuditRelay(async () => {}, {
        batchSize: 100,
        flushMs: 60_000,
        spoolPath,
        compactAfterBytes: 1,
      });
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
      await first.stop({ flush: false });

      const delivered: OpenCodeAuditEvent[][] = [];
      const recovered = createAuditRelay(
        async (events) => {
          delivered.push(events);
        },
        {
          batchSize: 100,
          flushMs: 60_000,
          spoolPath,
          compactAfterBytes: 1,
        },
      );
      recovered.enqueue({
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_child',
          part: {
            id: 'part_after_compaction',
            sessionID: 'ses_child',
            messageID: 'msg_after_compaction',
            type: 'tool',
            callID: 'call_after_compaction',
            tool: 'bash',
            state: { status: 'running', input: { command: 'private' } },
          },
        },
      });
      await recovered.flush();
      expect(delivered[0]).toHaveLength(3);
      expect(delivered[0]?.[2]).toMatchObject({
        correlation_id: 'ses_root',
        causation_id: 'ses_root',
        delegation_depth: 1,
        agent_id: 'researcher',
      });
      await recovered.stop({ flush: false });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fails closed when a spool contains an unknown raw-content field', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kortix-audit-spool-invalid-'));
    const spoolPath = join(directory, 'events.json');
    try {
      const event = sanitizeOpenCodeEvent({
        type: 'session.created',
        properties: { sessionID: 'ses_safe' },
      });
      if (!event) throw new Error('expected a sanitized event');
      writeFileSync(
        spoolPath,
        JSON.stringify({
          version: 2,
          queue: [{ ...event, prompt: 'raw prompt must not be relayed' }],
          lineage: [],
        }),
        'utf8',
      );
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
