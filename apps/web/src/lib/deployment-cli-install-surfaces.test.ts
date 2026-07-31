import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB_SRC = join(import.meta.dir, '..');

// Surfaces that must show the installer for the deployment the visitor is
// actually on. `/download` joined this list when it replaced the in-app
// download modal; on kortix.com the hook resolves to the canonical command
// anyway, and on dev or a preview it points at that origin instead.
const DEPLOYMENT_AWARE_SURFACES = [
  'features/marketing/download/terminal-block.tsx',
  'features/session/session-terminal-connect-bar.tsx',
  'features/workspace/customize/sections/view/dev-view.tsx',
  'features/workspace/customize/sections/view/git-view.tsx',
];

test('all deployment-aware CLI installer surfaces use the hook', () => {
  for (const path of DEPLOYMENT_AWARE_SURFACES) {
    const source = readFileSync(join(WEB_SRC, path), 'utf8');
    expect(source).toContain('useDeploymentCliInstallCommand(');
    expect(source).not.toContain('https://kortix.com/install');
    expect(source).not.toContain('KORTIX_CLI_INSTALL_COMMAND');
  }
});

test('the kortix.com marketing page keeps the canonical installer command', () => {
  const source = readFileSync(
    join(WEB_SRC, 'app/(public)/(marketing)/developers/page.tsx'),
    'utf8',
  );
  expect(source).toContain('KORTIX_CLI_INSTALL_COMMAND');
});
