import { describe, expect, test } from 'bun:test';
import { canonicalConnectorAlias } from '../projects/lib/session-connector-bindings';
import { agentMayUseConnector, canonicalizeGrantConnectors } from './agent-scope';

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
