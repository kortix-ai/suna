/**
 * `bun test` preload: `@kortix/sdk/react` runs on this app's React and React
 * Query. `packages/sdk/node_modules` holds its own copies (a newer React), and
 * bun resolves the SDK's imports there. Each copy is replaced by the module the
 * app itself loads. Metro does the same in `metro.config.js`.
 */
import { mock } from 'bun:test';
import { createRequire } from 'node:module';
import path from 'node:path';

const appRoot = path.join(import.meta.dir, '..', '..');
const appRequire = createRequire(path.join(appRoot, 'package.json'));
const sdkRoot = path.dirname(appRequire.resolve('@kortix/sdk/package.json'));
const sdkRequire = createRequire(path.join(sdkRoot, 'package.json'));

for (const name of ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@tanstack/react-query']) {
  // The file an `import` in app code loads: the one instance to share.
  const appModule = Bun.resolveSync(name, appRoot);
  // The file `require` finds and the file `import` finds can differ (a package
  // with separate CJS and ESM builds): replace both of the SDK's.
  for (const sdkModule of new Set([sdkRequire.resolve(name), Bun.resolveSync(name, sdkRoot)])) {
    if (sdkModule !== appModule) mock.module(sdkModule, () => import(appModule));
  }
}
