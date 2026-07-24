import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import ts from 'typescript';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const FORBIDDEN_IMPORTS = [
  {
    kind: 'opencode-package',
    match: (source) => source === '@opencode-ai/sdk' || source.startsWith('@opencode-ai/sdk/'),
  },
  {
    kind: 'deprecated-sdk-runtime',
    match: (source) =>
      source === '@kortix/sdk/opencode-client' ||
      source === '@kortix/sdk/opencode-errors' ||
      source === '@kortix/sdk/event-stream' ||
      source === '@kortix/sdk/server-store' ||
      source === '@kortix/sdk/sync-store' ||
      source === '@kortix/sdk/sandbox-connection-store' ||
      source === '@kortix/sdk/opencode-pending-store',
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
