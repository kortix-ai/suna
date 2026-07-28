import { describe, expect, test } from 'bun:test';
import type { AgentGrant } from '@kortix/db';

import { remintDecisionFor } from './session-token-grant';

const grant = (extra: Partial<AgentGrant> = {}): AgentGrant => ({
  agent: 'a',
  kortixCli: 'all',
  connectors: 'all',
  env: 'all',
  ...extra,
});

describe('remintDecisionFor', () => {
  test('an unchanged grant writes nothing', () => {
    expect(remintDecisionFor(grant(), grant())).toEqual({ action: 'skip' });
  });

  test('a project with no per-agent governance stays a no-op on both sides', () => {
    // null = unrestricted. Boot minted null too, so there is nothing to change
    // and — critically — nothing to mistake for a widening.
    expect(remintDecisionFor(null, null)).toEqual({ action: 'skip' });
  });

  test('a changed CONNECTOR grant is re-pointed — the hole this closes', () => {
    const running = grant({ agent: 'b', connectors: ['calendar'] });
    expect(remintDecisionFor(grant(), running)).toEqual({ action: 'write', grant: running });
  });

  test('a changed kortixCli grant is re-pointed too', () => {
    const running = grant({ agent: 'b', kortixCli: ['project.session.read'] });
    expect(remintDecisionFor(grant(), running)).toEqual({ action: 'write', grant: running });
  });

  test('NARROWING to a real grant is written', () => {
    const running = grant({ agent: 'b', connectors: [], kortixCli: [] });
    expect(remintDecisionFor(grant(), running)).toEqual({ action: 'write', grant: running });
  });

  test('REFUSES to blank a real grant out to unrestricted', () => {
    // Resolution returns null both for "no governance" and for "the manifest
    // could not be read". Writing null here would hand the switched-to agent
    // every connector in the account because we momentarily could not read the
    // file that says otherwise.
    const decision = remintDecisionFor(grant({ connectors: ['calendar'] }), null);
    expect(decision.action).toBe('refuse');
  });

  test('order and duplicates in a list are not a change worth writing', () => {
    expect(
      remintDecisionFor(
        grant({ connectors: ['b', 'a', 'a'] }),
        grant({ connectors: ['a', 'b'] }),
      ),
    ).toEqual({ action: 'skip' });
  });
});
