import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The connector-level (not connection-level) policy controls this test guards
// no longer live in `connectors-view.tsx` — that file's `PermissionsSection`
// was the legacy master-detail shell (0 importers, unreachable from the live
// route) and was deleted as dead code. The live replacement is
// `connector-tools.tsx`, mounted from the reachable `connectors-page.tsx`
// route; that is what still calls `getConnectorPolicies`/`setConnectorPolicies`.
const source = readFileSync(
  join(import.meta.dir, '../../capabilities/connectors/detail/connector-tools.tsx'),
  'utf8',
);

describe('connector authorization policy ownership', () => {
  test('does not expose authorization-specific policy controls', () => {
    expect(source).toContain('getConnectorPolicies');
    expect(source).toContain('setConnectorPolicies');
    expect(source).not.toContain('getConnectionPolicies');
    expect(source).not.toContain('setConnectionPolicies');
    expect(source).not.toContain('Permissions for this connection');
    expect(source).not.toContain('ConnectionPermissionsModal');
  });
});
