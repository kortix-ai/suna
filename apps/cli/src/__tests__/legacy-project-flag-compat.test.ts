import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function commandSource(name: string): string {
  return readFileSync(join(import.meta.dir, '..', 'commands', name), 'utf8');
}

describe('deprecated Project flag compatibility', () => {
  for (const command of ['apps.ts', 'ship.ts']) {
    test(`${command} accepts --project as an alias for --workspace`, () => {
      const source = commandSource(command);
      expect(source).toContain("['--workspace', '--project']");
      expect(source).not.toContain("['--workspace', '--workspace']");
    });
  }

  test('Apps help labels the deprecated alias accurately', () => {
    const source = commandSource('apps.ts');
    expect(source).toContain('--project <id>');
    expect(source).toContain('Deprecated alias for --workspace.');
    expect(source).not.toContain('--workspace <id>     Deprecated alias for --workspace.');
  });
});
