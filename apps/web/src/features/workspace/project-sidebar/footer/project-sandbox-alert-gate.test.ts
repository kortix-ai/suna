/**
 * The sandbox alert splits into information and controls, and only the second
 * half is gated.
 *
 * A plain project MEMBER needs the TEXT — "new sessions can't start until this
 * image builds" is the only explanation for why the composer is refusing them.
 * They cannot use any of the CONTROLS: "Details" routes into Customize →
 * Settings → Sandbox (`project.customize.read`) and "Retry build" / "Fix with
 * agent" rebuild the project's image (`project.write`). Neither leaf is in the
 * member floor role since #6522, so every one of those buttons was a
 * "forbidden" toast waiting to be clicked.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'project-sandbox-alert.tsx'), 'utf8');
const code = source.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('sandbox alert — controls are IAM-gated, the message is not', () => {
  test('reads both leaves from the shared project-page batch', () => {
    expect(code).toContain('useProjectPageCans(projectId)');
    expect(code).toContain('caps[PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ]');
    expect(code).toContain('caps[PROJECT_ACTIONS.PROJECT_WRITE]');
  });

  // "Details" is a Customize destination, not a modal — each control is a
  // `<Link>` to `projectSettingsSectionHref(projectId, 'sandbox')`.
  test('Details gates on customize.read, the recovery actions on project.write', () => {
    expect(code).toContain(
      'const canOpenDetails = caps[PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ]?.allowed !== false;',
    );
    expect(code).toContain(
      'const canRecover = caps[PROJECT_ACTIONS.PROJECT_WRITE]?.allowed !== false;',
    );
    // The one "Details" sits behind the details gate. It is a prefetching
    // anchor, not a button handler: this alert only shows when the project is
    // already unhealthy, which is the worst moment to risk the full page reload
    // a cold `router.push` can degrade into
    // (fetch-server-response.js:148/177/181).
    expect(code).not.toContain('onClick={openSandboxSection}');
    expect(code).toContain('const detailsButton = canOpenDetails ? (');
    // Recovery gates on project.write and never renders while building.
    expect(code).toContain("severity !== 'building' && canRecover");
    expect(code).toContain('fix: canFixWithAgent,');
  });

  test('exactly one "Details" exists, and it looks like a control', () => {
    // It used to render up to three times in one card — under the message, in
    // the failure row, and again in the tray — so a failing card showed the
    // same word twice pointing at the same route. There is now ONE link site.
    expect((code.match(/<Link href=\{sandboxSectionHref\} prefetch>/g) ?? []).length).toBe(1);
    // And it is a Button, not body-coloured text. Styled `text-muted-foreground
    // text-xs p-0` it was character-for-character the copy beside it, and sat
    // above the title row reading as a stranded caption.
    expect(code).toContain('<Button asChild size="sm" variant="outline" className={ACTION_BUTTON}>');
    expect(code).not.toContain('DETAILS_LINK');
  });

  test('the whole action tray disappears when there is nothing to offer', () => {
    // Otherwise a member gets an empty bordered tray under the message. With
    // both gates shut `recovery` is null and `detailsButton` is null, so
    // `hasTray` is false and the tray — divider included — is gone.
    expect(code).toContain('const hasTray = Boolean(recovery) || Boolean(detailsButton);');
    expect(code).toContain('{hasTray ? (');
  });

  test('the explanatory copy stays ungated', () => {
    // The sentence renders unconditionally inside the body — no gate in front
    // of it, in any form.
    expect(code).toContain(
      '<SidebarAlertText>{describeSandboxSeverity(severity, status)}</SidebarAlertText>',
    );
    expect(code).not.toContain('canRecover && describeSandboxSeverity');
    expect(code).not.toContain('canOpenDetails && describeSandboxSeverity');
    // The failure detail — category, timestamp, stack trace — is the answer to
    // "why can't I start a session?", so it carries no gate either.
    expect(code).toContain('{failure && (');
    expect(code).not.toContain('{failure && canOpenDetails');
    expect(code).not.toContain('{failure && canRecover');
    // The copy itself is unchanged from main — this redesign moved pixels, not
    // the sentences a member reads to understand why sessions are refused.
    expect(code).toContain('New sessions can’t start until this image builds.');
  });

  // Hide, never disable — a control that only tells you "forbidden" after the
  // click is worse than no control.
  test('denied controls are removed, not disabled', () => {
    expect(code).not.toContain('disabled={!canRecover}');
    expect(code).not.toContain('disabled={!canOpenDetails}');
  });
});
