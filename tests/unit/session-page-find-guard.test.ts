import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// `GET /projects/:id/sessions` answers one bounded PAGE (KRTX-1727, the
// 2026-09-16 learning, rule 4). A `.find(` over that page answers `null` for
// every session older than it: mobile lost a thread's actions, rename and
// title, and the SDK's `restartSandbox` reported "not found". Resolve one
// session with the by-id read (`getProjectSession`, `useProjectSession`),
// never by scanning a page.
//
// A session page here is a `listProjectSessions(...)` result, a
// `useProjectSessions(...)` result's `data`, a variable bound from either in the
// same file, or a parameter typed `ProjectSession[]` (how a page reaches a
// helper). Names are per file, not per scope: another array with a page's name
// in the same file is reported too, so give it another name. Scope: every
// tracked non-test `.ts`/`.tsx` in apps/mobile and packages/sdk/src.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCOPES = ['apps/mobile', 'packages/sdk/src'];
const LIST_CALLS = new Set(['listProjectSessions', 'useProjectSessions']);

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...SCOPES], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(
      (file) =>
        /\.(ts|tsx)$/.test(file) &&
        !/\.test\.tsx?$/.test(file) &&
        !file.includes('/node_modules/') &&
        existsSync(join(REPO_ROOT, file)),
    );
}

/** `await x`, `(x)`, `x!` and `x as T` → `x`. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

function isPageType(type: ts.TypeNode | undefined): boolean {
  if (!type) return false;
  if (ts.isTypeOperatorNode(type)) return isPageType(type.type);
  if (ts.isArrayTypeNode(type)) return ts.isTypeReferenceNode(type.elementType) && type.elementType.typeName.getText() === 'ProjectSession';
  if (ts.isTypeReferenceNode(type) && ['Array', 'ReadonlyArray'].includes(type.typeName.getText())) {
    const [element] = type.typeArguments ?? [];
    return !!element && ts.isTypeReferenceNode(element) && element.typeName.getText() === 'ProjectSession';
  }
  return false;
}

/** Each `.find(` over a session page in one file, as `<file>:<line>`. */
function sessionPageFinds(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  // Local names of the list calls (`import { listProjectSessions as listSdk }`).
  const listNames = new Set(LIST_CALLS);
  // Identifiers that hold a page in this file.
  const pages = new Set<string>();

  const isListCall = (node: ts.Expression): boolean => {
    const inner = unwrap(node);
    return ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && listNames.has(inner.expression.text);
  };
  const isPage = (node: ts.Expression): boolean => {
    const inner = unwrap(node);
    if (ts.isIdentifier(inner)) return pages.has(inner.text);
    if (isListCall(inner)) return true;
    // `useProjectSessions(...).data`
    return ts.isPropertyAccessExpression(inner) && inner.name.text === 'data' && isListCall(inner.expression);
  };

  const collect = (node: ts.Node) => {
    if (ts.isImportSpecifier(node) && LIST_CALLS.has((node.propertyName ?? node.name).text)) listNames.add(node.name.text);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && isPage(node.initializer)) pages.add(node.name.text);
      // `const { data: projectSessions = [] } = useProjectSessions(...)`
      if (ts.isObjectBindingPattern(node.name) && isListCall(node.initializer)) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          if (ts.isIdentifier(key) && key.text === 'data' && ts.isIdentifier(element.name)) pages.add(element.name.text);
        }
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && isPageType(node.type)) pages.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  // Twice: a name bound from another page name (`const rows = sessions`) is a page too.
  collect(sf);
  collect(sf);

  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'find' &&
      isPage(node.expression.expression)
    ) {
      hits.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('no .find( over a session page in apps/mobile and packages/sdk', () => {
  it('flags each shape of a page it guards', () => {
    const shapes = `
      import { listProjectSessions as listSdk, type ProjectSession } from '@kortix/sdk';
      async function a(id: string) { return (await listSdk('p')).find((s) => s.session_id === id); }
      async function b(id: string) { const rows = await listSdk('p'); return rows.find((s) => s.session_id === id); }
      function c(id: string) { const { data: sessions = [] } = useProjectSessions('p'); return sessions.find((s) => s.session_id === id); }
      function d(id: string) { return useProjectSessions('p').data?.find((s) => s.session_id === id); }
      function e(sessions: readonly ProjectSession[], id: string) { return sessions.find((s) => s.session_id === id); }
      function f(names: string[]) { return names.find((name) => name === 'x'); }
    `;
    expect(sessionPageFinds('shapes.ts', shapes).map((hit) => Number(hit.split(':')[1]))).toEqual([3, 4, 5, 6, 7]);
  });

  it('finds none in the tree', () => {
    const offenders = trackedFiles().flatMap((file) => sessionPageFinds(file, readFileSync(join(REPO_ROOT, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
