/**
 * Guardrail: `project_sessions.metadata.name` is written exactly once per
 * session, by `generateSessionTitleFromFirstPrompt()`, from the first user
 * prompt, at the first moment that prompt's text is known server-side.
 *
 * There are exactly two such moments, and therefore exactly one set of hooks:
 *   - create-with-prompt  → projects/lib/sessions.ts
 *   - first HTTP prompt   → sandbox-proxy/routes/preview.ts,
 *                           projects/session-lifecycle/engine.ts (server-side
 *                           delivery, transport-independent)
 *
 * These tests fail the build when a new create path, a new prompt transport, or
 * a second `metadata.name` writer appears, which is exactly how the invariant
 * regressed before.
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

  test('B — the title generator has exactly four entry points', () => {
    // Adding a prompt transport and titling it its own way is the failure this
    // catches; the hook set is documented here, in one enforced place.
    expect(
      offenders(/from '[^']*session-title-generate'/, [
        'projects/lib/sessions.ts',
        'projects/session-lifecycle/engine.ts',
        'sandbox-proxy/routes/preview.ts',
        // Turn-end second-chance retry: a session whose only prompt was baked
        // in-guest (KORTIX_INITIAL_PROMPT) never crosses another titling hook.
        // The generator stays the single writer (needsTitle + CAS), so this is
        // a retry of Hook 1, not a new title author.
        'projects/routes/r4.ts',
      ]),
    ).toEqual([]);
  });

  test('C — metadata.name has a single writer', () => {
    const writesSessions = /\.(insert|update)\(\s*projectSessions\b/;
    const writesName = /(?:projectSessionMetadataMerge\(\s*\{|metadata\s*:\s*\{)[^}]*\bname\s*:/s;
    const allow = [
      // THE writer.
      'projects/session-title-generate.ts',
      // body.name — the documented "I already know the title" escape hatch.
      'projects/lib/sessions.ts',
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

  test('D — every create-with-prompt producer is accounted for', () => {
    // A new producer here means a session whose only prompt is baked into the
    // sandbox: confirm Hook 1 titles it, and pass `body.title_source` if the
    // prompt is a rendered envelope rather than the user's words, then add the
    // file to this list.
    expect(
      offenders(/\binitial_prompt\s*:/, [
        'projects/lib/triggers.ts',
        'channels/slack/session.ts',
        'channels/teams/session.ts',
        'channels/telegram-webhook.ts',
        'projects/routes/r2.ts',
        'projects/routes/r10.ts',
        'projects/lib/sessions.ts',
      ]),
    ).toEqual([]);
  });

  test('F — the internal gateway key is deleted, and no route can reach that delete', () => {
    // The key title generation mints is deleted, not soft-revoked, so the key
    // list needs no exclusion — an exclusion keyed on the user-settable `name`
    // let any member mint a valid, billable key nobody could see or revoke.
    const keys = readFileSync(join(SRC, 'llm-gateway/gateway-keys.ts'), 'utf8');
    const list = keys.slice(keys.indexOf('export async function listGatewayKeys'));
    expect(list.slice(0, list.indexOf('\n}')).includes('INTERNAL_SESSION_TITLE_KEY_NAME')).toBe(
      false,
    );
    expect(
      offenders(/\bdeleteGatewayKey\b/, [
        'llm-gateway/gateway-keys.ts',
        'projects/session-title-generate.ts',
      ]),
    ).toEqual([]);
  });

  test('E — the warm create that bypasses executeCreateSession stays prompt-free', () => {
    // r7's warm coordinator calls createProjectSession directly. It carries no
    // prompt today, so Hook 1 no-ops there — but it must never quietly acquire
    // one without the titling question being asked.
    const src = readFileSync(join(SRC, 'projects/routes/r7.ts'), 'utf8');
    const at = src.indexOf('create: async (metadata) => {');
    expect(at).toBeGreaterThan(-1);
    const open = src.indexOf('body: {', at);
    const close = src.indexOf('},', open);
    expect(open).toBeGreaterThan(-1);
    expect(src.slice(open, close)).not.toContain('prompt');
  });
});
