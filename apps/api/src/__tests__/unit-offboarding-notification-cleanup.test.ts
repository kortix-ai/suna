/**
 * Every account exit path drops the member's notification rows of that
 * account (KRTX-1742): member removal, leave and SCIM deprovision. Without it
 * the bell and the digest keep naming the account's sessions until the row is
 * 90 days old, and a watcher row keeps the departed member on the recipient
 * list (the read filter hides the rows; the delete removes them).
 *
 * Asserted against the source, like `unit-scim-helpers.test.ts`: the handlers
 * are long, their collaborators are DB deletes and Stripe, and the property
 * that matters is that the call is on each path, after the membership checks.
 * `notifications/cleanup.integration.test.ts` proves what the call deletes.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = (...path: string[]) => readFileSync(join(import.meta.dir, '..', ...path), 'utf8');
const MEMBERS = source('accounts', 'core', 'members.ts');
const SCIM_USERS = source('scim', 'users.ts');

/** The text of one route handler, from its route comment to the next route. */
function handler(marker: string): string {
  const start = MEMBERS.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = MEMBERS.indexOf('accountsRouter.openapi(', MEMBERS.indexOf('accountsRouter.openapi(', start) + 1);
  return MEMBERS.slice(start, end === -1 ? undefined : end);
}

describe('member exit paths delete the member\'s notification rows', () => {
  test('removal by an admin', () => {
    const body = handler('// DELETE /v1/accounts/:accountId/members/:userId');
    expect(body).toContain('await deleteMemberNotificationData(accountId, targetUserId)');
    expect(body.indexOf('Cannot remove the last owner')).toBeLessThan(body.indexOf('deleteMemberNotificationData('));
  });

  test('leaving the account', () => {
    const body = handler('// POST /v1/accounts/:accountId/leave');
    expect(body).toContain('await deleteMemberNotificationData(accountId, userId)');
    expect(body.indexOf('Cannot leave as the last owner')).toBeLessThan(body.indexOf('deleteMemberNotificationData('));
  });

  test('SCIM deprovisioning', () => {
    const body = SCIM_USERS.split('async function deprovisionMember(')[1]?.split('\n}\n')[0] ?? '';
    expect(body).toContain('delete(accountMemberships)');
    expect(body).toContain('await deleteMemberNotificationData(accountId, userId)');
  });

  test('both modules import it from the notifications cleanup', () => {
    expect(MEMBERS).toContain("from '../../notifications/cleanup'");
    expect(SCIM_USERS).toContain("from '../notifications/cleanup'");
  });
});
