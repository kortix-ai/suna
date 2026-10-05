import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * The session runtime is `@kortix/sdk`'s. This guard fails when non-test
 * source brings back the deleted `lib/opencode` module, a hand-built runtime
 * route, or an OpenCode-named symbol of the SDK.
 */

const APP_ROOT = join(import.meta.dir, '..', '..');
const SOURCE_DIRS = ['api', 'app', 'components', 'contexts', 'hooks', 'lib', 'stores'];

const BANNED_TEXT: Array<[label: string, pattern: RegExp]> = [
  ['lib/opencode', /lib\/opencode/],
  ['prompt_async', /prompt_async/],
  ['/global/event', /\/global\/event/],
];
const SDK_IMPORT = /\b(?:import|export)\s+(?:type\s+)?([^;'"]*?)\s*from\s*['"](@kortix\/sdk[^'"]*)['"]/g;
const OPENCODE_NAME = /open_?code/i;

/** What `source` breaks, one label per finding. */
function findings(source: string): string[] {
  const found = BANNED_TEXT.filter(([, pattern]) => pattern.test(source)).map(([label]) => label);
  for (const [, names, specifier] of source.matchAll(SDK_IMPORT)) {
    if (OPENCODE_NAME.test(specifier)) found.push(specifier);
    for (const name of names.split(/[\s,{}]+/)) {
      if (OPENCODE_NAME.test(name)) found.push(`${name} from ${specifier}`);
    }
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe('the session runtime is the SDK', () => {
  test('the matcher flags every banned form', () => {
    expect(findings(`import { x } from '@/lib/opencode/sync-store';`)).toEqual(['lib/opencode']);
    expect(findings('fetch(`${url}/session/${id}/prompt_async`)')).toEqual(['prompt_async']);
    expect(findings('new EventSource(`${url}/global/event`)')).toEqual(['/global/event']);
    expect(findings(`import { useOpenCodeSessions } from '@kortix/sdk/react';`)).toEqual([
      'useOpenCodeSessions from @kortix/sdk/react',
    ]);
    expect(
      findings(`import type {\n  Session,\n  OpencodeClient as Client,\n} from "@kortix/sdk";`)
    ).toEqual(['OpencodeClient from @kortix/sdk']);
    expect(findings(`export { opencode_thing } from '@kortix/sdk/opencode';`)).toEqual([
      '@kortix/sdk/opencode',
      'opencode_thing from @kortix/sdk/opencode',
    ]);
  });

  test('the matcher passes the neutral forms', () => {
    expect(findings(`import { useRuntimeSessions } from '@kortix/sdk/react';`)).toEqual([]);
    expect(findings(`import { openCode } from './local';\nimport { useSession } from '@kortix/sdk/react';`)).toEqual([]);
    expect(findings(`const id = ps.runtime_session_id ?? ps.opencode_session_id;`)).toEqual([]);
  });

  test('no non-test source file breaks the boundary', () => {
    const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(APP_ROOT, dir)));
    expect(files.length).toBeGreaterThan(500);
    const broken = files.flatMap((path) =>
      findings(readFileSync(path, 'utf8')).map((finding) => `${relative(APP_ROOT, path)}: ${finding}`)
    );
    expect(broken).toEqual([]);
  });
});

/**
 * The Kortix API is `@kortix/sdk`'s too. A raw `fetch`/`EventSource` to the API
 * base (`API_URL`, `BACKEND_URL`, `getApiUrl()`, …) or a use of the SDK's
 * transport internals (`backendApi`, `authenticatedFetch`) is a violation.
 * `sdk-boundary-baseline.json` lists the ones that exist today. The scan must
 * equal it: a new violation fails, and so does a fixed one still listed — move
 * the call into the SDK, then delete its baseline line. Calls to a sandbox
 * (`sandboxUrl`), Supabase or a local asset are not API calls.
 */
const API_BASE = /\b(?:API_URL|BACKEND_URL)\b|\bget(?:Api|Backend|Platform)Url\(/;
const SDK_TRANSPORT = new Set(['backendApi', 'authenticatedFetch']);

/** The initializer of the `const`/`let` that `id` names, searched outward. */
function initializerOf(id: ts.Identifier): ts.Expression | undefined {
  for (let cur: ts.Node | undefined = id.parent; cur; cur = cur.parent) {
    if (!ts.isBlock(cur) && !ts.isSourceFile(cur)) continue;
    for (const statement of cur.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === id.text) return decl.initializer;
      }
    }
  }
  return undefined;
}

/** `kind<TAB>file<TAB>source` per violation in one file, in source order. */
export function apiBoundaryViolations(file: string, code: string): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && SDK_TRANSPORT.has(node.text)) out.push(`host-kortix-api\t${file}\t${node.text}`);
    const callee = ts.isCallExpression(node) || ts.isNewExpression(node) ? node.expression : null;
    const target = callee && (node as ts.CallExpression).arguments?.[0];
    if (callee && target && ts.isIdentifier(callee) && (callee.text === 'fetch' || callee.text === 'EventSource')) {
      const url = ts.isIdentifier(target) ? (initializerOf(target) ?? target) : target;
      if (API_BASE.test(url.getText(source))) {
        out.push(`host-kortix-network\t${file}\t${url.getText(source).replace(/\s+/g, ' ')}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe('the Kortix API is the SDK', () => {
  test('the scanner flags a raw API fetch and the SDK transport internals', () => {
    expect(apiBoundaryViolations('a.ts', 'export const f = () => fetch(`${API_URL}/billing/x`, { method: "POST" });')).toEqual([
      'host-kortix-network\ta.ts\t`${API_URL}/billing/x`',
    ]);
    expect(
      apiBoundaryViolations('b.ts', 'async function g(p: string) { const fullUrl = `${API_URL}${p}`; return fetch(fullUrl); }'),
    ).toEqual(['host-kortix-network\tb.ts\t`${API_URL}${p}`']);
    expect(apiBoundaryViolations('c.tsx', 'const s = new EventSource(`${getApiUrl()}/events`);')).toEqual([
      'host-kortix-network\tc.tsx\t`${getApiUrl()}/events`',
    ]);
    expect(apiBoundaryViolations('d.ts', "import { backendApi } from '@kortix/sdk';")).toEqual([
      'host-kortix-api\td.ts\tbackendApi',
    ]);
  });

  test('the scanner passes sandbox, Supabase and local-asset fetches', () => {
    expect(
      apiBoundaryViolations(
        'ok.ts',
        [
          'fetch(`${sandboxUrl}/kortix/health`);',
          'fetch(asset.uri);',
          'createDeadlineFetch((input, init) => fetch(input, init));',
          "import { createKortix } from '@kortix/sdk';",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  test('the scan equals the committed baseline', () => {
    const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(APP_ROOT, dir))).sort();
    const actual = files.flatMap((path) =>
      /\.tsx?$/.test(path) ? apiBoundaryViolations(relative(APP_ROOT, path), readFileSync(path, 'utf8')) : [],
    );
    const baseline = JSON.parse(readFileSync(join(import.meta.dir, 'sdk-boundary-baseline.json'), 'utf8')) as string[];
    expect(actual).toEqual(baseline);
  });
});
