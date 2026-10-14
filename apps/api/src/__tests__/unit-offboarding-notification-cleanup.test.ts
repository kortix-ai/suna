/**
 * Every account exit path drops the member's notification rows of that
 * account (KRTX-1742): member removal, leave and SCIM deprovision. Without it
 * the bell and the digest keep naming the account's sessions until the row is
 * 90 days old, and a watcher row keeps the departed member on the recipient
 * list (the read filter hides the rows; the delete removes them).
 *
 * The three paths share one sequence, `offboardMember` (KRTX-1722). Asserted
 * against the source, like `unit-scim-helpers.test.ts`: the handlers are long,
 * their collaborators are DB deletes and Stripe, and the property that matters
 * is that each path reaches the call after its membership checks.
 * `notifications/cleanup.integration.test.ts` proves what the call deletes, and
 * `integration-offboard-member.test.ts` drives the three routes end to end.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = (...path: string[]) => readFileSync(join(import.meta.dir, '..', ...path), 'utf8');
const MEMBERS = source('accounts', 'core', 'members.ts');
const OFFBOARD = source('accounts', 'core', 'offboard-member.ts');
const SCIM_USERS = source('scim', 'users.ts');

/** The text of one route handler, from its route comment to the next route. */
function handler(marker: string): string {
  const start = MEMBERS.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = MEMBERS.indexOf('accountsRouter.openapi(', MEMBERS.indexOf('accountsRouter.openapi(', start) + 1);
  return MEMBERS.slice(start, end === -1 ? undefined : end);
}

describe('member exit paths delete the member\'s notification rows', () => {
  test('removal by an admin offboards, after the last-owner check', () => {
    const body = handler('// DELETE /v1/accounts/:accountId/members/:userId');
    expect(body).toContain("await offboardMember(await actorOf(c, accountId), accountId, targetUserId, 'removed')");
    expect(body.indexOf('Cannot remove the last owner')).toBeLessThan(body.indexOf('offboardMember('));
  });

  test('leaving the account offboards, after the last-owner check', () => {
    const body = handler('// POST /v1/accounts/:accountId/leave');
    expect(body).toContain("await offboardMember(await actorOf(c, accountId), accountId, userId, 'left')");
    expect(body.indexOf('Cannot leave as the last owner')).toBeLessThan(body.indexOf('offboardMember('));
  });

  test('SCIM deprovisioning offboards', () => {
    expect(SCIM_USERS).toContain("offboardMember(SYSTEM_ACTOR, user.accountId, userId, 'deprovisioned')");
  });

  test('offboarding deletes the notification rows, then the identity row', () => {
    const body = OFFBOARD.split('export async function offboardMember(')[1]?.split('\n}\n')[0] ?? '';
    expect(body).toContain('await deleteMemberNotificationData(accountId, userId)');
    expect(body.indexOf('deleteMemberNotificationData(')).toBeLessThan(body.indexOf('delete(accountMemberships)'));
    expect(OFFBOARD).toContain("from '../../notifications/cleanup'");
  });
});
