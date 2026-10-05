#!/usr/bin/env node
/**
 * Copies Mermaid's browser bundle into the app as a Metro asset.
 *
 * The chat renders Mermaid diagrams in a WebView (components/markdown/mermaid),
 * which needs `mermaid.min.js` as a file, not as a module in the Hermes bundle.
 * The file is committed so Metro and EAS builds need no install-time step:
 * pnpm runs no lifecycle scripts in this repo (`ignore-scripts=true`).
 *
 * Run after changing the `mermaid` devDependency (pinned to web's version):
 *   node scripts/sync-mermaid-asset.mjs
 * `components/markdown/mermaid/mermaid-asset.test.ts` fails while the copy is stale.
 */
import { copyFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(app, 'package.json'));
const packageJson = require.resolve('mermaid/package.json');
const { version } = JSON.parse(readFileSync(packageJson, 'utf8'));
const source = path.join(path.dirname(packageJson), 'dist/mermaid.min.js');
const target = path.join(app, 'assets/mermaid/mermaid.min.webjs');

copyFileSync(source, target);
console.log(`mermaid ${version}: ${path.relative(app, source)} -> ${path.relative(app, target)}`);
