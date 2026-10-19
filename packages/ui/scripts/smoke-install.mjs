#!/usr/bin/env node
/**
 * Packs @kortix/ui exactly as npm publishes it, installs the tarball into a
 * throwaway project with react 19, and imports EVERY export in Node ESM. Then it
 * type-checks a file that imports every JS export through the published .d.ts.
 *
 * @kortix/ui peers on @kortix/sdk (for @kortix/ui/chat), and @kortix/sdk depends on
 * @kortix/llm-catalog. stage-npm-publish.mjs pins those to the lockstep release
 * version, so the run packs all three at one synthetic version and installs the
 * tarballs together: nothing resolves from the registry for a version that exists
 * only during this run.
 *
 * Node cannot load a stylesheet, so a loader hook answers `.css` imports with an
 * empty module (map.tsx imports maplibre-gl's CSS; a bundler handles it for real
 * hosts). CSS exports are checked by resolution + a non-empty file instead.
 *
 * Run from packages/ui:  node scripts/smoke-install.mjs
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = join(fileURLToPath(import.meta.url), '..', '..');
const PACKAGES = [
  { name: '@kortix/llm-catalog', dir: join(UI_DIR, '..', 'llm-catalog'), build: 'build' },
  { name: '@kortix/sdk', dir: join(UI_DIR, '..', 'sdk'), build: 'build:bundles' },
  { name: '@kortix/ui', dir: UI_DIR, build: 'build' },
];
const VERSION = '0.0.0-smoke';
/** Exports a host loads only in the browser (see smoke.mjs). */
const BROWSER_ONLY = ['./terminal/pty-terminal'];

const walkFiles = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walkFiles(path) : [path];
      })
    : [];

const run = (cmd, args, cwd, env) =>
  execFileSync(cmd, args, { cwd, env: env ?? process.env, stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 << 20 });

const workdir = mkdtempSync(join(tmpdir(), 'kortix-ui-smoke-'));
const restores = [];
const tarballs = [];

try {
  for (const pkg of PACKAGES) {
    console.log(`→ building ${pkg.name} (${pkg.build})`);
    run('pnpm', ['run', pkg.build], pkg.dir);
  }

  console.log('→ staging the published manifests');
  for (const pkg of PACKAGES) {
    const backup = join(tmpdir(), `${pkg.name.replace('/', '-')}-pkg-${process.pid}.json`);
    copyFileSync(join(pkg.dir, 'package.json'), backup);
    restores.push({ from: backup, to: join(pkg.dir, 'package.json') });
    run('node', ['../../scripts/stage-npm-publish.mjs'], pkg.dir, { ...process.env, VERSION });
  }

  console.log('→ npm pack');
  for (const pkg of PACKAGES) {
    const file = run('npm', ['pack', '--silent'], pkg.dir).trim().split('\n').pop();
    tarballs.push(join(pkg.dir, file));
  }

  console.log(`→ installing ${tarballs.length} tarballs + react@19 into ${workdir}`);
  writeFileSync(join(workdir, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }, null, 2));
  run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      ...tarballs,
      'react@19',
      'react-dom@19',
      '@types/react@19',
      '@types/react-dom@19',
      '@tanstack/react-query@5',
      'zod@3.25.76',
      '@openuidev/lang-core@0.3.1',
    ],
    workdir,
  );

  console.log('→ importing every export in Node ESM');
  // README and the agent skills ship in the tarball (publishConfig.files).
  const shipped = ['README.md', ...walkFiles(join(UI_DIR, 'skills')).map((p) => relative(UI_DIR, p).split(sep).join('/'))];
  writeFileSync(
    join(workdir, 'css-loader.mjs'),
    "export async function load(url, context, next) {\n  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };\n  return next(url, context);\n}\n",
  );
  writeFileSync(
    join(workdir, 'smoke.mjs'),
    `import { register } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
register('./css-loader.mjs', import.meta.url);

const pkg = JSON.parse(readFileSync(new URL('./node_modules/@kortix/ui/package.json', import.meta.url), 'utf8'));
if (pkg.version !== '${VERSION}') throw new Error('installed @kortix/ui is not the packed tarball: ' + pkg.version);
for (const name of ['@kortix/shared', '@kortix/manifest-schema']) {
  if (pkg.dependencies?.[name]) throw new Error('published manifest depends on the private ' + name);
}
for (const file of ${JSON.stringify(shipped)}) {
  if (!existsSync(new URL('./node_modules/@kortix/ui/' + file, import.meta.url))) throw new Error('tarball is missing ' + file);
}
const keys = Object.keys(pkg.exports);
// Browser-only modules: resolved, never imported. A host loads them with a
// dynamic import on the client (session-terminal-panel loads pty-terminal).
// pty-terminal: @xterm/xterm reads \`self\` at module load.
const BROWSER_ONLY = ${JSON.stringify(BROWSER_ONLY)};
const failures = [];
let browserOnly = 0;
let js = 0;
let css = 0;
for (const key of keys) {
  const spec = key === '.' ? '@kortix/ui' : '@kortix/ui/' + key.slice(2);
  try {
    if (key.endsWith('.css') || key === './package.json') {
      const file = fileURLToPath(import.meta.resolve(spec));
      if (!existsSync(file) || statSync(file).size === 0) throw new Error('missing or empty: ' + file);
      css += 1;
      continue;
    }
    const file = fileURLToPath(import.meta.resolve(spec));
    if (/['"]@kortix\\/(?:shared|manifest-schema)/.test(readFileSync(file, 'utf8'))) throw new Error('imports a private @kortix/ package');
    if (BROWSER_ONLY.includes(key)) {
      browserOnly += 1;
      continue;
    }
    await import(spec);
    js += 1;
  } catch (error) {
    failures.push(spec + ': ' + (error?.message ?? error).split('\\n')[0]);
  }
}
if (failures.length) {
  console.error(failures.join('\\n'));
  throw new Error(failures.length + ' of ' + keys.length + ' exports failed');
}
const root = await import('@kortix/ui');
for (const name of ['cn', 'Button', 'UiProvider', 'useUiStrings', 'useIsDark']) {
  if (root[name] === undefined) throw new Error('root export missing: ' + name);
}
if (root.cn('px-2', 'px-4') !== 'px-4') throw new Error('cn() does not merge Tailwind classes');
const chat = await import('@kortix/ui/session');
const session = await import('@kortix/ui/session');
if (chat.SessionThread !== session.SessionThread) throw new Error('@kortix/ui/session SessionThread is not @kortix/ui/session SessionThread');
for (const name of ['SessionThread', 'SessionChatInput', 'ToolPartRenderer', 'UnifiedMarkdown']) {
  if (typeof session[name] !== 'function' && typeof session[name] !== 'object') throw new Error('session export missing: ' + name);
}
if (!session.ToolRegistry.get('bash')) throw new Error('@kortix/ui/session did not register the tool renderers');
const { renderToStaticMarkup } = await import('react-dom/server');
const { createElement } = await import('react');
const html = renderToStaticMarkup(createElement(root.Button, null, 'Hi'));
if (!html.startsWith('<button') || !html.includes('Hi')) throw new Error('Button did not render: ' + html);
console.log('OK: ' + js + ' JS exports imported, ' + browserOnly + ' browser-only resolved, ' + css + ' file exports resolved (' + keys.length + ' total), ${shipped.length} shipped files present; Button SSR: ' + html.slice(0, 60) + '…');
`,
  );
  process.stdout.write(run('node', ['smoke.mjs'], workdir));

  console.log('→ type-checking every JS export through the published .d.ts');
  // Read the file, not `node -p`: a piped stdout over 64 KB arrives cut (502 exports).
  const installed = JSON.parse(readFileSync(join(workdir, 'node_modules', '@kortix', 'ui', 'package.json'), 'utf8')).exports;
  const specs = Object.keys(installed)
    .filter((key) => !key.endsWith('.css') && key !== './package.json')
    .map((key) => (key === '.' ? '@kortix/ui' : `@kortix/ui/${key.slice(2)}`));
  writeFileSync(
    join(workdir, 'types.ts'),
    `${specs.map((spec, i) => `import * as m${i} from '${spec}';`).join('\n')}\nexport const all = [${specs.map((_, i) => `m${i}`).join(', ')}];\n`,
  );
  // JSX through the published types: fails when a dependency drags a second
  // @types/react next to dist/ (cmdk@0.2.1 → react-remove-scroll@2.5.4 wants ^18),
  // which skipLibCheck alone does not see.
  writeFileSync(
    join(workdir, 'usage.tsx'),
    [
      "import { Button } from '@kortix/ui';",
      "import { AlertDialog, AlertDialogContent, AlertDialogTitle } from '@kortix/ui/alert-dialog';",
      "import { Dialog, DialogContent, DialogTitle } from '@kortix/ui/dialog';",
      "import { Tabs, TabsList, TabsTrigger } from '@kortix/ui/tabs';",
      "import { Command, CommandInput } from '@kortix/ui/command';",
      "import { SessionThread } from '@kortix/ui/session';",
      'export const view = (',
      '  <div>',
      "    <Button variant='outline' size='sm' className='x'>Hi</Button>",
      "    <AlertDialog open><AlertDialogContent className='x'><AlertDialogTitle>T</AlertDialogTitle></AlertDialogContent></AlertDialog>",
      '    <Dialog open><DialogContent><DialogTitle>T</DialogTitle></DialogContent></Dialog>',
      "    <Tabs defaultValue='a'><TabsList><TabsTrigger value='a'>A</TabsTrigger></TabsList></Tabs>",
      '    <Command><CommandInput /></Command>',
      '  </div>',
      ');',
      'export const thread = SessionThread;',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(workdir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        types: [],
      },
      files: ['types.ts', 'usage.tsx'],
    }),
  );
  run(join(UI_DIR, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], workdir);
  console.log(`OK: ${specs.length} JS exports + JSX usage type-check from the tarball`);

  console.log('✔ @kortix/ui install smoke test passed');
} catch (error) {
  try {
    process.stdout.write(run('npm', ['ls', '--all', '@types/react'], workdir));
  } catch (ls) {
    if (ls?.stdout) process.stdout.write(ls.stdout);
  }
  if (error?.stdout) process.stdout.write(error.stdout);
  if (error?.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  // Every restore runs even when an earlier one throws, so no package.json is left
  // staged with the throwaway version.
  const errors = [];
  const step = (fn) => {
    try {
      fn();
    } catch (err) {
      errors.push(err);
    }
  };
  for (const { from, to } of restores) {
    step(() => copyFileSync(from, to));
    step(() => rmSync(from, { force: true }));
  }
  for (const tarball of tarballs) step(() => rmSync(tarball, { force: true }));
  step(() => rmSync(workdir, { recursive: true, force: true }));
  if (errors.length) throw new AggregateError(errors, 'smoke-install cleanup failed');
}
