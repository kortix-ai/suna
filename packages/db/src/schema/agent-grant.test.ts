import { describe, expect, test } from 'bun:test';
import { readStoredAgentGrant, type AgentGrant, type StoredAgentGrant } from '../index';

// `account_tokens.agent_grant` is JSONB. Rows written before the
// `kortixCli` → `permissions` rename carry the legacy key; every read site
// normalizes through `readStoredAgentGrant`.
describe('readStoredAgentGrant', () => {
  test('returns null for a null / undefined column', () => {
    expect(readStoredAgentGrant(null)).toBeNull();
    expect(readStoredAgentGrant(undefined)).toBeNull();
  });

  test('passes a current-shape grant through unchanged', () => {
    const grant: AgentGrant = { agent: 'a', permissions: ['project.read'], connectors: 'all', env: [] };
    expect(readStoredAgentGrant(grant)).toEqual(grant);
  });

  test('maps a legacy kortixCli row to permissions and drops the legacy key', () => {
    const legacy = { agent: 'a', kortixCli: 'all', connectors: ['github'], manifestRevision: 'abc' } as StoredAgentGrant;
    expect(readStoredAgentGrant(legacy)).toEqual({
      agent: 'a',
      permissions: 'all',
      connectors: ['github'],
      manifestRevision: 'abc',
    });
  });

  test('prefers permissions when a row carries both keys', () => {
    const both = { agent: 'a', permissions: ['project.read'], kortixCli: 'all', connectors: [] } as unknown as StoredAgentGrant;
    expect(readStoredAgentGrant(both)?.permissions).toEqual(['project.read']);
    expect('kortixCli' in (readStoredAgentGrant(both) as object)).toBe(false);
  });

  test('a row with neither key fails closed to an empty permission list', () => {
    const bare = { agent: 'a', connectors: 'all' } as unknown as StoredAgentGrant;
    expect(readStoredAgentGrant(bare)?.permissions).toEqual([]);
  });
});
