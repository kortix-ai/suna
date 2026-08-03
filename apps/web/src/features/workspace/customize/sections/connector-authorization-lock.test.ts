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

  // `hideLabel` (capabilities/connectors/rung-settings.tsx) lets a caller that
  // already prints its own plain-language label for this control ("Who it
  // connects as") suppress the field's own "Authorization owner" label, so
  // the two never stack. Added here rather than to `connectors-view.tsx`,
  // which does not define this component and is frozen this milestone.
  test('hideLabel defaults to false — every existing caller is unaffected', () => {
    expect(MODAL).toContain('hideLabel = false');
  });

  test('hideLabel suppresses the label in BOTH the locked and editable branches', () => {
    expect(MODAL).toContain('{hideLabel ? null : <FieldLabel>Authorization owner</FieldLabel>}');
    expect(MODAL).toContain(
      '{hideLabel ? null : <FieldLabel htmlFor={id}>Authorization owner</FieldLabel>}',
    );
  });

  // The hazard `hideLabel` opens: in the editable branch the suppressed
  // `<FieldLabel htmlFor={id}>` is the `<Select>`'s ONLY name source. Deleting
  // `lockedReason` — which `rung-settings.tsx:107` explicitly describes as the
  // way to re-enable editing — would have rendered a combobox with no
  // accessible name. Coupled here rather than documented, because two comments
  // already documented it and it still surprised a reviewer.
  test('hideLabel never leaves the Select without an accessible name', () => {
    expect(MODAL).toContain("const suppressedLabel = hideLabel ? 'Authorization owner' : undefined");
    expect(MODAL).toContain('<SelectTrigger id={id} aria-label={suppressedLabel}>');
  });

  test('the locked branch reads out its value, so it needs no aria-label', () => {
    // Belt and braces on the coupling: the fallback exists for the ONE control
    // that has no other name source. A second copy on the read-only block
    // would announce a heading over text that already says "Project"/"User".
    const lockedBranch = MODAL.indexOf('if (lockedReason) {');
    const editableBranch = MODAL.indexOf('<SelectTrigger');
    expect(MODAL.slice(lockedBranch, editableBranch)).not.toContain('aria-label');
  });
});
