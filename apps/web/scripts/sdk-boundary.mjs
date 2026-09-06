import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import ts from 'typescript';

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
 *  - `@kortix/sdk/internal/idb-sync-cache` — the ONE internal module apps/web
 *                            legitimately needs: sign-out must clear the
 *                            per-user cached session transcripts out of
 *                            IndexedDB, and that cache is browser-only, so it
 *                            cannot be re-exported from the isomorphic root.
 *                            The four zustand stores next to it stay
 *                            forbidden — apps/web production code uses none of
 *                            them, and it should stay that way.
 */
const CANONICAL_SDK_ENTRIES = new Set([
  '@kortix/sdk',
  '@kortix/sdk/react',
  '@kortix/sdk/server',
  '@kortix/sdk/internal/idb-sync-cache',
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
  /\/tunnel\/permission-requests\/stream/,
  /\/p\/public-share\//,
  /\/admin\/stress-test\/run/,
  /\/setup-links\//,
  /\/access\/(?:check-email|request-access)/,
  /\/oauth\/authorize\/consent/,
  /\/auth\/logout/,
  /\/system\/(?:maintenance|demo-request)/,
  /\/user-roles/,
];

function productionSourceFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(extname(entry.name)) || TEST_FILE.test(entry.name)) continue;
      files.push(absolute);
    }
  };
  visit(root);
  return files.sort();
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
  for (const absolute of productionSourceFiles(sourceRoot)) {
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
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'fetch' || node.expression.text === 'EventSource') &&
        node.arguments[0]
      ) {
        const target = networkTargetText(node.arguments[0]);
        if (target && networkPathViolation(target)) {
          violations.push({
            file,
            line: lineOf(sourceFile, node),
            kind: 'host-kortix-network',
            source: target,
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
