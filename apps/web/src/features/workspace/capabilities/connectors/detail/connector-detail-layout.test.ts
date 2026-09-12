import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dir;

describe('connector detail layout', () => {
  test('exports the layout, live stepper, and docs sections', () => {
    const layout = readFileSync(join(here, 'connector-detail-layout.tsx'), 'utf8');

    expect(layout).toContain('export function ConnectorDetailLayout');
    expect(layout).toContain('primaryAction');
    expect(layout).toContain('export function ConnectorSetupGuide');
    expect(layout).toContain('export function ConnectorDocumentationLinks');
  });

  test('the Advanced technical disclosure stays removed', () => {
    // Jay 2026-09-12: the Surface/Transport/Endpoint/Access panel was noise on
    // every detail page and was cut. If it comes back, it comes back as a
    // product decision, not a leftover import.
    expect(existsSync(join(here, 'connector-advanced.tsx'))).toBe(false);
  });
});
