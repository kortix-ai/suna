/**
 * `kortix-api/guarded-status` (apps/api/eslint.config.mjs) refuses a blind
 * `.update(<guarded table>).set({ status })` outside the table's owner
 * module, and lets the owner write it.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';

const API = resolve(import.meta.dir, '../..');
const eslint = new ESLint({ cwd: API, overrideConfigFile: resolve(API, 'eslint.config.mjs') });

async function ruleHits(file: string, code: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(API, file) });
  return result!.messages.filter((m) => m.ruleId === 'kortix-api/guarded-status').length;
}

const BLIND = `
import { changeRequests } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
export async function close(id: string) {
  await db.update(changeRequests).set({ status: 'closed' }).where(eq(changeRequests.crId, id));
}
`;

describe('kortix-api/guarded-status', () => {
  test('a status write on a guarded table outside its owner is an error', async () => {
    expect(await ruleHits('src/projects/some-other-module.ts', BLIND)).toBe(1);
  });

  test('the owner module may write the status', async () => {
    expect(await ruleHits('src/projects/change-requests.ts', BLIND)).toBe(0);
  });

  test('a non-status write on a guarded table is allowed anywhere', async () => {
    const code = BLIND.replace("{ status: 'closed' }", "{ title: 'renamed' }");
    expect(await ruleHits('src/projects/some-other-module.ts', code)).toBe(0);
  });
});
