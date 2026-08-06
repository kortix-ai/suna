import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The KaaB error tables have twice documented a code the routes never return.
// A published code that does
// not exist is worse than an undocumented one: connectors branch on it, and the
// branch is dead forever. These tests read the shipped tables and check them
// against the shipped source, so the third occurrence fails here instead of in
// somebody's error handler.

const REPO_ROOT = resolve(import.meta.dir, '../../../../..');
const API_SRC = join(REPO_ROOT, 'apps/api/src');

const ERROR_TABLES = [
  'docs/KORTIX_AS_A_BACKEND_GUIDE.md',
  'apps/web/content/docs/backend.mdx',
];

function apiSourceText(): string {
  const parts: string[] = [];
  for (const entry of readdirSync(API_SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    if (path.includes('/__tests__/')) continue;
    parts.push(readFileSync(path, 'utf8'));
  }
  return parts.join('\n');
}

/**
 * Pull the error codes out of a markdown error table.
 *
 * Every cell value in those tables is backticked, so the row is read as a bag of
 * backticked tokens rather than by column index — that survives a column being
 * added or reordered, which a positional parse would not. Numeric tokens are the
 * `Status` column and prose tokens are not codes, so only identifier-shaped
 * tokens survive.
 */
function documentedErrorCodes(markdown: string): string[] {
  const lines = markdown.split('\n');
  const headerIndex = lines.findIndex(
    (line) => line.startsWith('|') && line.includes('Status') && line.includes('Code'),
  );
  expect(headerIndex).toBeGreaterThanOrEqual(0);

  const codes = new Set<string>();
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trimStart().startsWith('|')) break;
    if (/^\|[\s\-|:]+\|$/.test(line.trim())) continue;
    for (const [, token] of line.matchAll(/`([^`]+)`/g)) {
      // A cell may hold alternatives ("subscription_required / insufficient_credits").
      for (const candidate of token.split('/').map((part) => part.trim())) {
        if (!/^[A-Za-z][A-Za-z0-9_*]*$/.test(candidate)) continue;
        codes.add(candidate);
      }
    }
  }
  return [...codes];
}

/**
 * Does the API source emit this exact code?
 *
 * Whole-token, not substring. A plain `includes` accepts any documented code
 * that happens to sit inside a real one — document `SESSION_NOT_FOUND` and the
 * real `PROJECT_SESSION_NOT_FOUND` vouches for it — which is precisely the
 * phantom-code case this file exists to catch, passing silently.
 *
 * `IDEMPOTENCY_*_CONFLICT` documents a family, so `*` stands for one or more
 * identifier characters; the boundaries apply to it the same way.
 */
function emitsCode(source: string, code: string): boolean {
  const body = code
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[A-Za-z0-9_]+');
  // Not \b: that treats `_` as a word char, so `_FOO` would still match `X_FOO`.
  return new RegExp(`(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])`).test(source);
}

describe('KaaB error tables match the codes the API emits', () => {
  const source = apiSourceText();

  test('the API source is actually loaded', () => {
    // Guards the whole suite against a silently empty corpus, which would make
    // every assertion below vacuously pass.
    expect(source.length).toBeGreaterThan(1_000_000);
    expect(source).toContain('CONNECTOR_NOT_ASSIGNED');
  });

  test('no table documents a code the API never returns', () => {
    for (const relativePath of ERROR_TABLES) {
      const codes = documentedErrorCodes(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
      expect(codes.length).toBeGreaterThan(5);
      const phantom = codes.filter((code) => !emitsCode(source, code));
      expect({ [relativePath]: phantom }).toEqual({ [relativePath]: [] });
    }
  });

  test('the active CONNECTOR_CONNECTION_REQUIRED code stays in the tables', () => {
    // The required-connection gate emits this code from session creation and
    // prompt preflight. Keep both public error tables aligned with that contract.
    for (const relativePath of ERROR_TABLES) {
      expect(documentedErrorCodes(readFileSync(join(REPO_ROOT, relativePath), 'utf8'))).toContain(
        'CONNECTOR_CONNECTION_REQUIRED',
      );
    }
  });

  test('every required-connector refusal code is documented in every table', () => {
    // Derived from the resolution union rather than hand-listed, so a third
    // refusal code added to the gate fails here until it is documented.
    const union = readFileSync(join(import.meta.dir, 'session-connector-bindings.ts'), 'utf8')
      .split('export type RequiredConnectorResolution =')[1]
      ?.split('\nexport ')[0];
    expect(union).toBeTruthy();
    const gateCodes = [...(union as string).matchAll(/code: '([A-Z][A-Z0-9_]+)'/g)].map(
      ([, code]) => code,
    );
    expect(gateCodes.sort()).toEqual([
      'CONNECTOR_CONNECTION_REQUIRED',
      'REQUIRED_CONNECTOR_CONNECTION_UNAVAILABLE',
    ]);

    for (const relativePath of ERROR_TABLES) {
      const codes = documentedErrorCodes(readFileSync(join(REPO_ROOT, relativePath), 'utf8'));
      for (const code of gateCodes) expect({ relativePath, code, listed: codes.includes(code) })
        .toEqual({ relativePath, code, listed: true });
    }
  });
});
