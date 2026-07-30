import { describe, expect, test } from 'bun:test';
import { canonicalConnectorAlias } from '../projects/lib/session-connector-bindings';
import { agentMayUseConnector, canonicalizeGrantConnectors } from './agent-scope';
import { grantFromLoadedAgents } from '../projects/agents';

/**
 * A grant is compared at THREE gates that historically used three different
 * alias spellings:
 *
 *   catalog   (db-deps)  -> publicConnectorAlias(row.slug)  => "email"
 *   call gate (router)   -> raw connectorSlug               => "kortix_email"
 *   create    (sessions) -> raw caller binding key          => either
 *
 * With an exact `includes()` match, whichever spelling the manifest author
 * picked satisfied one gate and failed another: `email` made the connector
 * VISIBLE but 403'd on call; `kortix_email` made it invisible (silently skipped)
 * but callable. Both are broken, and the first is worse — it looks like it works.
 */
describe('connector alias spelling must not decide the outcome', () => {
  const publicSpelling = { agent: 'a', kortixCli: 'all' as const, connectors: ['email'] };
  const canonicalSpelling = { agent: 'a', kortixCli: 'all' as const, connectors: ['kortix_email'] };

  test('both spellings admit the connector once the grant is canonicalized', () => {
    for (const grant of [publicSpelling, canonicalSpelling]) {
      const normalized = canonicalizeGrantConnectors(grant);
      // The call gate sees the canonical slug…
      expect(agentMayUseConnector(normalized, canonicalConnectorAlias('kortix_email'))).toBe(true);
      // …and the catalog, canonicalized the same way, agrees.
      expect(agentMayUseConnector(normalized, canonicalConnectorAlias('email'))).toBe(true);
    }
  });

  test('an ungranted connector is still refused under either spelling', () => {
    const normalized = canonicalizeGrantConnectors({ agent: 'a', kortixCli: 'all' as const, connectors: ['email'] });
    expect(agentMayUseConnector(normalized, canonicalConnectorAlias('slack'))).toBe(false);
    expect(agentMayUseConnector(normalized, canonicalConnectorAlias('kortix_slack'))).toBe(false);
  });

  test("'all' and a null grant are untouched", () => {
    expect(canonicalizeGrantConnectors(null)).toBeNull();
    const all = canonicalizeGrantConnectors({ agent: 'a', kortixCli: 'all' as const, connectors: 'all' });
    expect(agentMayUseConnector(all, 'anything')).toBe(true);
  });

  test('a connector with no alias mapping passes through unchanged', () => {
    const normalized = canonicalizeGrantConnectors({ agent: 'a', kortixCli: 'all' as const, connectors: ['stripe'] });
    expect(agentMayUseConnector(normalized, canonicalConnectorAlias('stripe'))).toBe(true);
  });

  test('duplicate spellings of one connector collapse', () => {
    const normalized = canonicalizeGrantConnectors({
      agent: 'a',
      kortixCli: 'all' as const,
      connectors: ['email', 'kortix_email'],
    });
    expect(Array.isArray(normalized?.connectors) ? normalized.connectors : []).toEqual([
      'kortix_email',
    ]);
  });
});

describe('the v2 default_agent grant must canonicalize too', () => {
  // The concrete-agent branch canonicalizes with a comment saying it MUST, so
  // all three gates compare the same spelling. The v2 default_agent branch
  // returned `declared.connectors` raw — so a v2 project whose default agent
  // grants `email` had that connector silently denied at the call gate, which
  // compares the canonical `kortix_email`.
  test('a public-spelling grant on the default agent still admits the connector', () => {
    const loaded = {
      specs: [
        {
          name: 'support',
          enabled: true,
          kortixCli: 'all' as const,
          connectors: ['email', 'slack'],
          env: 'all' as const,
        },
      ],
      errors: [],
      defaultAgent: 'support',
    };
    const grant = grantFromLoadedAgents('default', loaded as never);
    expect(agentMayUseConnector(grant, canonicalConnectorAlias('email'))).toBe(true);
    expect(agentMayUseConnector(grant, canonicalConnectorAlias('kortix_email'))).toBe(true);
    expect(agentMayUseConnector(grant, canonicalConnectorAlias('slack'))).toBe(true);
  });

  test('an ungranted connector is still refused on the default agent', () => {
    const loaded = {
      specs: [
        { name: 'support', enabled: true, kortixCli: 'all' as const, connectors: ['email'], env: 'all' as const },
      ],
      errors: [],
      defaultAgent: 'support',
    };
    const grant = grantFromLoadedAgents('default', loaded as never);
    expect(agentMayUseConnector(grant, canonicalConnectorAlias('slack'))).toBe(false);
  });
});

describe('a manifest that could not be READ must not widen a grant', () => {
  // The mint resolves the grant with .catch(() => null), and null means NO
  // RESTRICTION. Combined with a synthesized blank manifest whose agent is
  // literally connectors:'all', a transient git blip could hand a governed
  // project's session a fully unrestricted token.
  test('errors present + default sentinel resolves DENY-ALL, never all-grant', () => {
    const loaded = {
      specs: [],
      errors: [{ message: 'manifest unreadable' }],
      defaultAgent: null,
    };
    const grant = grantFromLoadedAgents('default', loaded as never);
    expect(grant).not.toBeNull();
    expect(agentMayUseConnector(grant, 'kortix_email')).toBe(false);
  });

  test('a clean project with no agents section is still unrestricted (unchanged)', () => {
    // No [[agents]] and no errors = the project never adopted governance.
    expect(grantFromLoadedAgents('default', { specs: [], errors: [], defaultAgent: null } as never)).toBeNull();
  });
});
