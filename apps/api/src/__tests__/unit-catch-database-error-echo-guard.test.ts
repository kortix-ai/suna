/**
 * No route answers a database error with its message (KRTX-3422).
 *
 * `DrizzleQueryError.message` is the whole generated statement plus its bound
 * parameters. A route `catch` that echoes the caught error's message sends that
 * to the client: a duplicate sandbox-template slug answered 400 with the
 * INSERT, all 25 column names and the project and account ids. The global
 * handler (`http-errors.ts`) already answers an uncaught database error with a
 * generic 500 and keeps the query in the log, so a catch-all must hand it on:
 * `rethrowDatabaseError(err)` before the echo.
 *
 * This reads every API source file and fails on a `c.json`/`c.text` inside a
 * `catch` whose body uses the caught error's message, unless the path to it is
 * narrowed first: an `if` on the error (other than `instanceof Error`), an
 * early `if (…) throw err`, or a `rethrowDatabaseError(err)` call. A `try`
 * with no `await` is skipped: a query rejects into a catch only when awaited.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import ts from 'typescript';

const SRC = join(import.meta.dir, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') sourceFiles(path, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isVariable(node: ts.Expression, name: string): boolean {
  const inner = unwrap(node);
  return ts.isIdentifier(inner) && inner.text === name;
}

/**
 * Helpers that never return a database error's message: they read a code or a
 * status, or (`adminErrorMessage`, `contractFailure`) say a database error through
 * `databaseErrorSummary`, which drops the statement and its parameters.
 */
const DATABASE_SAFE_HELPERS = new Set([
  'errorSqlstate',
  'emailUpstreamStatus',
  'isDatabaseError',
  'databaseErrorSummary',
  'adminErrorMessage',
  'contractFailure',
]);

function calleeName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
}

/**
 * True when `node` reads the caught error's message, or a local derived from it.
 * The caught error passed to any other helper counts too: `adminErrorMessage(e)`
 * returned the whole statement while the scan stayed green.
 */
function readsMessage(node: ts.Node, caught: string, derived: Set<string>): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'message' && isVariable(n.expression, caught)) {
      found = true;
    } else if (
      ts.isCallExpression(n)
      && ts.isIdentifier(n.expression)
      && n.expression.text === 'String'
      && n.arguments[0]
      && isVariable(n.arguments[0], caught)
    ) {
      found = true;
    } else if (
      ts.isCallExpression(n)
      && !DATABASE_SAFE_HELPERS.has(calleeName(n))
      && n.arguments.some((argument) => isVariable(argument, caught))
    ) {
      found = true;
    } else if (ts.isIdentifier(n) && derived.has(n.text)) {
      const parent = n.parent;
      const isKey = (ts.isPropertyAssignment(parent) && parent.name === n)
        || (ts.isPropertyAccessExpression(parent) && parent.name === n);
      if (!isKey) found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** True when an `if` condition tests the caught error itself (not only `instanceof Error`). */
function narrows(condition: ts.Expression, caught: string, derived: Set<string>): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      ts.isBinaryExpression(n)
      && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
      && isVariable(n.left, caught)
      && ts.isIdentifier(n.right)
      && n.right.text === 'Error'
    ) {
      return;
    }
    if (ts.isIdentifier(n) && (n.text === caught || derived.has(n.text))) found = true;
    ts.forEachChild(n, visit);
  };
  visit(condition);
  return found;
}

function throwsCaught(statement: ts.Statement, caught: string): boolean {
  if (ts.isThrowStatement(statement)) return isVariable(statement.expression, caught);
  if (ts.isBlock(statement)) return statement.statements.some((s) => throwsCaught(s, caught));
  return false;
}

/** True when `statement` always returns or throws. */
function leaves(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  return ts.isBlock(statement) && statement.statements.some(leaves);
}

/** A statement after which the rest of its block can only see a non-database error. */
function handsOnDatabaseErrors(statement: ts.Statement, caught: string, derived: Set<string>): boolean {
  if (
    ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression)
    && ts.isIdentifier(statement.expression.expression)
    && statement.expression.expression.text === 'rethrowDatabaseError'
  ) {
    return true;
  }
  // `if (isDatabaseError(err)) return …` answers a database error itself.
  if (
    ts.isIfStatement(statement)
    && ts.isCallExpression(unwrap(statement.expression))
    && calleeName(unwrap(statement.expression) as ts.CallExpression) === 'isDatabaseError'
    && (unwrap(statement.expression) as ts.CallExpression).arguments.some((argument) => isVariable(argument, caught))
    && leaves(statement.thenStatement)
  ) {
    return true;
  }
  // Only a negated test narrows: `if (!(err instanceof Typed)) throw err` lets the typed
  // error through. `if (err instanceof Typed) throw err` lets everything else through.
  const condition = ts.isIfStatement(statement) ? unwrap(statement.expression) : null;
  return condition !== null
    && ts.isPrefixUnaryExpression(condition)
    && condition.operator === ts.SyntaxKind.ExclamationToken
    && throwsCaught((statement as ts.IfStatement).thenStatement, caught)
    && narrows(condition.operand, caught, derived);
}

/** A database query only rejects into a `catch` through an `await` in its own `try` block. */
function awaits(block: ts.Block): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found || ts.isFunctionLike(n)) return;
    if (ts.isAwaitExpression(n) || (ts.isForOfStatement(n) && n.awaitModifier)) found = true;
    ts.forEachChild(n, visit);
  };
  visit(block);
  return found;
}

function echoSites(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('catch')) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: string[] = [];

  const scanCatch = (clause: ts.CatchClause) => {
    const binding = clause.variableDeclaration?.name;
    if (!binding || !ts.isIdentifier(binding)) return;
    if (!awaits((clause.parent as ts.TryStatement).tryBlock)) return;
    const caught = binding.text;
    const derived = new Set<string>();
    const collect = (n: ts.Node) => {
      // A local holding the error itself (`const e = err as Error`, `flag ? err : other`)
      // or anything read from it.
      const held = (init: ts.Expression) => {
        const inner = unwrap(init);
        if (isVariable(inner, caught)) return true;
        if (!ts.isConditionalExpression(inner)) return false;
        // `err instanceof Typed ? err : generic` keeps only the typed error.
        return (isVariable(inner.whenTrue, caught) && !narrows(inner.condition, caught, derived))
          || isVariable(inner.whenFalse, caught);
      };
      if (
        ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
        && (held(n.initializer) || readsMessage(n.initializer, caught, derived))
      ) {
        derived.add(n.name.text);
      }
      ts.forEachChild(n, collect);
    };
    collect(clause.block);

    const scan = (n: ts.Node, narrowed: boolean): void => {
      if (ts.isBlock(n)) {
        let blockNarrowed = narrowed;
        for (const statement of n.statements) {
          scan(statement, blockNarrowed);
          if (handsOnDatabaseErrors(statement, caught, derived)) blockNarrowed = true;
        }
        return;
      }
      if (ts.isIfStatement(n)) {
        scan(n.expression, narrowed);
        scan(n.thenStatement, narrowed || narrows(n.expression, caught, derived));
        if (n.elseStatement) scan(n.elseStatement, narrowed);
        return;
      }
      if (
        !narrowed
        && ts.isCallExpression(n)
        && ts.isPropertyAccessExpression(n.expression)
        && (n.expression.name.text === 'json' || n.expression.name.text === 'text')
        && n.arguments[0]
        && readsMessage(n.arguments[0], caught, derived)
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        sites.push(`${relative(SRC, file)}:${line + 1}`);
      }
      ts.forEachChild(n, (child) => scan(child, narrowed));
    };
    scan(clause.block, false);
  };

  const visit = (n: ts.Node) => {
    if (ts.isCatchClause(n)) scanCatch(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

describe('route catch blocks never echo a database error', () => {
  test('every catch-all echo hands database errors to the global handler first', () => {
    const sites = sourceFiles(SRC).flatMap(echoSites);
    expect(sites).toEqual([]);
  });

  test('the scan finds an unguarded echo and accepts each narrowing form', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catch-echo-guard-'));
    const fixture = join(dir, 'fixture.ts');
    const cases = `
      async function a(c: any) { try { await x(); } catch (err) { return c.json({ error: (err as Error).message }, 400); } }
      async function b(c: any) { try { await x(); } catch (err) { const message = err instanceof Error ? err.message : String(err); return c.json({ error: \`failed: \${message}\` }, 502); } }
      async function d(c: any) { try { await x(); } catch (err) { if (err instanceof Error) return c.json({ error: err.message }, 400); } }
      async function e(c: any) { try { await x(); } catch (err) { if (err instanceof TypedError) throw err; return c.json({ error: (err as Error).message }, 400); } }
      async function f(c: any) { try { await x(); } catch (err) { return c.json({ error: describe(err) }, 400); } }
      async function g(c: any) { try { await x(); } catch (err) { const e = err as Error; return c.json({ error: e.message }, 400); } }
      async function h(c: any) { try { await x(); } catch (err) { const e = (flag ? err : other) as Error; return c.json({ error: e.message }, 400); } }
      async function ok1(c: any) { try { await x(); } catch (err) { rethrowDatabaseError(err); return c.json({ error: (err as Error).message }, 400); } }
      async function ok2(c: any) { try { await x(); } catch (err) { if (err instanceof TypedError) return c.json({ error: err.message }, 409); throw err; } }
      async function ok3(c: any) { try { await x(); } catch (err) { if (!(err instanceof TypedError)) throw err; return c.json({ error: err.message }, 409); } }
      async function ok4(c: any) { try { await x(); } catch (err) { return c.json({ error: true, message: 'Internal server error' }, 500); } }
      function ok5(c: any) { try { parse(); } catch (err) { return c.json({ error: (err as Error).message }, 400); } }
      async function ok6(c: any) { try { await x(); } catch (err) { return c.json({ code: errorSqlstate(err) }, 500); } }
      async function ok8(c: any) { try { await x(); } catch (err) { const e = err instanceof TypedError ? err : new TypedError('failed'); return c.json({ error: e.message }, 502); } }
      async function ok7(c: any) { try { await x(); } catch (err) { if (isDatabaseError(err)) return c.json({ error: 'Internal error' }, 500); return c.json({ error: (err as Error).message }, 400); } }
    `;
    writeFileSync(fixture, cases);
    try {
      const lines = echoSites(fixture).map((site) => Number(site.split(':').pop()));
      expect(lines).toEqual([2, 3, 4, 5, 6, 7, 8]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
