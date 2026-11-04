import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The /status session words live in channels/core/display.ts (display.test.ts).

const repoRoot = join(import.meta.dir, '../../../..');
const commands = readFileSync(join(repoRoot, 'apps/api/src/channels/teams/commands.ts'), 'utf8');

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
