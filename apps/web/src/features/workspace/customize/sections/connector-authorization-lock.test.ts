import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * The authorization owner is settled once a connector exists.
 *
 * Switching it afterwards silently changes WHOSE account every future session
 * runs as, and orphans the connection profiles and permission rules already
 * stored under the old owner — a change shaped like a toggle that behaves like a
 * migration.
 *
 * Locked in the UI ONLY: the mutation and its route are deliberately left in
 * place so re-enabling is deleting one prop. These assertions exist so that
 * "leave the backend for later" does not quietly become "the backend rotted".
 */
const SECTIONS = import.meta.dir;
const VIEW = readFileSync(join(SECTIONS, 'connectors-view.tsx'), 'utf8');
const MODAL = readFileSync(join(SECTIONS, 'connector-profile-modal.tsx'), 'utf8');

describe('connector authorization owner is locked after creation', () => {
  test('the detail page passes a lockedReason', () => {
    expect(VIEW).toContain('lockedReason=');
  });

  test('exactly ONE call site is locked — the create flow must stay editable', () => {
    // Two call sites exist: the existing-connector detail page and the
    // custom-connector draft. Locking the draft too would make it impossible to
    // pick an owner at all.
    expect(VIEW.match(/lockedReason=/g)?.length ?? 0).toBe(1);
  });

  test('a lockedReason renders a STATEMENT, returning before any Select', () => {
    // Stronger than disabling: a disabled select keeps its chevron, focus ring
    // and hover, so it still invites a click that does nothing. The locked path
    // returns its own read-only block first, so no select exists to click.
    const lockedBranch = MODAL.indexOf('if (lockedReason) {');
    const firstSelect = MODAL.indexOf('<Select');
    expect(lockedBranch).toBeGreaterThan(-1);
    expect(lockedBranch).toBeLessThan(firstSelect);
  });

  test('the locked block states the reason and which owner is in force', () => {
    // Both halves matter: WHICH owner (the thing being read) and WHY it cannot
    // move (the thing that stops a support ticket).
    expect(MODAL).toContain('{lockedReason}');
    expect(MODAL).toContain("isProject ? 'Project' : 'User'");
  });

  test('the backend path is still wired, so this stays a one-prop revert', () => {
    expect(VIEW).toContain('updateAuthorizationStrategy');
  });
});
