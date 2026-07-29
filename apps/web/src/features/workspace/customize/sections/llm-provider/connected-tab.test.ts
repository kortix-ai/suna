import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const connectedTabSource = readFileSync(join(import.meta.dir, 'connected-tab.tsx'), 'utf8');

describe('Connected provider actions', () => {
  test('does not expose model-dependent provider verification', () => {
    expect(connectedTabSource).not.toContain('verifyGatewayProvider');
    expect(connectedTabSource).not.toContain('Verify this key works');
    expect(connectedTabSource).not.toContain('aria-label="Verify key"');
  });

  test('keeps the provider disconnect action', () => {
    expect(connectedTabSource).toContain('deleteProjectSecret');
    expect(connectedTabSource).toContain('aria-label="Disconnect"');
  });
});
