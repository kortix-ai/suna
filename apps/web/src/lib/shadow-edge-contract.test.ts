import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { expect, test } from 'bun:test';
import ts from 'typescript';

const SOURCE_ROOT = join(import.meta.dir, '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

function baseUtility(token: string): string {
  return token.slice(token.lastIndexOf(':') + 1).replace(/^!/, '');
}

test('standard smooth shadow aliases do not carry a duplicate decorative edge', () => {
  const violations: string[] = [];

  for (const file of sourceFiles(SOURCE_ROOT)) {
    const sourceText = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);

    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) {
        const utilities = node.text.split(/\s+/).map(baseUtility);
        const hasStandardShadow = utilities.some((value) => /^shadow-(sm|md|lg)$/.test(value));
        const hasDecorativeEdge = utilities.some(
          (value) => value === 'border' || value === 'ring-1' || value === 'ring-[1px]',
        );

        if (hasStandardShadow && hasDecorativeEdge) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          violations.push(`${relative(SOURCE_ROOT, file)}:${line} ${node.text.trim()}`);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  expect(violations).toEqual([]);
});
