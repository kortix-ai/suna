import { describe, expect, test } from 'bun:test';
// Tripwire: the CLI argument grammar lives in shared helpers, not in copies.
//
//   - an argument error is `return fail(msg)` / `return missing(what)`
//     (command-helpers.ts), not an inline `status.err(...)` write + `return 2`;
//   - subcommand help is `splitHelp(argv, HELP)` (command-argv.ts), not the
//     copied "The root help promises" preamble;
//   - a flag-only command parses with `takeFlags` (command-argv.ts), not a
//     private `parseFlags` loop that rejects `--flag=value`.
//
// ALLOWED lists legacy command files this refactor has not converted. Each
// entry must still contain its pattern, so the list shrinks as files convert.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const COMMANDS_DIR = resolve(import.meta.dir, '..', 'commands');

const ALLOWED: Record<'inlineArgError' | 'helpPreamble' | 'parseFlags', readonly string[]> = {
  inlineArgError: [
    'access.ts',
    'agents.ts',
    'connectors.ts',
    'grants.ts',
    'marketplace.ts',
    'projects.ts',
    'registry.ts',
    'secrets.ts',
    'self-host.ts',
    'sessions-chat.ts',
    'sessions-connect.ts',
    'sessions-files.ts',
    'sessions-lifecycle.ts',
    'sessions-queue.ts',
    'sessions-share.ts',
    'sessions.ts',
    'system-skills.ts',
    'triggers.ts',
  ],
  helpPreamble: ['access.ts', 'agents.ts', 'connectors.ts', 'grants.ts', 'marketplace.ts', 'secrets.ts', 'triggers.ts'],
  parseFlags: ['init.ts', 'marketplace.ts', 'system-skills.ts', 'validate.ts'],
};

/** `process.stderr.write(`${status.err(X)}\n`)` directly followed by `return 2`. */
function countInlineArgErrors(fileName: string, source: string): number {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const isStatusErrWrite = (stmt: ts.Statement): boolean => {
    if (!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression)) return false;
    const call = stmt.expression;
    if (call.expression.getText(sf) !== 'process.stderr.write' || call.arguments.length !== 1)
      return false;
    const tpl = call.arguments[0];
    return (
      ts.isTemplateExpression(tpl) &&
      tpl.head.text === '' &&
      tpl.templateSpans.length === 1 &&
      tpl.templateSpans[0].literal.text === '\n' &&
      ts.isCallExpression(tpl.templateSpans[0].expression) &&
      tpl.templateSpans[0].expression.expression.getText(sf) === 'status.err'
    );
  };
  const isReturn2 = (stmt: ts.Statement | undefined): boolean =>
    !!stmt && ts.isReturnStatement(stmt) && stmt.expression?.getText(sf) === '2';
  let count = 0;
  const visit = (node: ts.Node): void => {
    const statements =
      ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)
        ? node.statements
        : undefined;
    statements?.forEach((stmt, i) => {
      if (isStatusErrWrite(stmt) && isReturn2(statements[i + 1])) count += 1;
    });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

const files = readdirSync(COMMANDS_DIR)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .sort()
  .map((name) => ({ name, source: readFileSync(join(COMMANDS_DIR, name), 'utf8') }));

const found = {
  inlineArgError: files
    .filter((f) => countInlineArgErrors(f.name, f.source) > 0)
    .map((f) => f.name),
  helpPreamble: files.filter((f) => f.source.includes('The root help promises')).map((f) => f.name),
  parseFlags: files.filter((f) => /\bfunction parseFlags\(/.test(f.source)).map((f) => f.name),
};

describe('CLI argument grammar goes through the shared helpers', () => {
  test('the detector finds the inline pattern it guards against', () => {
    const sample =
      "function f() {\n  if (x) {\n    process.stderr.write(`${status.err('Pass --x.')}\\n`);\n    return 2;\n  }\n}\n";
    expect(countInlineArgErrors('sample.ts', sample)).toBe(1);
    expect(
      countInlineArgErrors('sample.ts', "function f() {\n  return fail('Pass --x.');\n}\n"),
    ).toBe(0);
  });

  for (const pattern of Object.keys(ALLOWED) as Array<keyof typeof ALLOWED>) {
    test(`${pattern}: only listed legacy files still carry it`, () => {
      expect(found[pattern]).toEqual([...ALLOWED[pattern]].sort());
    });
  }
});
