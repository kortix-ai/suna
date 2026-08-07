import { describe, expect, test } from 'bun:test';
import { parseOpenCodeAuditBatch } from './opencode-audit-ingestion';

const scope = {
  accountId: 'a7100000-0000-4000-a000-000000000001',
  projectId: 'a7200000-0000-4000-a000-000000000001',
  sessionId: 'a7300000-0000-4000-a000-000000000001',
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'a'.repeat(64),
    source_revision: 'a7100000-0000-4000-a000-000000000001',
    type: 'tool.execute.after',
    occurred_at: '2026-08-07T16:00:00.000Z',
    opencode_session_id: 'ses_test',
    message_id: 'msg_test',
    tool_call_id: 'call_test',
    execution_id: 'call_test',
    outcome: 'success',
    phase: 'completed',
    input_summary: {
      sessionID: 'ses_test',
      part: { callID: 'call_test', tool: 'bash', status: 'completed' },
    },
    output_summary: { type: 'object' },
    input_sha256: 'b'.repeat(64),
    output_sha256: 'c'.repeat(64),
    error_message: 'provider echoed a user prompt that must not persist',
    metadata: {
      event_type: 'tool.execute.after',
      property_keys: ['input', 'output', 'part'],
    },
    ...overrides,
  };
}

describe('parseOpenCodeAuditBatch', () => {
  test('binds server scope and keeps only bounded structural summaries and hashes', () => {
    const parsed = parseOpenCodeAuditBatch({ events: [event()] }, scope);
    expect(parsed.accepted).toBe(1);
    expect(parsed.values[0]).toMatchObject({
      accountId: scope.accountId,
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      actorType: 'agent',
      authoritativeSource: 'opencode',
      sourceLedger: 'opencode_events',
      sourceRecordId: 'a'.repeat(64),
      sourceRevision: 'a7100000-0000-4000-a000-000000000001',
      action: 'opencode.tool.execute.after',
      correlationId: null,
      causationId: null,
      errorMessage: null,
      inputSha256: 'b'.repeat(64),
      outputSha256: 'c'.repeat(64),
    });
  });

  test('persists root correlation, immediate causation, and delegation depth', () => {
    const parsed = parseOpenCodeAuditBatch(
      {
        events: [
          event({
            correlation_id: 'ses_root',
            causation_id: 'ses_parent',
            delegation_depth: 2,
            agent_id: 'analyst',
            agent_name: 'analyst',
          }),
        ],
      },
      scope,
    );
    expect(parsed.values[0]).toMatchObject({
      correlationId: 'ses_root',
      causationId: 'ses_parent',
      delegationDepth: 2,
      agentId: 'analyst',
      agentName: 'analyst',
    });
  });

  test('rejects prompt, argument, output, and credential-shaped summary keys', () => {
    for (const key of ['prompt', 'arguments', 'output', 'token', 'env']) {
      expect(() =>
        parseOpenCodeAuditBatch(
          { events: [event({ input_summary: { [key]: 'must-not-persist' } })] },
          scope,
        ),
      ).toThrow(`disallowed input_summary key: ${key}`);
    }
  });

  test('rejects credential-shaped values even when a compromised relay uses an allowed key', () => {
    expect(() =>
      parseOpenCodeAuditBatch(
        {
          events: [
            event({
              input_summary: {
                path: 'Bearer private-credential',
              },
            }),
          ],
        },
        scope,
      ),
    ).toThrow('credential-shaped input_summary value');
  });

  test('stores only the origin for URL-shaped summary values', () => {
    const parsed = parseOpenCodeAuditBatch(
      {
        events: [
          event({
            input_summary: {
              path: 'https://user:password@example.test/private?token=hidden#fragment',
            },
          }),
        ],
      },
      scope,
    );
    expect(parsed.values[0]?.inputSummary).toEqual({ path: 'https://example.test' });
  });

  test('rejects oversized summaries before the database write', () => {
    expect(() =>
      parseOpenCodeAuditBatch(
        { events: [event({ input_summary: { name: 'x'.repeat(513) } })] },
        scope,
      ),
    ).toThrow('oversized input_summary');
  });

  test('rejects invalid outcomes, phases, digests, and identifiers', () => {
    expect(() => parseOpenCodeAuditBatch({ events: [event({ outcome: 'maybe' })] }, scope)).toThrow(
      'invalid outcome',
    );
    expect(() =>
      parseOpenCodeAuditBatch({ events: [event({ phase: 'contains whitespace' })] }, scope),
    ).toThrow('invalid phase');
    expect(() =>
      parseOpenCodeAuditBatch({ events: [event({ input_sha256: 'bad' })] }, scope),
    ).toThrow('invalid input_sha256');
    expect(() =>
      parseOpenCodeAuditBatch(
        { events: [event({ message_id: 'not an identifier sentence' })] },
        scope,
      ),
    ).toThrow('invalid message_id');
  });

  test('requires one to 200 events', () => {
    expect(() => parseOpenCodeAuditBatch({ events: [] }, scope)).toThrow(
      'events must contain 1 to 200 items',
    );
    expect(() =>
      parseOpenCodeAuditBatch({ events: Array.from({ length: 201 }, () => event()) }, scope),
    ).toThrow('events must contain 1 to 200 items');
  });

  test('keeps repeated phases when the relay occurrence revision changes', () => {
    const first = parseOpenCodeAuditBatch({ events: [event()] }, scope).values[0];
    const second = parseOpenCodeAuditBatch(
      {
        events: [event({ source_revision: 'a7100000-0000-4000-a000-000000000002' })],
      },
      scope,
    ).values[0];
    expect(first?.sourceRecordId).toBe(second?.sourceRecordId);
    expect(first?.phase).toBe(second?.phase);
    expect(first?.sourceRevision).not.toBe(second?.sourceRevision);
  });

  test('accepts redacted actual tool state summaries and emits a semantic tool action', () => {
    const parsed = parseOpenCodeAuditBatch(
      {
        events: [
          event({
            type: 'message.part.updated',
            phase: 'running',
            outcome: 'pending',
            input_summary: {
              sessionID: 'ses_test',
              part: {
                id: 'part_test',
                sessionID: 'ses_test',
                messageID: 'msg_test',
                type: 'tool',
                callID: 'call_test',
                tool: 'bash',
                state: { status: 'running', time: { start: 100 } },
              },
              time: 100,
            },
          }),
        ],
      },
      scope,
    );
    expect(parsed.values[0]).toMatchObject({
      action: 'opencode.tool.updated',
      phase: 'running',
      outcome: 'pending',
      toolCallId: 'call_test',
    });
  });
});
