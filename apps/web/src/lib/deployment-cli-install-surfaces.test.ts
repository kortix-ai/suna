import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WEB_SRC = join(import.meta.dir, '..');

const IN_PRODUCT_SURFACES = [
  'features/layout/download-apps-modal.tsx',
  'features/session/session-terminal-connect-bar.tsx',
  'features/workspace/customize/sections/view/dev-view.tsx',
  'features/workspace/customize/sections/view/git-view.tsx',
];

test('all in-product CLI installer surfaces use the deployment-aware hook', () => {
  for (const path of IN_PRODUCT_SURFACES) {
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
