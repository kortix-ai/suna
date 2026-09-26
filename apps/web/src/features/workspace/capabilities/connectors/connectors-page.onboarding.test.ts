import { readFileSync } from '@/i18n/test-source';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dir, 'connectors-page.tsx'), 'utf8');

/**
 * The zero-state IS the onboarding (Jay, 2026-09-16): a project with no
 * connectors gets one three-step strip above the catalogue, and the first
 * connector added removes it forever. These pins hold the two properties that
 * make it acceptable to ship with no dismiss control:
 */
describe('connectors page — zero-state onboarding strip', () => {
  test('shows only for a SETTLED empty project, so it can never flash or linger', () => {
    // `settled` keeps it off while the list loads (a project WITH connectors
    // must never see it for a beat), `connectors.length === 0` removes it the
    // moment the first connector exists, and `!isError` keeps a failed load
    // from reading as a brand-new project.
    expect(page).toContain(
      'const showConnectorOnboarding = catalogActive && settled && !isError && connectors.length === 0;',
    );
    expect(page).toContain('{showConnectorOnboarding ? (');
  });

  test('three steps, i18n-keyed, ABOVE the catalogue', () => {
    expect(page).toContain("raw('text1b0b2274e844')"); // How connectors work
    for (const key of ['textc01e20fa9cb4', 'texte5184a0338e3', 'texte951e68b68a3']) {
      expect(page).toContain(`'${key}'`);
    }
    // The strip leads the catalogue branch: onboarding renders before the
    // project-matches strip and the browse grid.
    const strip = page.indexOf('connector-onboarding-title');
    const matches = page.indexOf('project-matches-title');
    expect(strip).toBeGreaterThan(-1);
    expect(matches).toBeGreaterThan(strip);
  });
});
