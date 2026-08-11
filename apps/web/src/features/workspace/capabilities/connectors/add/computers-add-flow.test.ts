import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'computers-add-flow.tsx'), 'utf8');
const catalogSource = readFileSync(join(import.meta.dir, '../catalog/catalog-entry.ts'), 'utf8');

describe('Computer Tunnel add flow discovery and pairing', () => {
  test('explains the dosco Agent Tunnel before machine selection', () => {
    expect(source).toMatch(/dosco\s+Agent Tunnel/);
    expect(catalogSource).toContain('dosco Agent Tunnel');
  });

  test('uses the canonical tunnel manager without leaving profile setup', () => {
    expect(source).toContain('<ComputerTunnelManager');
    expect(source).toContain('Pair, inspect, and select');
  });

  test('contains no duplicate fleet-management detour', () => {
    expect(source).not.toContain('Manage computers');
    expect(source).not.toContain('/customize/computers');
  });
});
