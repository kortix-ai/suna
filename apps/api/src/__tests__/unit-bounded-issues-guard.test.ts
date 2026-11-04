/**
 * Every response that lists validation issues caps the list (KRTX-3419).
 *
 * A response puts issues in its body only through `...boundedIssues(list)`
 * (`openapi/index.ts`): the first 20 and `issue_count`. A literal `issues:`
 * property in a `c.json` body is how an uncapped list reaches a client, so this
 * reads every API source file and fails on one.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

function uncappedIssueBodies(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('issues')) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'json') {
      const body = n.arguments[0];
      const literal = body && ts.isObjectLiteralExpression(body)
        && body.properties.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'issues');
      if (literal) sites.push(`${relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

describe('validation issues reach a response only capped', () => {
  test('no c.json body sets `issues` itself', () => {
    expect(sourceFiles(SRC).flatMap(uncappedIssueBodies)).toEqual([]);
  });
});
