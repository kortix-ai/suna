import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The gateway budgets read kortix.gateway_spend_daily, a running total that an
// AFTER INSERT trigger keeps (migration 20261020122531072_gateway_spend_daily).
// An UPDATE, DELETE or TRUNCATE of gateway_request_logs changes the log SUM
// but not the total, so block budgets would over-admit or deny silently. A
// cost correction must also re-insert the affected days into
// gateway_spend_pending_days; then add its file to ALLOWED with that reason.

const ROOT = join(import.meta.dirname, '..', '..');
const SINCE = '20261020122531072';
const ALLOWED = new Set<string>();

const MUTATION =
  /\b(update|delete\s+from|truncate(\s+table)?)\s+("?kortix"?\.)?"?gateway_request_logs\b|\.(update|delete)\(\s*gatewayRequestLogs\b/i;

function offenders(): string[] {
  const files = execFileSync('git', ['ls-files', 'apps/api/src', 'packages/db/migrations'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => /\.(ts|sql)$/.test(f) && !/\.test\.ts$|\/__tests__\//.test(f) && !ALLOWED.has(f))
    .filter((f) => !f.startsWith('packages/db/migrations/') || f.split('/').pop()! > SINCE);
  return files.filter((f) => MUTATION.test(readFileSync(join(ROOT, f), 'utf8')));
}

describe('gateway_request_logs stays insert-only', () => {
  it('matches the forms a mutation takes', () => {
    for (const s of [
      'UPDATE kortix.gateway_request_logs SET x = 1',
      'delete from "kortix"."gateway_request_logs" where',
      'TRUNCATE TABLE gateway_request_logs',
      'await tx.update(gatewayRequestLogs).set({})',
      'db.delete( gatewayRequestLogs)',
    ]) {
      expect(MUTATION.test(s), s).toBe(true);
    }
    expect(MUTATION.test('insert into kortix.gateway_request_logs')).toBe(false);
    expect(MUTATION.test('db.insert(gatewayRequestLogs)')).toBe(false);
  });

  it('no API source file or later migration updates, deletes or truncates the log rows', () => {
    expect(offenders()).toEqual([]);
  });
});
