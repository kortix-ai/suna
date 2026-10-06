import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lineNumber,
  sourceFiles,
  staticFetchTarget,
} from '../../../scripts/lib/sdk-boundary-scan.mjs';

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = join(APP_ROOT, '..', '..');
const CLIENT_ROOT = join(APP_ROOT, 'src');
const TEST_ROOT = join(APP_ROOT, 'tests');
const REPOSITORY_TEST_ROOT = join(REPO_ROOT, 'tests', 'e2e', 'specs');
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx']);

const UI_ROOT = join(CLIENT_ROOT, 'components', 'ui');
const API_ROOT = join(CLIENT_ROOT, 'app', 'api');
const SERVER_ROOT = join(CLIENT_ROOT, 'server');
const ALLOWED_CLIENT_BFF_ROUTES = [
  '/api/auth',
  // Connections this wrapper may bind — pre-filtered server-side to team-owned
  // ones, so the client never sees an unbindable option.
  '/api/connections',
  '/api/mode',
  '/api/preview-url',
  // Provider-neutral session model control: the upstream field is named after
  // the runtime, so the translation stays server-side and the client says `model`.
  '/api/session-model',
  '/api/session-costs',
  // Lists the ACCOUNT's projects so an operator can adopt one into this demo
  // user. Gated on LUMEN_ALLOW_PROJECT_IMPORT and off by default — it is the one
  // place the wrapper's per-end-user project filter is deliberately bypassed, so
  // it is registered here rather than reached through the generic proxy.
  '/api/projects/import',
];

const RULES = [
  {
    scope: 'all',
    rule: 'opencode-package',
    pattern: /['"]@opencode-ai\/sdk(?:\/[^'"]*)?['"]/gi,
    message: 'Client code must not import the OpenCode SDK.',
  },
  {
    scope: 'all',
    rule: 'direct-runtime-import',
    pattern:
      /['"]@kortix\/sdk\/(?:event-stream|idb-sync-cache|opencode(?:-[^'"]*)?|sandbox(?:-[^'"]*)?|server-store|session|sync-store)['"]/gi,
    message: 'Client code must use @kortix/sdk and @kortix/sdk/react only.',
  },
  {
    scope: 'all',
    rule: 'runtime-proxy-url',
    pattern: /\/p\/(?:\$\{[^}]+\}|[^/'"`\s]+)\/8000(?:\/|['"`])/gi,
    message: 'Client code must not construct runtime proxy URLs.',
  },
  {
    scope: 'client',
    rule: 'runtime-url-api',
    pattern: /\.(?:previewUrl|proxyUrl)\s*\(/g,
    message: 'Client code must resolve preview URLs through the server BFF.',
  },
  {
    scope: 'all',
    rule: 'opencode-rest-path',
    pattern:
      /\/(?:global\/event|prompt_async)|['"`]\/(?:session\/[^'"`\s]+\/(?:abort|command|message|prompt)|message\/[^'"`\s]+)/gi,
    message: 'Client code must not construct OpenCode REST paths.',
  },
  {
    scope: 'all',
    rule: 'legacy-runtime-store',
    pattern:
      /\b(?:server-store|sync-store|sandbox-connection-store|opencode-pending-store|idb-sync-cache)\b/gi,
    message: 'Client code must not use legacy runtime stores.',
  },
  {
    scope: 'client',
    rule: 'provider-term',
    pattern: /open[_-]?code/gi,
    message: 'Reference-app client code must use provider-neutral terminology.',
  },
  {
    scope: 'client',
    rule: 'native-control',
    pattern: /<(?:button|input|select|textarea)\b/g,
    message: 'Feature code must compose controls from src/components/ui.',
  },
  {
    scope: 'client',
    rule: 'spinner-icon',
    pattern: /\bLoader2(?:Icon)?\b|animate-spin/gi,
    message: 'Feature code must use the shared Loading primitive.',
  },
];

function isFeatureClient(path) {
  return ![API_ROOT, SERVER_ROOT, UI_ROOT].some(
    (directory) => path === directory || path.startsWith(`${directory}/`),
  );
}

function rawFetchViolations(source, client) {
  const violations = [];
  const fetchPattern = /\bfetch\s*\(/g;
  for (const match of source.matchAll(fetchPattern)) {
    const expression = source.slice((match.index ?? 0) + match[0].length).trimStart();
    const target = staticFetchTarget(expression);
    const isAllowed =
      client &&
      target !== null &&
      ALLOWED_CLIENT_BFF_ROUTES.some(
        (route) =>
          target === route || target.startsWith(`${route}/`) || target.startsWith(`${route}?`),
      );
    if (!isAllowed) {
      violations.push({
        rule: 'raw-kortix-fetch',
        index: match.index,
        match: match[0],
        message: client
          ? 'Client fetch is restricted to documented same-origin app routes.'
          : 'Server Kortix transport must use @kortix/sdk/server.',
      });
    }
  }
  return violations;
}

export function scanSource(source, options = { client: true }) {
  const violations = [];
  for (const { scope, rule, pattern, message } of RULES) {
    if (scope === 'client' && !options.client) continue;
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      violations.push({
        rule,
        index: match.index,
        match: match[0],
        message,
      });
    }
  }
  violations.push(...rawFetchViolations(source, options.client));
  return violations.sort((left, right) => left.index - right.index);
}

export function scanWhiteLabelBoundary() {
  return sourceFiles(CLIENT_ROOT, { extensions: SOURCE_EXTENSIONS }).flatMap((path) => {
    const source = readFileSync(path, 'utf8');
    return scanSource(source, { client: isFeatureClient(path) }).map((violation) => ({
      ...violation,
      file: relative(APP_ROOT, path),
      line: lineNumber(source, violation.index),
    }));
  });
}

export function scanTestSource(source) {
  const violations = [];
  const internalSdkImportPattern = /['"][^'"]*packages\/sdk\/src(?:\/[^'"]*)?['"]/g;
  for (const match of source.matchAll(internalSdkImportPattern)) {
    violations.push({
      rule: 'test-sdk-internal-import',
      index: match.index,
      match: match[0],
      message: 'Application tests must import the public @kortix/sdk surface.',
    });
  }
  const directTransportPattern = /\bfetch\s*\([^)]{0,500}\/api\/kortix(?:\/|['"`])/g;
  for (const match of source.matchAll(directTransportPattern)) {
    violations.push({
      rule: 'test-raw-kortix-transport',
      index: match.index,
      match: match[0],
      message: 'Application tests must call Kortix through @kortix/sdk.',
    });
  }
  return violations.sort((left, right) => left.index - right.index);
}

export function scanWhiteLabelTestBoundary() {
  return listWhiteLabelTestFiles().flatMap((path) => {
    const source = readFileSync(path, 'utf8');
    return scanTestSource(source).map((violation) => ({
      ...violation,
      file: relative(REPO_ROOT, path),
      line: lineNumber(source, violation.index),
    }));
  });
}

export function listWhiteLabelTestFiles() {
  const localTests = sourceFiles(TEST_ROOT, { extensions: SOURCE_EXTENSIONS }).filter(
    (path) =>
      /\.test\.[cm]?[jt]sx?$/.test(path) && !path.endsWith(join('e2e', 'sdk-boundary.test.ts')),
  );
  const repositoryTests = sourceFiles(REPOSITORY_TEST_ROOT, {
    extensions: SOURCE_EXTENSIONS,
  }).filter((path) => /(?:whitelabel|sdk-only-session).*\.spec\.[cm]?[jt]sx?$/.test(path));
  return [...localTests, ...repositoryTests];
}

function run() {
  const violations = [...scanWhiteLabelBoundary(), ...scanWhiteLabelTestBoundary()];
  if (violations.length === 0) {
    console.log('White-label SDK boundary: 0 violations.');
    return;
  }

  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line} [${violation.rule}] ${violation.message}`);
  }
  console.error(`White-label SDK boundary: ${violations.length} violation(s).`);
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run();
}
