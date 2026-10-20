import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  lineNumber,
  sourceFiles,
  staticFetchTarget,
} from '../../../../scripts/lib/sdk-boundary-scan.mjs';

const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = join(APP_ROOT, '..', '..', '..');
const CLIENT_ROOT = join(APP_ROOT, 'src');
// Lumen's own backend. Server-side: it holds the operator credential and calls
// Kortix only through @kortix/sdk/server inside "use node" actions.
const CONVEX_ROOT = join(APP_ROOT, 'convex');
const TEST_ROOT = join(APP_ROOT, 'tests');
const REPOSITORY_TEST_ROOT = join(REPO_ROOT, 'tests', 'e2e', 'specs');
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx']);

// Retired: UI primitives come from @kortix/ui. Any file here is a violation.
const LOCAL_UI_ROOT = join(CLIENT_ROOT, 'components', 'ui');
const API_ROOT = join(CLIENT_ROOT, 'app', 'api');
const SERVER_ROOT = join(CLIENT_ROOT, 'server');
const ALLOWED_CLIENT_BFF_ROUTES = [
  // Better Auth (sign-in, organizations), proxied to Convex.
  '/api/auth',
  // Connections a member may bind, pre-filtered server-side.
  '/api/connections',
  '/api/preview-url',
  // Provider-neutral session model control: the upstream field is named after
  // the runtime, so the translation stays server-side and the client says `model`.
  '/api/session-model',
  // Static files: the synthetic sample matter's documents (public/sample/).
  '/sample',
];

/** Any `@kortix/sdk/<subpath>` outside the public entries. */
const SDK_SUBPATH_OUTSIDE_PUBLIC = /['"`]@kortix\/sdk\/(?!(?:react|server|genui(?:\/react|\/fence)?)['"`])[^'"`]+['"`]/g;

/**
 * Ways to reach the network without a direct `fetch(` call. They apply to
 * the browser, the Next.js server and Convex alike: Kortix calls go through
 * @kortix/sdk (the proxy through forwardKortixRequest).
 */
const SDK_SUBPATH_MESSAGE =
  'Import @kortix/sdk, @kortix/sdk/react, @kortix/sdk/genui* (and @kortix/sdk/server on the server) only: every other subpath is deprecated or internal.';

const TRANSPORT_RULES = [
  {
    scope: 'all',
    rule: 'aliased-fetch',
    // `const f = fetch`, `{ fetch: fetch }`, `call(fetch)`, `return fetch`, `fetch.call(...)`.
    pattern: /(?:[=:,(]\s*|\breturn\s+)fetch\b(?!\s*\()|\bfetch\s*\.\s*(?:call|apply|bind)\b/g,
    message: 'Do not alias fetch: Kortix calls go through @kortix/sdk.',
  },
  {
    scope: 'all',
    rule: 'raw-transport-import',
    pattern:
      /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"`](?:node:)?(?:https?|http2|net|tls|undici|axios|ky|got|node-fetch|cross-fetch)['"`]|\bnavigator\s*\.\s*sendBeacon\b/gm,
    message: 'Do not open a raw HTTP client: Kortix calls go through @kortix/sdk.',
  },
  {
    scope: 'all',
    rule: 'raw-transport',
    // `new EventSource(`, `new window.EventSource(`, `new globalThis.WebSocket(`.
    pattern: /\bnew\s+(?:(?:window|self|globalThis)\s*\.\s*)?(?:EventSource|XMLHttpRequest|WebSocket)\b/g,
    message: 'Do not open your own transport: streams and requests go through @kortix/sdk.',
  },
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
    // An allowlist: every other subpath is deprecated or internal.
    pattern: SDK_SUBPATH_OUTSIDE_PUBLIC,
    message: SDK_SUBPATH_MESSAGE,
  },
  {
    scope: 'client',
    rule: 'client-server-sdk',
    pattern: /['"`]@kortix\/sdk\/server['"`]/g,
    message: 'Browser code must not import @kortix/sdk/server: it carries Kortix credentials. Use it in src/server or src/app/api.',
  },
  ...TRANSPORT_RULES,
  {
    scope: 'client',
    rule: 'raw-transport',
    pattern: /\b(?:globalThis|window|self)\s*(?:\.\s*fetch\b|\[\s*['"`]fetch['"`]\s*\])/g,
    message: 'Client code must not open its own transport: streams and requests go through @kortix/sdk.',
  },
  {
    scope: 'client',
    rule: 'deep-ui-entry',
    pattern: /['"]@kortix\/ui\/[^'"/]+\/[^'"]+['"]/g,
    message: 'Import a curated @kortix/ui/<module> entry (cn from @kortix/ui), never a deep path.',
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
    message: 'Feature code must compose controls from @kortix/ui.',
  },
  {
    scope: 'client',
    rule: 'local-ui-import',
    pattern: /['"](?:@\/components\/ui|(?:\.{1,2}\/)+(?:components\/)?ui)\/[^'"]+['"]/g,
    message: 'UI primitives come from @kortix/ui/<name>, never a local src/components/ui.',
  },
  {
    scope: 'client',
    rule: 'foreign-ui-kit',
    pattern:
      /['"](?:lucide-react|radix-ui|@radix-ui\/[^'"]+|class-variance-authority|next-themes|react-markdown)['"]/g,
    message:
      'Compose @kortix/ui (Phosphor icons, @kortix/ui/session for markdown); do not build a second UI kit.',
  },
  {
    scope: 'client',
    rule: 'dialog-primitive',
    pattern: /['"]@kortix\/ui\/dialog['"]/g,
    message:
      'Dialog is the primitive Modal builds on: compose @kortix/ui/modal, or @kortix/ui/confirm-dialog for a destructive action.',
  },
  {
    scope: 'client',
    rule: 'direct-toast',
    pattern: /import\s*\{[^}]*\btoast\b[^}]*\}\s*from\s*['"]sonner['"]/g,
    message: 'Toasts go through @kortix/ui/toast (successToast, errorToast, …).',
  },
  {
    scope: 'client',
    rule: 'spinner-icon',
    pattern: /\bLoader2(?:Icon)?\b|animate-spin/gi,
    message: 'Feature code must use the shared Loading primitive.',
  },
];

function isFeatureClient(path) {
  return ![API_ROOT, SERVER_ROOT].some(
    (directory) => path === directory || path.startsWith(`${directory}/`),
  );
}

// Third-party APIs a server file may call directly (never Kortix). A literal prefix is required.
const ALLOWED_SERVER_THIRD_PARTY = ['https://api.stripe.com/'];

function rawFetchViolations(source, client) {
  const violations = [];
  // `fetch(` and a tagged template `fetch`…`` (it sends a real GET).
  const fetchPattern = /\bfetch\s*[(`]/g;
  for (const match of source.matchAll(fetchPattern)) {
    const expression = source.slice((match.index ?? 0) + match[0].length).trimStart();
    const target = staticFetchTarget(expression);
    const isAllowed = client
      ? target !== null &&
        ALLOWED_CLIENT_BFF_ROUTES.some(
          (route) => target === route || target.startsWith(`${route}/`) || target.startsWith(`${route}?`),
        )
      : target !== null && ALLOWED_SERVER_THIRD_PARTY.some((origin) => target.startsWith(origin));
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

export function isLocalUiFile(path) {
  return path === LOCAL_UI_ROOT || path.startsWith(`${LOCAL_UI_ROOT}/`);
}

/**
 * Convex functions: no raw fetch (Kortix goes through @kortix/sdk/server), and
 * the SDK only in "use node" files, the one runtime where it runs.
 */
export function scanConvexSource(source) {
  const violations = rawFetchViolations(source, false);
  for (const { rule, pattern, message } of [
    ...TRANSPORT_RULES,
    { rule: 'direct-runtime-import', pattern: SDK_SUBPATH_OUTSIDE_PUBLIC, message: SDK_SUBPATH_MESSAGE },
  ]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) violations.push({ rule, index: match.index, match: match[0], message });
  }
  if (!/^\s*["']use node["'];/.test(source)) {
    // Static `from`, dynamic `import()` and `require()` alike.
    for (const match of source.matchAll(
      /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"`]@kortix\/sdk(?:\/[^'"`]*)?['"`]/g,
    )) {
      violations.push({
        rule: 'convex-sdk-outside-node',
        index: match.index,
        match: match[0],
        message: 'Convex code imports @kortix/sdk only in a "use node" action file.',
      });
    }
  }
  return violations.sort((left, right) => left.index - right.index);
}

export function scanConvexBoundary() {
  return sourceFiles(CONVEX_ROOT, { extensions: SOURCE_EXTENSIONS })
    .filter((path) => !path.includes('/_generated/'))
    .flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return scanConvexSource(source).map((violation) => ({
        ...violation,
        file: relative(APP_ROOT, path),
        line: lineNumber(source, violation.index),
      }));
    });
}

export function scanWhiteLabelBoundary() {
  return sourceFiles(CLIENT_ROOT, { extensions: SOURCE_EXTENSIONS }).flatMap((path) => {
    const source = readFileSync(path, 'utf8');
    const local = isLocalUiFile(path)
      ? [
          {
            rule: 'local-ui-primitive',
            index: 0,
            match: relative(APP_ROOT, path),
            message: 'Do not add src/components/ui files: compose @kortix/ui and theme it through tokens.',
          },
        ]
      : [];
    return [...local, ...scanSource(source, { client: isFeatureClient(path) })].map(
      (violation) => ({
        ...violation,
        file: relative(APP_ROOT, path),
        line: lineNumber(source, violation.index),
      }),
    );
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
  const directTransportPattern = /\bfetch\s*[(`][^)]{0,500}\/api\/kortix(?:\/|['"`])/g;
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
      /\.test\.[cm]?[jt]sx?$/.test(path) && !path.endsWith(join('unit', 'sdk-boundary.test.ts')),
  );
  const repositoryTests = sourceFiles(REPOSITORY_TEST_ROOT, {
    extensions: SOURCE_EXTENSIONS,
  }).filter((path) => /(?:whitelabel|sdk-only-session).*\.spec\.[cm]?[jt]sx?$/.test(path));
  return [...localTests, ...repositoryTests];
}

function run() {
  const violations = [
    ...scanWhiteLabelBoundary(),
    ...scanConvexBoundary(),
    ...scanWhiteLabelTestBoundary(),
  ];
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
