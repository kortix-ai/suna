import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dir;

describe('connector detail layout', () => {
  test('keeps the primary action outside the collapsed technical disclosure', () => {
    const layout = readFileSync(join(here, 'connector-detail-layout.tsx'), 'utf8');
    const advanced = readFileSync(join(here, 'connector-advanced.tsx'), 'utf8');

    expect(layout).toContain('export function ConnectorDetailLayout');
    expect(layout).toContain('primaryAction');
    expect(layout).toContain('export function ConnectorSetupGuide');
    expect(layout).toContain('export function ConnectorDocumentationLinks');
    expect(advanced).toContain('export function ConnectorAdvanced');
    expect(advanced).toContain('<Disclosure');
    expect(advanced).toContain('Advanced');
    expect(advanced).not.toContain('primaryAction');
  });
});
