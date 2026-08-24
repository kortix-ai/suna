import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const callSites = [
  '../features/workspace/project-sidebar/project-settings-nav.tsx',
  '../features/workspace/project-sidebar/footer/project-files-nav.tsx',
  '../features/workspace/project-sidebar/footer/project-manifest-upgrade-alert.tsx',
  '../components/projects/project-onboarding-wizard.tsx',
  '../features/session/use-model-connection-gate.tsx',
  '../features/session/session-permission-prompt.tsx',
  '../features/session/scope/use-session-scope.ts',
  '../features/workspace/project-sidebar/footer/project-sandbox-alert.tsx',
];

test('all always-mounted project gates share one permission batch shape', () => {
  for (const file of callSites) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source, file).toContain('useProjectPageCans(');
    expect(source, file).not.toMatch(/\buseProjectCan\(/);
    expect(source, file).not.toMatch(/\buseProjectCans\(/);
    expect(source, file).not.toMatch(/\buseCans\(/);
  }
});
