import { describe, expect, test } from 'bun:test';

import { CONNECTORS, connectorFor, connectorInitials } from './connectors-catalog';

describe('connectorFor', () => {
  test('finds a mark whose registry key drops the manifest separator', () => {
    // The SRE template declares `new_relic`; the mark is keyed `newrelic`. This
    // used to miss and render an initials tile beside real logos.
    expect(connectorFor('new_relic')).toBe(CONNECTORS.newrelic);
    expect(connectorFor('new_relic').logo).toBeTruthy();
  });

  test('an exact key still wins, and matching is case-insensitive', () => {
    expect(connectorFor('github')).toBe(CONNECTORS.github);
    expect(connectorFor('GitHub')).toBe(CONNECTORS.github);
  });

  test('an unknown app reads as a name, never as a raw slug', () => {
    expect(connectorFor('better_stack').name).toBe('Better Stack');
    expect(connectorFor('bugsnag').name).toBe('Bugsnag');
    // No mark, so the tile falls back to a monogram of that name.
    expect(connectorFor('better_stack').logo).toBeUndefined();
    expect(connectorInitials(connectorFor('better_stack'))).toBe('BS');
  });
});
