import { expect, test } from 'bun:test';
import type { AgentGrant } from '@kortix/db';
import { connectorDenialBody, principalMayUseConnector } from './principal-access';

const narrow: AgentGrant = {
  agent: 'release-bot',
  connectors: ['github'],
  kortixCli: [],
  env: [],
  manifestRevision: 'd'.repeat(40),
  manifestCommit: 'b'.repeat(40),
};

test('a null grant is unrestricted', () => {
  expect(principalMayUseConnector({ agentGrant: null }, 'stripe')).toBe(true);
});

test('a narrow grant denies everything it does not list', () => {
  expect(principalMayUseConnector({ agentGrant: narrow }, 'github')).toBe(true);
  expect(principalMayUseConnector({ agentGrant: narrow }, 'stripe')).toBe(false);
  expect(principalMayUseConnector({ agentGrant: { ...narrow, connectors: [] } }, 'github')).toBe(false);
});

test("the session's originating channel connector is reachable under ANY grant, and only that one", () => {
  const p = { agentGrant: { ...narrow, connectors: [] as string[] }, channelConnectorSlugs: ['kortix_slack'] };
  expect(principalMayUseConnector(p, 'kortix_slack')).toBe(true);
  expect(principalMayUseConnector(p, 'kortix_email')).toBe(false);
  expect(principalMayUseConnector(p, 'stripe')).toBe(false);
  expect(principalMayUseConnector({ agentGrant: narrow, channelConnectorSlugs: [] }, 'kortix_slack')).toBe(false);
});

test('connector_not_assigned names the agent, what it holds, and the manifest it came from', () => {
  const body = connectorDenialBody('connector_not_assigned', {
    principal: { agentGrant: narrow },
    connector: 'stripe',
    action: 'list_customers',
  });
  expect(body).toMatchObject({
    ok: false,
    status: 'denied',
    reason: 'connector_not_assigned',
    connector: 'stripe',
    action: 'list_customers',
    agent: 'release-bot',
    granted: ['github'],
    manifest_revision: 'd'.repeat(40),
    manifest_commit: 'b'.repeat(40),
  });
  expect(String(body.hint)).toContain('agents.release-bot.connectors');
});

test('each denial reason carries a stable code and a hint', () => {
  for (const reason of [
    'connector_not_found',
    'connector_not_connected',
    'connector_disabled',
    'action_not_found',
  ] as const) {
    const body = connectorDenialBody(reason, { connector: 'heyreach_api', action: 'check_api_key' });
    expect(body.reason).toBe(reason);
    expect(body.ok).toBe(false);
    expect(typeof body.hint).toBe('string');
    expect(String(body.hint).length).toBeGreaterThan(20);
  }
  expect(String(connectorDenialBody('connector_not_connected', { connector: 'heyreach_api' }).hint)).toContain(
    'kortix connectors connect heyreach_api',
  );
});
