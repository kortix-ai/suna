#!/usr/bin/env node
// Writes src/i18n/en.json, the English catalog @kortix/ui renders with when the
// host passes no translations. It copies, from apps/web/translations/en.json,
// every message the scanned sources read.
//
//   node scripts/gen-i18n-catalog.mjs           write
//   node scripts/gen-i18n-catalog.mjs --check   exit 1 when en.json drifts (src/i18n/i18n.test.tsx runs it)
//
// Scanned: packages/ui/src, the apps/web session UI that moves into the package
// (features/session, components/markdown, components/diff), and every other
// apps/web file that imports '@kortix/ui/i18n'.
//
// Per file, a translator is a name bound to a namespace:
//   const t = useTranslations('ns')            → 'ns'
//   t: UiTranslator                            → 'hardcodedUi.i18nComplete'
//   t: ReturnType<typeof useTranslations<'ns'>> → 'ns'
// A namespace under SMALL bytes is copied whole (dynamic keys keep working).
// A larger one copies only the keys called as t('k'), t.raw('k'), t.rich('k'),
// t.markup('k') or t.has('k'); t(`a.${x}`) copies the subtree `a`. A call on an
// unbound translator name (a `t` passed in untyped) copies the key from every
// namespace that has it. A string literal that names a message of a namespace
// the file binds is copied too (`titleKey: 'a.b'`, then `t(titleKey)`).
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = join(fileURLToPath(import.meta.url), '..', '..');
const REPO = join(PKG_DIR, '..', '..');
const SOURCE = join(REPO, 'apps/web/translations/en.json');
const OUT = join(PKG_DIR, 'src/i18n/en.json');
const SCAN = [
  'packages/ui/src',
  'apps/web/src/features/session',
  'apps/web/src/components/markdown',
  'apps/web/src/components/diff',
].map((dir) => join(REPO, dir));
const ADOPTERS = join(REPO, 'apps/web/src');
const SMALL = 50_000;
const UI_TRANSLATOR_NS = 'hardcodedUi.i18nComplete';

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
    return /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
  });
}

const at = (tree, path) =>
  path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), tree);

function put(out, path, value) {
  const keys = path.split('.');
  let node = out;
  for (const key of keys.slice(0, -1)) node = node[key] ??= {};
  node[keys.at(-1)] = value;
}

/** Keeps the source catalog's key order. */
function ordered(source, picked) {
  if (typeof picked !== 'object' || picked === null) return picked;
  return Object.fromEntries(
    Object.keys(source)
      .filter((key) => key in picked)
      .map((key) => [key, ordered(source[key], picked[key])]),
  );
}

export function buildCatalog() {
  const source = JSON.parse(readFileSync(SOURCE, 'utf8'));
  const namespaces = new Set();
  const keyed = []; // [namespace ('' = root, null = unknown), key or subtree path, message only]
  const adopters = walk(ADOPTERS).filter((f) => readFileSync(f, 'utf8').includes("'@kortix/ui/i18n'"));
  for (const file of new Set([...SCAN.flatMap(walk), ...adopters])) {
    const code = readFileSync(file, 'utf8');
    // name → namespaces. One file can bind `t` in several components.
    const bound = new Map();
    const bind = (name, ns) => bound.set(name, (bound.get(name) ?? new Set()).add(ns));
    for (const m of code.matchAll(/\b(\w+)\s*=\s*useTranslations\(\s*(?:(['"])([^'"]*)\2)?\s*\)/g)) {
      bind(m[1], m[3] ?? '');
    }
    for (const m of code.matchAll(/\b(\w+)\??\s*:\s*UiTranslator\b/g)) bind(m[1], UI_TRANSLATOR_NS);
    for (const m of code.matchAll(/\b(\w+)\??\s*:\s*ReturnType<\s*typeof useTranslations(?:<\s*'([^']*)'\s*>)?\s*>/g)) {
      bind(m[1], m[2] ?? null);
    }
    for (const set of bound.values()) for (const ns of set) if (ns) namespaces.add(ns);
    for (const m of code.matchAll(/\b(\w+)(?:\.(?:raw|rich|markup|has))?\(\s*(['"`])([^'"`\n]*?)(\$\{|\2)/g)) {
      const [, name, , key, end] = m;
      const set = bound.get(name) ?? (/^t([A-Z]\w*)?$/.test(name) ? new Set([null]) : null);
      if (!set) continue;
      const isPrefix = end === '${';
      const path = isPrefix ? key.slice(0, Math.max(0, key.lastIndexOf('.'))) : key;
      if (!path) continue;
      for (const ns of set) keyed.push([ns, path]);
    }
    // Keys held in data (`titleKey: 'a.b'`, then `t(titleKey)`): any literal that
    // names a message of a namespace this file binds.
    for (const m of code.matchAll(/(['"])([\w.-]+)\1/g)) {
      for (const set of bound.values()) for (const ns of set) if (ns !== null) keyed.push([ns, m[2], true]);
    }
  }
  const out = {};
  for (const ns of namespaces) {
    const node = at(source, ns);
    if (node === undefined) continue;
    if (JSON.stringify(node).length < SMALL) put(out, ns, node);
  }
  for (const [ns, key, messageOnly] of keyed) {
    const candidates = ns === null ? [...namespaces] : [ns];
    for (const candidate of candidates) {
      const path = candidate ? `${candidate}.${key}` : key;
      const value = at(source, path);
      if (value === undefined || (messageOnly && typeof value !== 'string')) continue;
      if (at(out, path) === undefined) put(out, path, value);
    }
  }
  return `${JSON.stringify(ordered(source, out), null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const next = buildCatalog();
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  const where = relative(REPO, OUT);
  if (process.argv.includes('--check')) {
    if (next !== current) {
      console.error(`gen-i18n-catalog: ${where} drifts. Run: pnpm --filter @kortix/ui gen-i18n-catalog`);
      process.exit(1);
    }
    console.log('gen-i18n-catalog: no drift');
  } else if (next !== current) {
    writeFileSync(OUT, next);
    console.log(`gen-i18n-catalog: wrote ${where} (${next.length} bytes)`);
  } else {
    console.log('gen-i18n-catalog: up to date');
  }
}
