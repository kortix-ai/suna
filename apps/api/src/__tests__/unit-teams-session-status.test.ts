import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// `/status` grew a Session row in #7474, keyed on a status called `idle`.
// There is no such status. The enum is queued | branching | provisioning |
// running | stopped | failed | completed, so `idle` never matched and four of
// the seven fell through to a bare `•` with the raw word beside it.
//
// A static read, not a call: `describeConversationSession` is private to
// commands.ts, and importing that module drags in the gateway model picker.

const repoRoot = join(import.meta.dir, '../../../..');
const commands = readFileSync(join(repoRoot, 'apps/api/src/channels/teams/commands.ts'), 'utf8');
const schema = readFileSync(join(repoRoot, 'packages/db/src/schema/kortix.ts'), 'utf8');

const ENUM_VALUES = (() => {
  const start = schema.indexOf("kortixSchema.enum('project_session_status', [");
  expect(start, 'project_session_status enum is missing').toBeGreaterThan(-1);
  const body = schema.slice(start, schema.indexOf(']', start));
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((v) => v !== 'project_session_status');
})();

const MAP_KEYS = (() => {
  const start = commands.indexOf('const SESSION_STATUS: Record<');
  expect(start, 'SESSION_STATUS map is missing').toBeGreaterThan(-1);
  const body = commands.slice(start, commands.indexOf('\n};', start));
  return [...body.matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map((m) => m[1]);
})();

describe('the /status session row covers the real enum', () => {
  test('the enum has the seven statuses this map is written against', () => {
    expect(ENUM_VALUES.sort()).toEqual(
      ['branching', 'completed', 'failed', 'provisioning', 'queued', 'running', 'stopped'].sort(),
    );
  });

  test('every status the database can hold has a glyph and a word', () => {
    // A status added to the enum without a row here degrades to `•` plus its
    // raw name — survivable, but this is the reminder to name it properly.
    expect(MAP_KEYS.sort()).toEqual(ENUM_VALUES.sort());
  });

  test('no key is invented — `idle` was, and silently matched nothing', () => {
    for (const key of MAP_KEYS) expect(ENUM_VALUES, `"${key}" is not a session status`).toContain(key);
    expect(MAP_KEYS).not.toContain('idle');
  });

  test('the two sandbox-build states read as one plain word, not as jargon', () => {
    // `branching` and `provisioning` describe how the sandbox is built, which
    // is not what the user asked.
    const body = commands.slice(commands.indexOf('const SESSION_STATUS: Record<'));
    expect(body).toMatch(/branching:\s*\{\s*glyph:\s*'[^']+',\s*label:\s*'starting'/);
    expect(body).toMatch(/provisioning:\s*\{\s*glyph:\s*'[^']+',\s*label:\s*'starting'/);
  });

  test('an unknown status still renders instead of being swallowed', () => {
    const fn = commands.slice(commands.indexOf('function describeConversationSession'));
    expect(fn).toContain('known?.label ?? raw');
  });
});

describe('Teams copy uses Markdown emphasis, never Slack mrkdwn', () => {
  test('no single-asterisk bold survives in a Teams string literal', () => {
    // `*text*` is bold in Slack and ITALIC in a Teams TextBlock. One had
    // slipped into the project-switch confirmation.
    const offenders: string[] = [];
    for (const [i, line] of commands.split('\n').entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      for (const lit of line.match(/`[^`]*`/g) ?? []) {
        for (const m of lit.match(/(?<!\*)\*[^*\n`]{1,90}\*(?!\*)/g) ?? []) {
          offenders.push(`${i + 1}: ${m}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
