/**
 * Guardrail: `project_sessions.metadata.name` is written exactly once per
 * session, by `generateSessionTitleFromFirstPrompt()`, from the first user
 * prompt, at the first moment that prompt's text is known server-side.
 *
 * These tests fail the build when a new create path or a second
 * `metadata.name` writer appears, which is how the invariant regressed before.
 * The generator is idempotent and compare-and-set guarded, so an extra caller
 * of it is harmless and is not listed here.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      out.push(...tsFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** Non-test source files, repo-relative to apps/api/src. */
function sourceFiles(): string[] {
  return tsFiles(SRC)
    .map((file) => file.slice(SRC.length + 1))
    .filter((rel) => !rel.startsWith('__tests__/') && !rel.includes('.test.'));
}

function offenders(pattern: RegExp, allow: readonly string[]): string[] {
  return sourceFiles().filter(
    (rel) => !allow.includes(rel) && pattern.test(readFileSync(join(SRC, rel), 'utf8')),
  );
}

describe('session-title invariant', () => {
  test('A — project_sessions is INSERTed only by the sanctioned create paths', () => {
    // A fourth INSERT is a new create path: it must run through
    // createProjectSession (which titles) or justify itself here.
    expect(
      offenders(/\.insert\(\s*projectSessions\b/, [
        'projects/lib/sessions.ts',
        'projects/suna-migration/suna-migration-phases.ts',
      ]),
    ).toEqual([]);
  });

  test('C — metadata.name has a single writer', () => {
    const writesSessions = /\.(insert|update)\(\s*projectSessions\b/;
    const writesName = /(?:projectSessionMetadataMerge\(\s*\{|metadata\s*:\s*\{)[^}]*\bname\s*:/s;
    const allow = [
      // THE writer.
      'projects/session-title-generate.ts',
      // carries the legacy Suna thread title onto the migrated row.
      'projects/suna-migration/suna-migration-phases.ts',
    ];
    const hits = sourceFiles().filter((rel) => {
      if (allow.includes(rel)) return false;
      const src = readFileSync(join(SRC, rel), 'utf8');
      return writesSessions.test(src) && writesName.test(src);
    });
    expect(hits).toEqual([]);
  });

  test('F — no route can reach the delete of the internal gateway key', () => {
    // The key title generation mints is deleted, not hidden from the key list
    // (`integration-gateway-keys.test.ts` proves both on real rows). Only the
    // generator may call that delete.
    expect(
      offenders(/\bdeleteGatewayKey\b/, [
        'llm-gateway/gateway-keys.ts',
        'projects/session-title-generate.ts',
      ]),
    ).toEqual([]);
  });
});
