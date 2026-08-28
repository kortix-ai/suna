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
    // All three "Details" controls sit behind the details gate. They are
    // prefetching anchors, not buttons: this alert only shows when the project
    // is already unhealthy, which is the worst moment to risk the full page
    // reload a cold `router.push` can degrade into
    // (fetch-server-response.js:148/177/181).
    const details = (code.match(/<Link href=\{sandboxSectionHref\} prefetch>/g) ?? []).length;
    expect(details).toBe(3);
    expect(code).not.toContain('onClick={openSandboxSection}');
    expect((code.match(/canOpenDetails/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(code).toContain('{canFixWithAgent && canRecover && (');
    expect(code).toContain('{canRecover ? (');
  });

  test('the whole action tray disappears when both gates close', () => {
    // Otherwise a member gets an empty bordered tray under the message.
    expect(code).toContain('{!canOpenDetails && !canRecover ? null : (');
  });

  // The failure text, the category badge and the timestamp carry no gate:
  // they are the answer to "why can't I start a session?".
  test('the explanatory copy stays ungated', () => {
    const body = code.slice(code.indexOf('function SandboxAlertContent'));
    const message = body.slice(body.indexOf('describeSandboxSeverity(severity, status)'));
    expect(message.indexOf('canOpenDetails')).toBeGreaterThan(-1);
    expect(code).toContain('{describeSandboxSeverity(severity, status)}');
    expect(code).not.toContain('canRecover && describeSandboxSeverity');
  });

  // Hide, never disable — a control that only tells you "forbidden" after the
  // click is worse than no control.
  test('denied controls are removed, not disabled', () => {
    expect(code).not.toContain('disabled={!canRecover}');
    expect(code).not.toContain('disabled={!canOpenDetails}');
  });
});
