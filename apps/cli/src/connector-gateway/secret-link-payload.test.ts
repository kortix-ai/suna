/**
 * What `request_secret` hands the agent. When the session's own agent will not
 * receive a requested name, the payload must say so and carry the fix — else
 * the agent later finds no env var and tells the human a saved value is unset.
 */
import { expect, test } from 'bun:test';
import { secretLinkToolPayload } from './mcp.ts';

const LINK = {
  url: 'https://app.test/secret-intake/ksl_x',
  names: ['API_KEY'],
  scope: 'runtime',
  expires_at: '2026-10-02T00:00:00.000Z',
};

test('a fully delivered runtime link carries no withheld fields', () => {
  const payload = secretLinkToolPayload(LINK);
  expect(payload).toMatchObject({ ok: true, names: ['API_KEY'], url: LINK.url });
  expect(payload.withheld).toBeUndefined();
  expect(String(payload.instructions)).toContain('check the variable itself');
});

test('a withheld name is surfaced with the fix to relay alongside the url', () => {
  const payload = secretLinkToolPayload({
    ...LINK,
    agent: 'analyst',
    withheld: [{ name: 'API_KEY', reason: 'agent_grant' }],
    withheld_fix: 'API_KEY is not in agent "analyst"\'s secrets grant. Fix: Customize.',
  });
  expect(payload.agent).toBe('analyst');
  expect(payload.withheld).toEqual([{ name: 'API_KEY', reason: 'agent_grant' }]);
  const instructions = String(payload.instructions);
  expect(instructions).toContain('This session will NOT receive API_KEY');
  expect(instructions).toContain('Fix: Customize.');
  expect(instructions).toContain('Tell the human');
});

test('a connector-scoped link keeps its server-side instructions', () => {
  const payload = secretLinkToolPayload({ ...LINK, scope: 'connector' });
  expect(String(payload.instructions)).toContain('remains server-side');
});
