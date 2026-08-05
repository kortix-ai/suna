import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'connector-settings.tsx'), 'utf8');

/**
 * Source-assertion tripwires, in the shape of
 * `connector-tools.write-path.test.ts`. Two things on this tab cannot be
 * proven by a rendered-output test without a full react-query + mutation
 * harness, and both are load-bearing:
 *
 * 1. The `lockedReason` string is a legal statement about a real migration
 *    hazard (switching a connector's authorization owner orphans the
 *    connections and permission rules already stored under the old one). It
 *    must never drift from the exact wording, even by a "helpful" rewrite.
 * 2. Removing a connector must never fire from the click that opens the
 *    dialog — only from `ConfirmDialog`'s own confirm action.
 */
describe('connector settings write path', () => {
  test('the authorization lockedReason is byte-identical to the reviewed wording', () => {
    const lockedReason =
      'Set when the connector was added. To change it, remove the connector and add it again — saved connections and tool rules are lost.';
    expect(source).toContain(`lockedReason="${lockedReason}"`);
  });

  test('the owner is explained exactly once — no paragraph restating the field', () => {
    // The tab used to print a `Label`, a paragraph naming BOTH owners (one of
    // which is unreachable, the value is locked), the field's own row
    // description and the lockedReason — four statements of one fact. The
    // section label plus the field is the whole explanation now.
    expect(source).toContain('<Label>Connects as</Label>');
    expect(source).not.toContain('Project — one account everyone uses');
    const section = source.slice(source.indexOf('<Label>Connects as'), source.indexOf('</section>'));
    expect(section).not.toMatch(/<p\b/);
  });

  test('the danger row never mutates directly — only ConfirmDialog does', () => {
    // The visible Remove button only opens the dialog.
    const removeButtonBlock = source.slice(
      source.indexOf('<Button'),
      source.indexOf('</Button>'),
    );
    expect(removeButtonBlock).toContain('onClick={() => setConfirmDelete(true)}');
    expect(removeButtonBlock).not.toContain('remove.mutate()');

    // The mutation itself only fires from ConfirmDialog's onConfirm.
    const calls = [...source.matchAll(/remove\.mutate\(\)/g)];
    expect(calls).toHaveLength(1);
    const confirmDialogBlock = source.slice(source.indexOf('<ConfirmDialog'));
    expect(confirmDialogBlock).toContain('onConfirm={() => remove.mutate()}');
    expect(confirmDialogBlock).toContain('confirmVariant="destructive"');
  });

  test('the danger row itself carries no destructive variant — only the dialog button does', () => {
    // The panel stays neutral; only ConfirmDialog's own confirm button is
    // destructive. Scoped to the Remove `<Button>` element itself, not the
    // surrounding prose, which legitimately names "destructive" in a comment
    // explaining this exact rule.
    const removeButtonBlock = source.slice(
      source.indexOf('<Button'),
      source.indexOf('</Button>'),
    );
    expect(removeButtonBlock).not.toContain('variant="destructive"');
  });

  test('the danger row matches the design-system danger-zone shape', () => {
    expect(source).toContain('bg-popover rounded-md border px-4 py-3');
    expect(source).toContain('variant="outline"');
    expect(source).toContain('size="sm"');
  });

  test('the credential form is not duplicated here — ConnectionSection is never imported', () => {
    // Both are exported from connectors-view.tsx and already mounted on
    // connector-accounts.tsx. Importing either here would render the same
    // credential/config form on two tabs at once.
    expect(source).not.toMatch(/import\s*\{[^}]*\bConnectionSection\b/);
    expect(source).not.toMatch(/import\s*\{[^}]*\bChannelConnectionSection\b/);
  });

  test('this tab is the only place connector removal is wired in the capabilities tree', () => {
    // `../..` is the capabilities root: this file sits at connectors/detail/.
    const root = join(import.meta.dir, '..', '..');
    const callers = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter(
        (name) =>
          /\.tsx?$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx'),
      )
      .filter((name) => readFileSync(join(root, name), 'utf8').includes('deleteConnector('));
    expect(callers).toEqual(['connectors/detail/connector-settings.tsx']);
  });

  test('the field is called with hideLabel, so "Connects as" stays the only label', () => {
    // "Connects as" is the plain-language section label; `hideLabel`
    // (asserted structurally against `connector-profile-modal.tsx` in
    // `connector-authorization-lock.test.ts`) suppresses
    // `AuthorizationStrategyField`'s own "Authorization owner" label so the
    // two never stack. Scoped to the call site itself, not the whole file —
    // the surrounding comments legitimately name "Authorization owner" in
    // prose to explain why it is suppressed.
    expect(source).toContain('Connects as');
    const fieldBlock = source.slice(
      source.indexOf('<AuthorizationStrategyField'),
      source.indexOf('/>', source.indexOf('<AuthorizationStrategyField')) + 2,
    );
    expect(fieldBlock).toContain('hideLabel');
  });

  test('the write path is documented as unreachable by design, not by accident', () => {
    // Restores the hazard note the legacy `connectors-view.tsx` carried
    // (`onAuthorizationStrategyChange`, `disabled`, `pending` stay fully
    // wired to the real mutation while the field is locked; only
    // `lockedReason` forces it off, and re-enabling editing later is
    // deleting that one prop).
    const fieldBlock = source.slice(
      source.indexOf('<AuthorizationStrategyField'),
      source.indexOf('/>', source.indexOf('<AuthorizationStrategyField')),
    );
    expect(fieldBlock).toMatch(/unreachable.*design/i);
    expect(fieldBlock).toContain('deleting that one prop');
  });
});
