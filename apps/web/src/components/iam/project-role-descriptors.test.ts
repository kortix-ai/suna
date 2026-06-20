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
  test('covers every project role', () => {
    expect(Object.keys(PROJECT_ROLE_DESCRIPTORS).sort()).toEqual(
      ['editor', 'manager', 'viewer'],
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

  test('viewer blurb communicates read-only', () => {
    // Marko: "What does a viewer in a project do?" — if this assertion
    // ever fails, we've regressed on the whole point of the descriptor.
    expect(PROJECT_ROLE_DESCRIPTORS.viewer.blurb.toLowerCase()).toContain('read');
  });

  test('manager blurb communicates member management', () => {
    // The thing that distinguishes Manager from Editor in real use.
    const text = PROJECT_ROLE_DESCRIPTORS.manager.blurb.toLowerCase();
    expect(text).toMatch(/invite|member|settings/);
  });

  test('editor blurb references viewer capabilities (additive framing)', () => {
    // Roles are strict supersets in role-perms.ts. The blurbs should
    // tell that story so users understand "Editor includes everything
    // Viewer can do" rather than treating them as disjoint.
    expect(PROJECT_ROLE_DESCRIPTORS.editor.blurb.toLowerCase()).toContain('viewer');
  });
});

describe('PROJECT_ROLES_ASCENDING', () => {
  test('matches role hierarchy viewer → editor → manager', () => {
    expect(PROJECT_ROLES_ASCENDING).toEqual(['viewer', 'editor', 'manager']);
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
