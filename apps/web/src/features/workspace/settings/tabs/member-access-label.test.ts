import type { ProjectAccessMember, ProjectRole } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { memberAccessLabel } from './member-access-label';

/**
 * Test fixture and cases are the task brief's (task-19-brief.md), used
 * verbatim, with two mechanical fixes required to typecheck:
 *
 * 1. The brief's snippet uses `ProjectAccessMember` with no import — added
 *    here (`@kortix/sdk`, the same barrel `member-access-label.ts` and every
 *    sibling tab import it from).
 * 2. `'viewer'` (the "a direct grant carries no annotation" and "the first
 *    group source wins" cases) is not a member of the real `ProjectRole`
 *    union — `type ProjectRole = 'manager' | 'editor' | 'member'`
 *    (`packages/sdk/src/core/rest/projects-client/shared.ts:4`). `viewer`
 *    was folded into `member` and is no longer emitted by the API — see
 *    `apps/web/src/components/iam/iam-display-helpers.ts:18-19`
 *    ("`viewer` was folded into it and is no longer emitted by the API").
 *    Cast to `ProjectRole` so these two fixtures still typecheck. This is a
 *    deliberate, minimal deviation — the assertions themselves are
 *    unchanged — and it doubles as a check that `memberAccessLabel`
 *    capitalizes generically rather than through a 3-entry lookup table, so
 *    an unrecognized-but-string-shaped role still renders instead of
 *    crashing or falling back to a blank label.
 */
const member = (o: Partial<ProjectAccessMember>): ProjectAccessMember => ({
  user_id: 'u1',
  email: 'a@b.c',
  account_role: 'member',
  project_role: null,
  effective_project_role: null,
  has_implicit_access: false,
  effective_source: null,
  group_sources: [],
  joined_at: '',
  granted_by: null,
  granted_at: null,
  updated_at: null,
  ...o,
});

describe('memberAccessLabel', () => {
  test('an account admin reads as implicit', () => {
    expect(
      memberAccessLabel(
        member({
          account_role: 'admin',
          effective_project_role: 'manager',
          effective_source: 'implicit',
          has_implicit_access: true,
        }),
      ),
    ).toEqual({ role: 'Manager', via: 'account admin' });
  });

  test('a group grant names the group', () => {
    expect(
      memberAccessLabel(
        member({
          effective_project_role: 'editor',
          effective_source: 'group',
          group_sources: [{ group_id: 'g1', group_name: 'Engineering', role: 'editor' }],
        }),
      ),
    ).toEqual({ role: 'Editor', via: 'via Engineering' });
  });

  test('a direct grant carries no annotation', () => {
    expect(
      memberAccessLabel(
        member({
          project_role: 'viewer' as ProjectRole,
          effective_project_role: 'viewer' as ProjectRole,
          effective_source: 'direct',
        }),
      ),
    ).toEqual({ role: 'Viewer', via: null });
  });

  test('no access reads as an em dash', () => {
    expect(memberAccessLabel(member({}))).toEqual({ role: '—', via: 'no access' });
  });

  test('the first group source wins the role when several contribute, and the rest are counted, not dropped', () => {
    // The role shown ("Editor") is genuinely explained by Engineering alone
    // — Viewers contributes nothing to it. But Viewers is still real access
    // this member has on this project via a second group, and used to be
    // fully invisible without leaving to the account page. "+1 more" keeps
    // that discoverable in one line instead of silently naming only the
    // winner.
    expect(
      memberAccessLabel(
        member({
          effective_project_role: 'editor',
          effective_source: 'group',
          group_sources: [
            { group_id: 'g1', group_name: 'Engineering', role: 'editor' },
            { group_id: 'g2', group_name: 'Viewers', role: 'viewer' as ProjectRole },
          ],
        }),
      ).via,
    ).toBe('via Engineering +1 more');
  });

  test('three or more group sources count all the extras, not just one', () => {
    expect(
      memberAccessLabel(
        member({
          effective_project_role: 'editor',
          effective_source: 'group',
          group_sources: [
            { group_id: 'g1', group_name: 'Engineering', role: 'editor' },
            { group_id: 'g2', group_name: 'Viewers', role: 'viewer' as ProjectRole },
            { group_id: 'g3', group_name: 'Contractors', role: 'viewer' as ProjectRole },
          ],
        }),
      ).via,
    ).toBe('via Engineering +2 more');
  });
});
