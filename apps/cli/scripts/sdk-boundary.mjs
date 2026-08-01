import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_SOURCE_ROOT = join(APP_ROOT, 'src');
const SOURCE_EXTENSIONS = new Set(['.ts']);
/** This lint's own test states every forbidden shape as a fixture string. */
const SELF_TEST = join('src', '__tests__', 'sdk-boundary.test.ts');

/**
 * The ONE file allowed to hold a raw transport. It IS the @kortix/sdk adapter,
 * so it is the single place a Kortix-bound request may be constructed. Kept as a
 * named constant (and length-locked by a test) so a second escape hatch cannot
 * be added without the diff being obvious.
 */
export const TRANSPORT_ALLOWLIST = ['src/api/sdk.ts'];

/**
 * Hosts the CLI legitimately talks to directly — none of them are the Kortix
 * backend, so none of them belong in the SDK. Judged by static URL prefix.
 */
const ALLOWED_FETCH_ORIGINS = [
  'https://api.github.com',
  'https://github.com',
  'https://objects.githubusercontent.com',
  'https://hub.docker.com',
  'https://registry.npmjs.org',
];

/**
 * `scope: 'all'` rules run on every file, tests included — importing an
 * internal or forbidden module is wrong in a test too.
 * `scope: 'source'` rules run on non-test files only: test files stand up mock
 * OpenCode servers and mock proxy URLs on purpose, so the path/URL shapes are
 * fixtures there, not hand-rolled transport.
 */
const RULES = [
  {
    scope: 'all',
    rule: 'opencode-package',
    pattern: /['"]@opencode-ai\/sdk(?:\/[^'"]*)?['"]/gi,
    message: 'CLI code must not import the OpenCode SDK.',
  },
  {
    scope: 'all',
    rule: 'sdk-internal-import',
    pattern: /['"](?:@kortix\/sdk\/src(?:\/[^'"]*)?|[^'"]*packages\/sdk\/src(?:\/[^'"]*)?)['"]/g,
    message: 'CLI code must import the public @kortix/sdk surface only.',
  },
  {
    scope: 'source',
    rule: 'opencode-rest-path',
    pattern:
      /\/(?:global\/event|prompt_async)|['"`]\/(?:session|permission|question)(?=['"`?])|['"`]\/(?:session\/[^'"`\s]+\/(?:abort|command|message|prompt)|(?:permission|question)\/[^'"`\s]+\/(?:reply|reject))/gi,
    message: 'CLI code must not construct OpenCode REST paths.',
  },
  {
    scope: 'source',
    rule: 'runtime-proxy-url',
    // Any port — a literal (`/8000/`) or an interpolated one (`/${port}`), which
    // is the shape the CLI actually hand-builds. The trailing `/`, `${`, or quote
    // keeps this on code and off prose that merely spells the URL out.
    pattern: /\/p\/(?:\$\{[^}]+\}|[^/'"`\s]+)\/(?:\d+|\$\{[^}]+\})(?:\/|\$\{|['"`])/gi,
    message: 'CLI code must not construct runtime proxy URLs.',
  },
];

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      files.push(...sourceFiles(path));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(extname(path))) files.push(path);
  }
  return files;
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}

function isTestFile(path) {
  const posix = toPosix(path);
  return /\.test\.[cm]?[jt]sx?$/.test(posix) || posix.includes('/__tests__/');
}

function isTransportFile(relativePath) {
  return TRANSPORT_ALLOWLIST.includes(relativePath);
}

/**
 * Resolve the static target of a `fetch(` call, or `null` when the target is
 * dynamic. A bare variable and a template whose base is interpolated
 * (`` fetch(`${base}/v1/projects`) ``) both resolve to `null` — that is exactly
 * the shape the hand-rolled Kortix transport used, so it must not pass.
 */
function staticFetchTarget(expression) {
  const quote = expression[0];
  if (quote === "'" || quote === '"') {
    const end = expression.indexOf(quote, 1);
    return end > 0 ? expression.slice(1, end) : null;
  }
  if (quote === '`') {
    // Template literal: judge it by its STATIC PREFIX — the text before the
    // first interpolation. `https://api.github.com/x?ref=${v}` is as verifiable
    // as the string form; `${base}/v1/x` has an empty prefix and is rejected.
    const end = expression.indexOf('`', 1);
    const raw = end > 0 ? expression.slice(1, end) : expression.slice(1);
    const interpolation = raw.indexOf('${');
    const prefix = interpolation >= 0 ? raw.slice(0, interpolation) : raw;
    return prefix.length > 0 ? prefix : null;
  }
  return null;
}

function isAllowedFetchTarget(target) {
  if (target === null) return false;
  return ALLOWED_FETCH_ORIGINS.some(
    (origin) =>
      target === origin || target.startsWith(`${origin}/`) || target.startsWith(`${origin}?`),
  );
}

function rawFetchViolations(source) {
  const violations = [];
  const fetchPattern = /\bfetch\s*\(/g;
  for (const match of source.matchAll(fetchPattern)) {
    const expression = source.slice((match.index ?? 0) + match[0].length).trimStart();
    if (isAllowedFetchTarget(staticFetchTarget(expression))) continue;
    violations.push({
      rule: 'raw-kortix-fetch',
      index: match.index,
      match: match[0],
      message: `Kortix transport must go through @kortix/sdk (only ${TRANSPORT_ALLOWLIST.join(', ')} may hold a raw transport).`,
    });
  }
  return violations;
}

export function scanSource(source, options = {}) {
  const { test = false, transport = false } = options;
  const violations = [];
  for (const { scope, rule, pattern, message } of RULES) {
    if (scope === 'source' && test) continue;
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      violations.push({ rule, index: match.index, match: match[0], message });
    }
  }
  if (!test && !transport) violations.push(...rawFetchViolations(source));
  return violations.sort((left, right) => left.index - right.index);
}

export function scanCliBoundary(root = CLI_SOURCE_ROOT) {
  return sourceFiles(root).flatMap((path) => {
    if (path.endsWith(SELF_TEST)) return [];
    const source = readFileSync(path, 'utf8');
    const appRelative = toPosix(relative(APP_ROOT, path));
    const display = path.startsWith(`${APP_ROOT}${sep}`)
      ? appRelative
      : toPosix(relative(root, path));
    return scanSource(source, {
      test: isTestFile(path),
      transport: isTransportFile(appRelative),
    }).map((violation) => ({
      ...violation,
      file: display,
      line: lineNumber(source, violation.index),
    }));
  });
}

function run() {
  const violations = scanCliBoundary();
  if (violations.length === 0) {
    console.log('CLI SDK boundary: 0 violations.');
    return;
  }

  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} [${violation.rule}] ${violation.message}`);
  }
  console.error(`CLI SDK boundary: ${violations.length} violation(s).`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run();
}
