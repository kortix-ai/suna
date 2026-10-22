#!/usr/bin/env node
// Writes src/i18n/en.ts, the English catalog @kortix/ui renders with when the
// host passes no translations. It copies, from apps/web/translations/en.json,
// every message the scanned sources read. The catalog is a .ts module, not
// .json: plain Node ESM refuses a JSON import without `with { type: 'json' }`,
// and a .d.ts that imports .json needs `resolveJsonModule` in every consumer.
//
//   node scripts/gen-i18n-catalog.mjs           write
//   node scripts/gen-i18n-catalog.mjs --check   exit 1 when en.ts drifts (src/i18n/i18n.test.tsx runs it)
//
// Scanned: the import graph of packages/ui/src, following relative imports,
// plus the apps/web files that wire the package translator (ADOPTERS).
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
// the file binds is copied too (`titleKey: 'a.b'`, then `t(titleKey)`). Every
// 'text<hex12>' literal is copied from hardcodedUi.i18nComplete: key maps such
// as packages/ui/src/session/panel/audit/audit-credential-label.ts bind no translator themselves.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = join(fileURLToPath(import.meta.url), '..', '..');
const REPO = join(PKG_DIR, '..', '..');
const SOURCE = join(REPO, 'apps/web/translations/en.json');
const OUT = join(PKG_DIR, 'src/i18n/en.ts');
const WEB_SRC = join(REPO, 'apps/web/src');
const ROOTS = [join(PKG_DIR, 'src')];
// The apps/web files that wire the package translator into the host. apps/web
// product files import '@kortix/ui/i18n' too, but they render in apps/web only,
// which ships its own catalogs, so their keys stay out of the bundled catalog.
const ADOPTERS = ['components/kortix-ui-provider.tsx', 'i18n/translator.ts', 'test-utils/ui-host.tsx'];
const SMALL = 50_000;
const UI_TRANSLATOR_NS = 'hardcodedUi.i18nComplete';
export const HEX_KEY = /(['"`])(text[0-9a-f]{12})\1/g;

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
    return /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
  });
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*)(['"])([^'"\n]+)\1/g;

function resolveModule(from, spec) {
  let base;
  if (spec.startsWith('.')) base = join(dirname(from), spec);
  else if (spec.startsWith('@/')) base = join(WEB_SRC, spec.slice(2));
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (/\.tsx?$/.test(candidate) && !/\.d\.ts$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

// A web file that imports one of these stays in apps/web, so the package never
// renders it: the graph does not enter it (the same rule as the move closure).
const TEST = /\.(test|stories)\.tsx?$/;
const HOST_ONLY = /^(next|next\/.*|next-intl.*|next-themes|server-only|@supabase\/.*|@sentry\/.*|posthog-js.*|@vercel\/.*)$/;
const hostOnly = (code) =>
  /process\.env\.(?!NODE_ENV)/.test(code) || [...code.matchAll(IMPORT)].some((m) => HOST_ONLY.test(m[2]));

/**
 * The files the package renders, or will once the session UI moves: every
 * .ts/.tsx file under ROOTS (tests excluded), plus the movable apps/web
 * modules they import, transitively. A module is movable when neither it nor
 * anything it imports is host-only (the rule of the move closure). A blocked
 * non-root module stays in apps/web, which passes its own i18n.
 */
export function scannedFiles() {
  const roots = ROOTS.flatMap(walk).filter((f) => !TEST.test(f) && f !== OUT);
  const deps = new Map(); // file → resolved imports
  const own = new Map(); // file → host-only by its own source
  const queue = [...roots];
  while (queue.length) {
    const file = queue.pop();
    if (deps.has(file)) continue;
    const code = readFileSync(file, 'utf8');
    own.set(file, hostOnly(code));
    const next = [...code.matchAll(IMPORT)]
      .map((m) => resolveModule(file, m[2]))
      .filter((f) => f && !TEST.test(f));
    deps.set(file, next);
    queue.push(...next);
  }
  const blocked = new Set([...own].filter(([, v]) => v).map(([f]) => f));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [file, next] of deps) {
      if (!blocked.has(file) && next.some((d) => blocked.has(d))) {
        blocked.add(file);
        changed = true;
      }
    }
  }
  const seen = new Set(roots);
  const stack = [...roots];
  while (stack.length) {
    for (const dep of deps.get(stack.pop())) {
      if (!seen.has(dep) && !blocked.has(dep)) {
        seen.add(dep);
        stack.push(dep);
      }
    }
  }
  return [...seen].sort();
}

const at = (tree, path) =>
  path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), tree);

/** Sets `path`; a subtree merges into the keys already picked under it. */
function put(out, path, value) {
  const keys = path.split('.');
  let node = out;
  for (const key of keys.slice(0, -1)) node = node[key] ??= {};
  const last = keys.at(-1);
  const prev = node[last];
  const isTree = (v) => typeof v === 'object' && v !== null;
  node[last] = isTree(prev) && isTree(value) ? merge(structuredClone(value), prev) : value;
}

function merge(into, from) {
  for (const [key, value] of Object.entries(from)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    into[key] = typeof value === 'object' && value !== null && typeof into[key] === 'object' ? merge(into[key], value) : value;
  }
  return into;
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
  const adopters = ADOPTERS.map((f) => join(WEB_SRC, f));
  for (const file of new Set([...scannedFiles(), ...adopters])) {
    const code = readFileSync(file, 'utf8');
    // name → namespaces. One file can bind `t` in several components.
    const bound = new Map();
    const bind = (name, ns) => bound.set(name, (bound.get(name) ?? new Set()).add(ns));
    for (const m of code.matchAll(/\b(\w+)\s*=\s*use(?:I18n)?Translations\(\s*(?:(['"])([^'"]*)\2)?\s*\)/g)) {
      bind(m[1], m[3] ?? '');
    }
    for (const m of code.matchAll(/\b(\w+)\??\s*:\s*UiTranslator\b/g)) bind(m[1], UI_TRANSLATOR_NS);
    for (const m of code.matchAll(/\b(\w+)\??\s*:\s*ReturnType<\s*typeof useTranslations(?:<\s*'([^']*)'\s*>)?\s*>/g)) {
      bind(m[1], m[2] ?? null);
    }
    for (const set of bound.values()) for (const ns of set) if (ns) namespaces.add(ns);
    for (const m of code.matchAll(HEX_KEY)) keyed.push([UI_TRANSLATOR_NS, m[2], true]);
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
      const have = at(out, path);
      if (have === undefined || (typeof have === 'object' && typeof value === 'object')) put(out, path, value);
    }
  }
  const body = JSON.stringify(ordered(source, out), null, 2);
  return `// Generated by scripts/gen-i18n-catalog.mjs from apps/web/translations/en.json. Do not edit.\nconst catalog = ${body};\n\nexport default catalog;\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const next = buildCatalog();
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
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
