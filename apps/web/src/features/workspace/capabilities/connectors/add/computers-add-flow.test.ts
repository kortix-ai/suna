import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'computers-add-flow.tsx'), 'utf8');
const catalogSource = readFileSync(join(import.meta.dir, '../catalog/catalog-entry.ts'), 'utf8');

describe('Computers add flow discovery and pairing', () => {
  test('explains the Kortix Agent Tunnel before machine selection', () => {
    expect(source).toMatch(/Kortix\s+Agent Tunnel/);
    expect(catalogSource).toContain('Kortix Agent Tunnel');
  });

  test('can pair another computer without leaving profile setup', () => {
    expect(source).toContain('Pair another computer');
    expect(source).toContain('<ConnectCommandPanel');
  });

  test('links to fleet management for existing computer settings', () => {
    expect(source).toContain('Manage computers');
    expect(source).toContain('`/projects/${projectId}/customize/computers`');
  });
});
