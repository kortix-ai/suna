import { describe, expect, test } from 'bun:test';
import { markSessionRunningQuery } from './backend';

/**
 * `markSandboxUsed` runs on every proxied response. A restart and an
 * in-place recovery keep the same `external_id` and hold the sandbox row
 * `provisioning` while the box comes back. An unconditional session write
 * flipped the session row back to `running` during that window, so the sidebar
 * dot cycled yellow → green → yellow. The write must carry an EXISTS predicate
 * on the SAME sandbox row being `active`.
 *
 * The behavior is proved against Postgres in
 * `src/__tests__/integration-mark-sandbox-used-session-status.test.ts`, which
 * runs only under `scripts/test.sh integration`. These assertions pin the
 * rendered SQL in the default hermetic gate.
 */
describe('markSessionRunningQuery — running follows an active sandbox row only', () => {
  const query = markSessionRunningQuery({
    sessionId: 'session-1',
    sandboxId: '11111111-2222-4333-8444-555555555555',
    externalId: 'ext-1',
    now: new Date('2026-09-17T00:00:00.000Z'),
  }).toSQL();
  const rendered = query.sql;

  test('updates project_sessions to running for this session', () => {
    expect(rendered).toMatch(/^update "kortix"\."project_sessions" set "status" = \$1/);
    expect(rendered).toContain('"kortix"."project_sessions"."session_id" = $');
    expect(query.params).toContain('running');
    expect(query.params).toContain('session-1');
  });

  test('guards the write with EXISTS on the same sandbox row being active', () => {
    expect(rendered).toMatch(/and exists \(select .* from "kortix"\."session_sandboxes"/);
    expect(rendered).toContain('"kortix"."session_sandboxes"."sandbox_id" = $');
    expect(rendered).toContain('"kortix"."session_sandboxes"."external_id" = $');
    expect(rendered).toContain('"kortix"."session_sandboxes"."status" = $');
    expect(query.params).toContain('11111111-2222-4333-8444-555555555555');
    expect(query.params).toContain('ext-1');
    expect(query.params).toContain('active');
  });

  test('never renders an unqualified self-comparison in the correlation', () => {
    expect(rendered).not.toMatch(/"sandbox_id"\s*=\s*"sandbox_id"/);
    expect(rendered).not.toMatch(/"session_id"\s*=\s*"session_id"/);
  });
});
