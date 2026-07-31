import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'connectors-view.tsx'), 'utf8');

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
