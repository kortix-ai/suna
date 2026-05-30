import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('kortix-projects SQL safety', () => {
  test('project session sandbox lookup uses Drizzle query builder instead of interpolated SQL', () => {
    const source = readFileSync(join(import.meta.dir, '../projects/index.ts'), 'utf8');

    expect(source).toContain('from(sessionSandboxes)');
    expect(source).toContain('eq(sessionSandboxes.sessionId, sessionId)');
    expect(source).toContain('eq(sessionSandboxes.projectId, projectId)');
    expect(source).toContain('eq(sessionSandboxes.accountId, loaded.row.accountId)');
    expect(source).not.toContain("accountId.replace(/'/g");
    expect(source).not.toContain('db.execute(`');
    expect(source).not.toContain("where account_id = '");
  });
});
