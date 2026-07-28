/**
 * Source-text contract for the logged-out section previews.
 *
 * Deliberately not a render test: the file imports AutomationsView, which
 * pulls the whole workspace tree and the SDK. What matters here is the routing
 * — which section gets which treatment, and that the ones still on the plain
 * shell keep every action gated — and that is visible in the source.
 *
 * The Connectors screen's own rules live in demo/connectors-demo.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(
  fileURLToPath(new URL('./anonymous-section-preview.tsx', import.meta.url)),
  'utf8',
);

describe('routing', () => {
  test('automations still renders the real view', () => {
    expect(SOURCE).toContain('<AutomationsView projectId="" />');
  });

  test('connectors renders the catalogue demo, not a fourth empty state', () => {
    expect(SOURCE).toContain("if (section === 'connectors')");
    expect(SOURCE).toContain('<ConnectorsDemo />');
  });

  test('the connectors branch is taken before the generic shell', () => {
    const branch = SOURCE.indexOf("if (section === 'connectors')");
    const generic = SOURCE.indexOf('const copy = COPY[section];');
    expect(branch).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(branch);
  });

  test('skills and agents keep their gated shell, so nothing was removed', () => {
    expect(SOURCE).toContain('skills:');
    expect(SOURCE).toContain('agents:');
    expect(SOURCE).toContain('state="empty"');
    expect(SOURCE).toContain('Sign in to start');
    expect(SOURCE).toContain('New skill');
    expect(SOURCE).toContain('New agent');
  });
});

describe('gating', () => {
  test('every handler left in this file gates', () => {
    const handlers = SOURCE.match(/on(?:Click|Change)[=:]\s*\{?\s*\(\)\s*=>\s*[^,\n]*/g) ?? [];
    expect(handlers.length).toBeGreaterThanOrEqual(3);
    for (const handler of handlers) {
      expect(handler).toContain('gate(');
    }
  });

  test('gating goes through the one hook', () => {
    expect(SOURCE).toContain('useSignInGate');
    expect(SOURCE).not.toContain('router.push');
    expect(SOURCE).not.toContain('window.location');
  });
});

describe('no fetching on the signed-out path', () => {
  test('the preview itself queries nothing', () => {
    expect(SOURCE).not.toContain('useQuery');
    expect(SOURCE).not.toContain("from '@kortix/sdk'");
  });
});
