// The pure argv → payload parse of `kortix feedback`. The HTTP submit is the
// flow's job (FEEDBACK-1) and the local stack run in the PR.
import { describe, expect, test } from 'bun:test';
import { parseFeedbackInvocation } from './feedback.ts';

describe('parseFeedbackInvocation', () => {
  test('a bare message becomes kind=idea, source cli, no context', () => {
    const inv = parseFeedbackInvocation(['the CLI hangs on ls'], {});
    expect(inv).toMatchObject({
      message: 'the CLI hangs on ls',
      kind: 'idea',
      source: undefined,
      context: {},
      json: false,
    });
  });

  test('flags are parsed and stripped from the message', () => {
    const inv = parseFeedbackInvocation(
      ['--kind', 'bug', '--json', '--source', 'agent', 'the', 'gateway', 'times', 'out'],
      {},
    );
    expect(inv).toMatchObject({
      message: 'the gateway times out',
      kind: 'bug',
      source: 'agent',
      json: true,
    });
  });

  test('inside a session: the session and project ids land in the context', () => {
    const inv = parseFeedbackInvocation(['wrong message'], {
      KORTIX_SESSION_ID: 'sess-abc',
      KORTIX_PROJECT_ID: 'proj-123',
    });
    expect(inv).toMatchObject({
      context: { session_id: 'sess-abc', project_id: 'proj-123' },
    });
  });

  test('an explicit --context merges with the ambient ids', () => {
    const inv = parseFeedbackInvocation(['m', '--context', '{"sandbox_id":"sbx-1"}'], {
      KORTIX_SESSION_ID: 'sess-abc',
    });
    expect(inv).toMatchObject({
      context: { sandbox_id: 'sbx-1', session_id: 'sess-abc' },
    });
  });

  test('bad usage returns a nonzero exit code', () => {
    expect(parseFeedbackInvocation([], {})).toBeGreaterThan(0);
    expect(parseFeedbackInvocation(['m', '--kind', 'complaint'], {})).toBeGreaterThan(0);
    expect(parseFeedbackInvocation(['m', '--source', 'pigeon'], {})).toBeGreaterThan(0);
    expect(parseFeedbackInvocation(['m', '--context', '[1,2]'], {})).toBeGreaterThan(0);
    expect(parseFeedbackInvocation(['m', '--context', 'not json'], {})).toBeGreaterThan(0);
  });

  test('context values coerce to strings', () => {
    const inv = parseFeedbackInvocation(['m', '--context', '{"attempt":2}'], {});
    expect(inv).toMatchObject({ context: { attempt: '2' } });
  });
});
