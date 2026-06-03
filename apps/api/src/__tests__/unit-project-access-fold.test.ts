// Tests for the V2 effective-access fold used by
// GET /v1/projects/:projectId/access. The route does the SQL fan-out;
// foldEffectiveProjectAccess is the pure logic that combines:
//   - implicit (account owner/admin → Manager on every project)
//   - direct   (explicit project_members row with a project_role)
//   - group    (project_group_grants attaching a group the user is in)
//
// Folding rule: max role wins. Source label records which path produced
// the max (used by the UI to render "via X group" or "Account admin").

import { describe, expect, test } from 'bun:test';
import {
  foldEffectiveProjectAccess,
} from '../projects/access';

describe('foldEffectiveProjectAccess', () => {
  describe('implicit access (owner/admin)', () => {
    test('owner with no other paths → Manager via implicit', () => {
      const r = foldEffectiveProjectAccess({
        accountRole: 'owner',
        directRole: null,
        groupSources: [],
      });
      expect(r.effective_project_role).toBe('manager');
      expect(r.effective_source).toBe('implicit');
    });

    test('admin with no other paths → Manager via implicit', () => {
      const r = foldEffectiveProjectAccess({
        accountRole: 'admin',
        directRole: null,
        groupSources: [],
      });
      expect(r.effective_project_role).toBe('manager');
      expect(r.effective_source).toBe('implicit');
    });

    test('admin in a Viewer group → still Manager, still implicit', () => {
      // The exact bug the user hit: setting a Viewer group attachment
      // didn't cap an account admin. The fold keeps Manager + implicit
      // because implicit wins the tie-break against the lower group role.
      const r = foldEffectiveProjectAccess({
        accountRole: 'admin',
        directRole: null,
        groupSources: [{ group_id: 'g', group_name: 'Viewers', role: 'viewer' }],
      });
      expect(r.effective_project_role).toBe('manager');
      expect(r.effective_source).toBe('implicit');
    });

    test('admin who is ALSO in a Manager group → Manager via implicit (implicit ties)', () => {
      // Both paths give Manager; implicit was set first and doesn't get
      // overwritten by a same-rank group hit. Stable source label.
      const r = foldEffectiveProjectAccess({
        accountRole: 'admin',
        directRole: null,
        groupSources: [{ group_id: 'g', group_name: 'Managers', role: 'manager' }],
      });
      expect(r.effective_project_role).toBe('manager');
      expect(r.effective_source).toBe('implicit');
    });
  });

  describe('direct access (plain member with project_members row)', () => {
    test('member with Editor direct grant → Editor via direct', () => {
      const r = foldEffectiveProjectAccess({
        accountRole: 'member',
        directRole: 'editor',
        groupSources: [],
      });
      expect(r.effective_project_role).toBe('editor');
      expect(r.effective_source).toBe('direct');
    });

    test('no path at all → null effective + null source', () => {
      const r = foldEffectiveProjectAccess({
        accountRole: 'member',
        directRole: null,
        groupSources: [],
      });
      expect(r.effective_project_role).toBeNull();
      expect(r.effective_source).toBeNull();
    });
  });

  describe('group-only access', () => {
    test('member in a Viewer group → Viewer via group', () => {
      // The fix that this whole branch enables: previously this row
      // displayed "No access" in the UI; now it correctly surfaces
      // Viewer + tags the source so the UI can label "via Viewers".
      const r = foldEffectiveProjectAccess({
        accountRole: 'member',
        directRole: null,
        groupSources: [{ group_id: 'g', group_name: 'Viewers', role: 'viewer' }],
      });
      expect(r.effective_project_role).toBe('viewer');
      expect(r.effective_source).toBe('group');
    });

    test('multiple groups: max role wins, source still "group"', () => {
      const r = foldEffectiveProjectAccess({
        accountRole: 'member',
        directRole: null,
        groupSources: [
          { group_id: 'g1', group_name: 'Viewers', role: 'viewer' },
          { group_id: 'g2', group_name: 'Engineering', role: 'editor' },
        ],
      });
      expect(r.effective_project_role).toBe('editor');
      expect(r.effective_source).toBe('group');
    });

    test('group_sources sorted by role desc on output', () => {
      // UI uses sources[0] for the "via X" chip — strongest group
      // should be first regardless of input order.
      const r = foldEffectiveProjectAccess({
        accountRole: 'member',
        directRole: null,
        groupSources: [
          { group_id: 'g1', group_name: 'Viewers', role: 'viewer' },
          { group_id: 'g2', group_name: 'Managers', role: 'manager' },
          { group_id: 'g3', group_name: 'Editors', role: 'editor' },
        ],
      });
      expect(r.group_sources.map((g) => g.group_name)).toEqual([
        'Managers',
        'Editors',
        'Viewers',
      ]);
    });

    test('does not mutate input groupSources order', () => {
      const sources = [
        { group_id: 'g1', group_name: 'Viewers', role: 'viewer' as const },
        { group_id: 'g2', group_name: 'Managers', role: 'manager' as const },
      ];
      const before = sources.map((s) => s.group_name);
      foldEffectiveProjectAccess({
        accountRole: 'member',
        directRole: null,
        groupSources: sources,
      });
      expect(sources.map((s) => s.group_name)).toEqual(before);
    });
  });

  describe('mixed sources (precedence + tie-break)', () => {
    test('Editor direct + Viewer group → Editor via direct', () => {
      // Direct beats group when both are non-implicit; max role wins.
      const r = foldEffectiveProjectAccess({
        accountRole: 'member',
        directRole: 'editor',
        groupSources: [{ group_id: 'g', group_name: 'Viewers', role: 'viewer' }],
      });
      expect(r.effective_project_role).toBe('editor');
      expect(r.effective_source).toBe('direct');
    });

    test('Viewer direct + Manager group → Manager via group', () => {
      // Group is stronger here; source label correctly switches to "group".
      const r = foldEffectiveProjectAccess({
        accountRole: 'member',
        directRole: 'viewer',
        groupSources: [
          { group_id: 'g', group_name: 'Managers', role: 'manager' },
        ],
      });
      expect(r.effective_project_role).toBe('manager');
      expect(r.effective_source).toBe('group');
    });

    test('Editor direct + Editor group → Editor via direct (direct ties)', () => {
      // Same role from both: direct keeps the label because the fold
      // visits direct before groups. Stable for UI display.
      const r = foldEffectiveProjectAccess({
        accountRole: 'member',
        directRole: 'editor',
        groupSources: [
          { group_id: 'g', group_name: 'Engineering', role: 'editor' },
        ],
      });
      expect(r.effective_project_role).toBe('editor');
      expect(r.effective_source).toBe('direct');
    });
  });
});
