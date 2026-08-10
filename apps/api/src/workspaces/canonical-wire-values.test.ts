import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function source(relativePath: string): string {
  return readFileSync(join(import.meta.dir, relativePath), 'utf8');
}

describe('canonical Workspace request values', () => {
  test('Workspace routes advertise Workspace scopes, not persisted Project scopes', () => {
    const modelDefaults = source('routes/r4.ts');
    const sessions = source('routes/r7.ts');
    const gateway = source('routes/gateway.ts');

    expect(modelDefaults).toContain("scope: z.enum(['account', 'agent', 'workspace'])");
    expect(sessions).toContain("scope: z.enum(['visible', 'workspace']).optional()");
    expect(gateway).toContain("scope: z.enum(['workspace', 'member'])");
  });
});
