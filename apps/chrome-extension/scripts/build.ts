// Bundles the extension into dist/. Run: bun run build
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const app = join(import.meta.dir, '..');
const dist = join(app, 'dist');
const tokens = join(app, '../../.agents/skills/kortix-brand/references/visual/tokens.css');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// KORTIX_EXTENSION_DEV=1 (bun run build:dev) shows "Another server…" on the welcome page. A store build never does.
const dev = process.env.KORTIX_EXTENSION_DEV === '1';
const common = { outdir: dist, target: 'browser' as const, format: 'esm' as const, minify: false, define: { __DEV_BUILD__: String(dev) } };
const results = await Promise.all([
  Bun.build({ ...common, entrypoints: [join(app, 'src/background/index.ts')], naming: 'background.js' }),
  // A content script is not a module: bundle as iife.
  Bun.build({
    ...common, format: 'iife', entrypoints: [join(app, 'src/overlay.ts')], naming: 'overlay.js',
    define: { ...common.define, __TOKENS_CSS__: JSON.stringify(readFileSync(tokens, 'utf8')) },
  }),
  ...['welcome', 'consent', 'sidepanel', 'options'].map((p) =>
    Bun.build({ ...common, entrypoints: [join(app, `src/pages/${p}.ts`)], naming: `${p}.js` })),
]);
for (const r of results) if (!r.success) { console.error(r.logs.join('\n')); process.exit(1); }

cpSync(tokens, join(dist, 'tokens.css'));
cpSync(join(app, 'src/pages/pages.css'), join(dist, 'pages.css'));
cpSync(join(app, 'icons'), join(dist, 'icons'), { recursive: true });
for (const p of ['welcome', 'consent', 'sidepanel', 'options']) cpSync(join(app, `src/pages/${p}.html`), join(dist, `${p}.html`));
writeFileSync(join(dist, 'manifest.json'), readFileSync(join(app, 'src/manifest.json')));
console.log('built', dist);
