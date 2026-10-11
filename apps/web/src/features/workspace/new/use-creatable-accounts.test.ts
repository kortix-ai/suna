import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `useCreatableAccounts` cannot render under `bun test` (no jsdom /
 * `@testing-library/react` harness in this app, and mocking
 * `@tanstack/react-query` process-wide would corrupt every other file in the
 * run), so the behavior lives in `canCreateInAccount` — pure and covered by
 * `new-workspace-form.test.ts` — while this file pins the wiring the pure test
 * cannot see: the hook must feed the settled probe verdict through that one
 * decision point, never fall back to a bare `=== true`, which is the pending
 * verdict that misrendered a fresh owner's first /projects as "ask an admin"
 * (KRTX-1700).
 */
const source = readFileSync(join(import.meta.dir, 'use-creatable-accounts.ts'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('useCreatableAccounts: the source the components actually render', () => {
  test('every verdict passes through the shared canCreateInAccount decision point', () => {
    expect(code).toContain("import { canCreateInAccount, filterCreatableAccounts } from './new-workspace-form'");
    expect(code).toContain('canCreateInAccount(account, verdicts[i]?.data?.allowed)');
    // The decision point is the ONE place the pending rule lives (paired
    // negative, as in new-workspace-page.test.ts): re-deciding here would let
    // the hook and the form drift apart.
    expect(code).not.toContain("account.account_role === 'owner'");
  });

  test('a bare settled-verdict comparison never returns', () => {
    // The exact regression: `verdicts[i]?.data?.allowed === true` reads a
    // pending probe as "no" and flips every account to empty-member until the
    // probes land.
    expect(code).not.toContain('=== true');
  });
});
