// Tests for project-role-descriptors.ts.
//
// The role copy is a UX surface in three places (dropdown subtitles, the
// help popover, and badges). These tests lock in the invariants that
// matter for that surface so a careless edit doesn't ship a half-renamed
// role or a blurb that overflows.

import { describe, expect, test } from 'bun:test';
import {
  ACCOUNT_ROLE_DESCRIPTORS,
  PROJECT_ROLE_DESCRIPTORS,
  PROJECT_ROLES_ASCENDING,
} from './project-role-descriptors';

describe('PROJECT_ROLE_DESCRIPTORS', () => {
  test('covers every project role (manager was retired — editor is the top role)', () => {
    expect(Object.keys(PROJECT_ROLE_DESCRIPTORS).sort()).toEqual(
      ['editor', 'member'],
    );
  });

  test('every descriptor has non-empty label, blurb, and summary', () => {
    for (const [key, d] of Object.entries(PROJECT_ROLE_DESCRIPTORS)) {
      expect(d.label, `${key} label`).toBeTruthy();
      expect(d.blurb, `${key} blurb`).toBeTruthy();
      expect(d.summary, `${key} summary`).toBeTruthy();
    }
  });

  test('label is title-cased (so badges look right)', () => {
    for (const d of Object.values(PROJECT_ROLE_DESCRIPTORS)) {
      expect(d.label[0]).toBe(d.label[0].toUpperCase());
    }
  });

  test('blurb stays one-line dropdown-friendly (<= 80 chars)', () => {
    // Picked by eyeballing — anything longer wraps to two lines inside
    // the 320px Select dropdown and pushes options apart visually.
    for (const [key, d] of Object.entries(PROJECT_ROLE_DESCRIPTORS)) {
      expect(d.blurb.length, `${key} blurb length`).toBeLessThanOrEqual(80);
    }
  });

  test('summary fits popover (<= 220 chars)', () => {
    for (const [key, d] of Object.entries(PROJECT_ROLE_DESCRIPTORS)) {
      expect(d.summary.length, `${key} summary length`).toBeLessThanOrEqual(220);
    }
  });

  test('member (floor role) blurb communicates it can use the project (start sessions)', () => {
    // Member is the base *usable* role — it can start sessions and use the
    // agent chat, NOT a read-only role. If this fails, we've regressed the
    // whole point of the floor descriptor (a role that can't open a session
    // is useless).
    expect(PROJECT_ROLE_DESCRIPTORS.member.blurb.toLowerCase()).toMatch(/session|chat|use/);
  });

  test('editor summary clarifies member/gateway-key/delete management is account owner/admin authority, not this role', () => {
    // The project-role collapse moved the three former manager-only leaves
    // (project.delete, project.members.manage, project.gateway.keys.manage) to
    // ACCOUNT owner/admin authority — editor (the new top project role) must
    // not imply it grants them.
    const text = PROJECT_ROLE_DESCRIPTORS.editor.summary.toLowerCase();
    expect(text).toMatch(/account owner|admin/);
  });

  test('editor blurb references the member role (additive framing)', () => {
    // Roles are strict supersets in role-perms.ts. The blurbs should
    // tell that story so users understand "Editor includes everything a
    // Member can do" rather than treating them as disjoint.
    expect(PROJECT_ROLE_DESCRIPTORS.editor.blurb.toLowerCase()).toContain('member');
  });

  test('member copy calls out firing triggers (its defining capability over read-only)', () => {
    // Firing triggers is what makes the floor role a real operator role, not a
    // bystander. Keep it explicit in both blurb and summary.
    expect(PROJECT_ROLE_DESCRIPTORS.member.summary.toLowerCase()).toContain('trigger');
    expect(PROJECT_ROLE_DESCRIPTORS.member.blurb.toLowerCase()).toContain('trigger');
  });
});

describe('PROJECT_ROLES_ASCENDING', () => {
  test('matches role hierarchy member → editor (manager was retired)', () => {
    expect(PROJECT_ROLES_ASCENDING).toEqual(['member', 'editor']);
  });
});

describe('ACCOUNT_ROLE_DESCRIPTORS', () => {
  test('covers every account role', () => {
    expect(Object.keys(ACCOUNT_ROLE_DESCRIPTORS).sort()).toEqual(
      ['admin', 'member', 'owner'],
    );
  });

  test('member blurb explains they need explicit project access', () => {
    // This is the part that confuses brand-new admins the most. Lock it.
    const text = ACCOUNT_ROLE_DESCRIPTORS.member.blurb.toLowerCase();
    expect(text).toMatch(/project|group|added/);
  });
});
