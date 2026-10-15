import { readFileSync } from '@/i18n/test-source';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

/**
 * Page chrome for Secrets. It is a sibling tab of Connectors / Agents /
 * Skills / Triggers on the Customize bar and has to read as one: same
 * `CapabilityPageShell`, same `max-w-5xl` column, same heading, same header
 * group. It brought its own `max-w-2xl` column and its own
 * `SettingsSectionHeader` before, which is what made it look like a different
 * product beside the other four.
 *
 * Source-level assertions, following `schedule-view.test.tsx` and
 * `connectors-page.global-rules.test.ts`: apps/web has no DOM testing library,
 * and what is pinned here is WHERE a control is mounted, not what it renders.
 */
const source = readFileSync(join(import.meta.dir, 'secrets-view.tsx'), 'utf8');

/** Comments name the old layout on purpose; assert on code only. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const CHILDREN_START = '<div className="space-y-4">';
const shellStart = code.indexOf('<CapabilityPageShell');
const childrenStart = code.indexOf(CHILDREN_START);
/** The shell's props — `title`, `description`, `search`, `action`, `filters`. */
const shellHeader = code.slice(shellStart, childrenStart);
/** Everything the shell renders as its content column. */
const shellChildren = code.slice(childrenStart);

describe('SecretsView page chrome', () => {
  test('a failed save leaves the form open with its entered value for retry', () => {
    const save = code.slice(code.indexOf('const save = useMutation('), code.indexOf('const grantIdentifier'));
    expect(save.slice(save.indexOf('onMutate:'), save.indexOf('onSuccess:'))).not.toContain('onOpenChange(false)');
    expect(save.slice(save.indexOf('onSuccess:'), save.indexOf('onError:'))).toContain('onOpenChange(false)');
    expect(save.slice(save.indexOf('onError:'), save.indexOf('onSettled:'))).not.toContain('onOpenChange(true)');
  });

  test('the page is the shared capability shell, not its own column', () => {
    expect(shellStart).toBeGreaterThan(-1);
    expect(childrenStart).toBeGreaterThan(shellStart);
    expect(shellHeader).toContain("raw('textd8707d411d99')");
    // The two pieces of the old narrow layout, gone for good. The heading is
    // written here rather than looked up: `secrets` is in neither registry
    // `SettingsTabHeader` reads, and a missed lookup renders nothing at all.
    expect(code).not.toContain('max-w-2xl');
    expect(code).not.toContain('SettingsSectionHeader');
    expect(code).not.toContain('SettingsTabHeader');
    expect(code).not.toContain('CustomizeSectionWrapper');
  });

  /**
   * The heading has to actually say something. A `title` with no `description`
   * is the state the page was in — a word at the top of a bare table — so both
   * are pinned, and the description has to name the mechanism rather than
   * restate the title.
   */
  test('the heading explains what a secret is and how it reaches a session', () => {
    expect(shellHeader).toContain("raw('texteca47e3afa10')");
  });

  test('search and the Add action are the shell’s slots, not inline', () => {
    expect(shellHeader).toContain('InputGroupSearchInput');
    expect(shellHeader).toContain('onSelect: openCreate');
    expect(shellChildren).not.toContain('InputGroupSearchInput');
  });

  /**
   * The Access legend and the docs link live in one info hover card after the
   * title, so the header stays one line. It reads the shared presentation
   * table: a legend restated in JSX drifts from the badge.
   */
  test('the Access legend and docs link are the title info hover card', () => {
    expect(shellHeader).toContain('titleAddon={<SecretsAccessInfo showEnforced={showEnforced} />}');
    expect(shellHeader).not.toContain('filters=');
    expect(shellHeader).not.toContain('/docs/project/secrets');
    const info = code.slice(code.indexOf('function SecretsAccessInfo'));
    expect(info).toContain('<HoverCardTrigger asChild>');
    expect(info).toContain('secretDeliveryLegend(showEnforced, tI18nComplete)');
    expect(info).toContain("raw('text0d8c9f89b826')");
    expect(info).toContain('href="/docs/project/secrets"');
  });

  /**
   * The editor opens in the page's SplitSheet column, beside the table, not in
   * a dialog over it. Hosts without a sheet (the agent editor) keep the modal.
   */
  test('the secret editor renders in the SplitSheet column', () => {
    expect(code).toContain('<SplitSheet');
    expect(code).toContain('<SplitSheetMain>');
    const content = code.slice(code.indexOf('<SplitSheetContent>'));
    expect(content).toContain('presentation="sheet"');
    expect(content.indexOf('<SecretDialog')).toBeGreaterThan(-1);
    // Outside the shell: the editor is the sheet column, not page content.
    expect(code.indexOf('<SecretDialog')).toBeGreaterThan(code.indexOf('</CapabilityPageShell>'));
    expect(code).toContain("presentation === 'sheet'");
    expect(code).toContain("presentation = 'modal'");
    // Like the modal, the sheet refuses to close while a save is in flight.
    expect(code).toContain('if (!next && editorSaving) return;');
    expect(code).toContain('onSavingChange={setEditorSaving}');
  });

  test('editing shows the identifier once, as text, not as two disabled fields', () => {
    const editStart = code.indexOf('{isEdit && row ? (');
    const editBranch = code.slice(editStart, code.indexOf(') : (', editStart));
    expect(editBranch).toContain('{row.identifier}');
    expect(editBranch).not.toContain('<Input');
  });
});
