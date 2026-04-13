import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('kortix-projects SQL safety', () => {
  test('resolveActiveSandbox uses Drizzle query builder instead of interpolated SQL', () => {
    const source = readFileSync(join(import.meta.dir, '../routes/kortix-projects.ts'), 'utf8');

    expect(source).toContain("where(eq(sandboxes.accountId, accountId))");
    expect(source).toContain('orderBy(desc(sandboxes.updatedAt))');
    expect(source).not.toContain("accountId.replace(/'/g");
    expect(source).not.toContain('db.execute(`');
    expect(source).not.toContain("where account_id = '");
  });
});
