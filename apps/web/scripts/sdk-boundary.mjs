import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { sourceFiles } from '../../../scripts/lib/sdk-boundary-scan.mjs';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * The only `@kortix/sdk` entry points apps/web production code may import.
 *
 *  - `@kortix/sdk`         — the canonical root barrel. Everything
 *                            framework-free lives here; every legacy subpath
 *                            is only an alias for a slice of it (asserted by
 *                            `packages/sdk/src/root-canonical.test.ts`).
 *  - `@kortix/sdk/react`   — hooks and providers. React is an optional peer
 *                            dependency, so it cannot live at the root.
 *  - `@kortix/sdk/server`  — Node-only (`node:async_hooks`) per-request config
 *                            isolation, for route handlers and RSC.
 *  - `@kortix/sdk/internal/*` — three browser-only internal modules apps/web
 *                            must share with the SDK. None of them can be
 *                            re-exported from the isomorphic root:
 *      - `idb-sync-cache`    the device keeps saved session copies in
 *                            IndexedDB (`lib/device-caches.ts`), and
 *                            sign-out clears them (`reset-client-state.ts`).
 *      - `diagnostics-store` the SDK event stream writes LSP diagnostics into
 *                            this zustand store; the file viewer reads it
 *                            through the `@/stores/diagnostics-store` shim.
 *      - `managed-storage`   disposable caches register here; quota
 *                            reclaim and the boot prune go through the
 *                            `@/lib/storage/managed-storage` shim.
 *                            Each import carries an inline eslint disable. The other four zustand
 *                            stores under `internal/` stay forbidden.
 *  - `@kortix/sdk/genui/fence` — OpenUI fence detection for the markdown
 *                            code renderer (`components/markdown/code/
 *                            markdown-code.tsx`). It never loads `@openuidev/*`
 *                            or `zod`, which the `./genui` barrel does at
 *                            module load. The import carries an inline eslint
 *                            disable (the `@kortix/sdk/*` gitignore pattern
 *                            cannot re-include a path under `genui/`).
 *  - `@kortix/sdk/genui/react` — the generative UI renderer. One import, in
 *                            `features/genui/sdk.ts`, a feature that
 *                            `markdown-code.tsx` reaches only through `lazy()`,
 *                            so `@openuidev/*` and `zod` stay out of the main
 *                            bundle. The import carries an inline eslint disable.
 *
 * The `@kortix/sdk/genui` barrel loads `@openuidev/*` and `zod` at module load,
 * so a static import of it belongs only in lazily loaded genui code. Copy and
 * transcript export (in the main session chunk) reach it through the dynamic
 * `import()` in `features/genui/to-markdown.ts`, which runs only for text that
 * contains "openui". Neither this scan nor the eslint rule inspects `import()`.
 */
const CANONICAL_SDK_ENTRIES = new Set([
  '@kortix/sdk',
  '@kortix/sdk/react',
  '@kortix/sdk/server',
  '@kortix/sdk/workspace-search',
  '@kortix/sdk/internal/idb-sync-cache',
  '@kortix/sdk/internal/diagnostics-store',
  '@kortix/sdk/internal/managed-storage',
  '@kortix/sdk/genui/fence',
  '@kortix/sdk/genui/react',
]);

const FORBIDDEN_IMPORTS = [
  {
    kind: 'opencode-import',
    match: (source) => source.toLowerCase().includes('opencode'),
  },
  {
    kind: 'opencode-package',
    match: (source) => source === '@opencode-ai/sdk' || source.startsWith('@opencode-ai/sdk/'),
  },
  {
    kind: 'non-canonical-sdk-entry',
    /**
     * An ALLOWLIST, not a denylist. `@kortix/sdk` publishes ~27 subpaths; all
     * but a handful are `@deprecated` aliases kept alive for external
     * consumers until the next major. apps/web is not one of those consumers,
     * so it uses the canonical entry points only.
     *
     * This was a denylist naming 13 specific subpaths, and it had exactly the
     * hole a denylist always grows: `@kortix/sdk/idb-sync-cache` was never
     * added, so a production dependency on the SDK's IndexedDB internals sat
     * unnoticed in `lib/utils/reset-client-state.ts`. Inverting the rule
     * closes that class of gap permanently — a subpath added to the SDK
     * tomorrow is forbidden here by default, and allowing it becomes a
     * deliberate edit to this list.
     */
    match: (source) => {
      if (source !== '@kortix/sdk' && !source.startsWith('@kortix/sdk/')) return false;
      return !CANONICAL_SDK_ENTRIES.has(source);
    },
  },
  {
    kind: 'host-runtime-module',
    match: (source) =>
      source.startsWith('@/hooks/opencode/') ||
      source === '@/lib/opencode-sdk' ||
      source === '@/stores/server-store' ||
      source.startsWith('@/stores/opencode-') ||
      source === '@/stores/pending-queue-store' ||
      source === '@/stores/pending-files-store',
  },
  {
    kind: 'host-kortix-api',
    match: (source) =>
      source === '@/lib/api' ||
      source.startsWith('@/lib/api/') ||
      source === '@/lib/api-client' ||
      source.endsWith('/api-client'),
  },
];

const FORBIDDEN_RUNTIME_IDENTIFIERS = new Set([
  'getClient',
  'getActiveOpenCodeUrl',
  'createKortixPty',
  'getKortixPtyWebSocketUrl',
  'removeKortixPty',
]);

const FORBIDDEN_RUNTIME_PATHS = [
  /\/v1\/p\//,
  /^\/(?:event|session|message|question|permission|file|pty)(?:\/|\?|$)/,
];

const FORBIDDEN_KORTIX_NETWORK_PATHS = [
  /\/p\/public-share\//,
  /\/admin\/stress-test\/run/,
  /\/setup-links\//,
  /\/access\/(?:check-email|request-access)/,
  /\/oauth\/authorize\/consent/,
  /\/auth\/logout/,
  /\/system\/(?:maintenance|demo-request)/,
  /\/user-roles/,
];

const RUNTIME_NOT_READY_PHRASE = /opencode not ready/i;
const RUNTIME_QUERY_KEY_ROOT = 'opencode';

const QUERY_CACHE_METHODS = new Set([
  'cancelQueries',
  'ensureQueryData',
  'fetchQuery',
  'getQueryData',
  'getQueryState',
  'invalidateQueries',
  'prefetchQuery',
  'refetchQueries',
  'removeQueries',
  'resetQueries',
  'setQueryData',
]);

/**
 * An array literal used as a React Query key: the value of a `queryKey`
 * property, or the first argument of a query-cache method. A plain list that
 * starts with the word (provider ids, a demo table) is not a key.
 */
function isQueryKey(array) {
  const parent = array.parent;
  if (ts.isPropertyAssignment(parent)) return parent.name.getText() === 'queryKey';
  return (
    ts.isCallExpression(parent) &&
    parent.arguments[0] === array &&
    ts.isPropertyAccessExpression(parent.expression) &&
    QUERY_CACHE_METHODS.has(parent.expression.name.text)
  );
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function importViolation(source) {
  return FORBIDDEN_IMPORTS.find((rule) => rule.match(source))?.kind ?? null;
}

function runtimePathViolation(value) {
  return FORBIDDEN_RUNTIME_PATHS.some((pattern) => pattern.test(value));
}

function networkPathViolation(value) {
  return FORBIDDEN_KORTIX_NETWORK_PATHS.some((pattern) => pattern.test(value));
}

// A `fetch` whose URL is built from the backend base is a hand-rolled Kortix
// API call, whatever its path: the path denylist above cannot name every route.
const BACKEND_BASE = /\b(?:BACKEND_URL|backendUrl|getBackendUrl|getApiUrl)\b/;

/** The initializer of the `const`/`let` named `identifier`, searched outward. */
function initializerOf(identifier) {
  for (let node = identifier.parent; node; node = node.parent) {
    if (!ts.isBlock(node) && !ts.isSourceFile(node)) continue;
    for (const statement of node.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === identifier.text) {
          return declaration.initializer;
        }
      }
    }
  }
  return undefined;
}

function networkTargetText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return `${node.head.text}${node.templateSpans
      .map((span) => `\${}${span.literal.text}`)
      .join('')}`;
  }
  return '';
}

export function scanSdkBoundary(sourceRoot) {
  const violations = [];
  for (const absolute of sourceFiles(sourceRoot, {
    extensions: SOURCE_EXTENSIONS,
    skip: (path) => TEST_FILE.test(path),
    sort: true,
  })) {
    const code = readFileSync(absolute, 'utf8');
    const sourceFile = ts.createSourceFile(
      absolute,
      code,
      ts.ScriptTarget.Latest,
      true,
      absolute.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const file = relative(sourceRoot, absolute).replaceAll('\\', '/');
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const source = node.moduleSpecifier.text;
        const kind = importViolation(source);
        if (kind) {
          violations.push({ file, line: lineOf(sourceFile, node), kind, source });
        }
        if (ts.isImportDeclaration(node) && node.importClause) {
          const importedNames = [];
          if (node.importClause.name) importedNames.push(node.importClause.name.text);
          const bindings = node.importClause.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              importedNames.push(element.propertyName?.text ?? element.name.text);
            }
          }
          for (const importedName of importedNames) {
            if (importedName.toLowerCase().includes('opencode')) {
              violations.push({
                file,
                line: lineOf(sourceFile, node),
                kind: 'opencode-import',
                source: importedName,
              });
            }
          }
        }
      }
      if (
        ts.isIdentifier(node) &&
        (node.text === 'backendApi' || node.text === 'authenticatedFetch')
      ) {
        violations.push({
          file,
          line: lineOf(sourceFile, node),
          kind: 'host-kortix-api',
          source: node.text,
        });
      }
      if (ts.isIdentifier(node) && FORBIDDEN_RUNTIME_IDENTIFIERS.has(node.text)) {
        violations.push({
          file,
          line: lineOf(sourceFile, node),
          kind: 'host-runtime-client',
          source: node.text,
        });
      }
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        runtimePathViolation(node.text)
      ) {
        violations.push({
          file,
          line: lineOf(sourceFile, node),
          kind: 'host-runtime-path',
          source: node.text,
        });
      }
      if (ts.isTemplateExpression(node)) {
        const templateText = `${node.head.text}${node.templateSpans
          .map((span) => `\${}${span.literal.text}`)
          .join('')}`;
        if (runtimePathViolation(templateText)) {
          violations.push({
            file,
            line: lineOf(sourceFile, node),
            kind: 'host-runtime-path',
            source: templateText,
          });
        }
      }
      // F2: the daemon's not-ready answer differs per harness and the SDK
      // classifies every spelling (`isRuntimeNotReadyResponse`,
      // `isRuntimeStartingError`, `RUNTIME_NOT_READY_MARKERS`). A phrase
      // spelled here covers one harness and drifts.
      const literalText = ts.isTemplateExpression(node)
        ? networkTargetText(node)
        : ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isRegularExpressionLiteral(node)
          ? node.text
          : '';
      if (RUNTIME_NOT_READY_PHRASE.test(literalText)) {
        violations.push({
          file,
          line: lineOf(sourceFile, node),
          kind: 'runtime-not-ready-string',
          source: literalText,
        });
      }
      // F2: runtime cache keys are the SDK's (`runtimeKeys`,
      // `resetRuntimeQueries`); their root segment is not a host contract.
      if (
        ts.isArrayLiteralExpression(node) &&
        node.elements[0] &&
        ts.isStringLiteral(node.elements[0]) &&
        node.elements[0].text === RUNTIME_QUERY_KEY_ROOT &&
        isQueryKey(node)
      ) {
        violations.push({
          file,
          line: lineOf(sourceFile, node),
          kind: 'runtime-query-key',
          source: RUNTIME_QUERY_KEY_ROOT,
        });
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'fetch' || node.expression.text === 'EventSource') &&
        node.arguments[0]
      ) {
        const argument = node.arguments[0];
        const urlNode = ts.isIdentifier(argument) ? (initializerOf(argument) ?? argument) : argument;
        const target = networkTargetText(argument) || networkTargetText(urlNode);
        if (
          (target && networkPathViolation(target)) ||
          (node.expression.text === 'fetch' && BACKEND_BASE.test(urlNode.getText(sourceFile)))
        ) {
          violations.push({
            file,
            line: lineOf(sourceFile, node),
            kind: 'host-kortix-network',
            source: target || urlNode.getText(sourceFile),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return violations.sort((a, b) => {
    const fileOrder = a.file.localeCompare(b.file);
    if (fileOrder !== 0) return fileOrder;
    if (a.line !== b.line) return a.line - b.line;
    return a.kind.localeCompare(b.kind);
  });
}

export function violationKey(violation) {
  return `${violation.kind}\t${violation.file}\t${violation.source}`;
}
