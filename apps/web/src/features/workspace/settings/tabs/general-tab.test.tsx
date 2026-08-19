import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { GeneralTabView } from './general-tab';

/**
 * `GeneralTabView` is the pure, props-only half — see this tab's header
 * comment. `generalFieldsSlot` (name + icon) is a slot: the real subcomponent
 * behind it owns `useMutation`/`useState` of its own and cannot render under
 * `renderToStaticMarkup` with no `QueryClientProvider` — same reasoning
 * `connected-tab.tsx`'s `githubAppSetupSlot`/`chatgptConnectSlot` document.
 * These tests pin slot presence, order, and everything the pure view DOES
 * own directly: loading/error states and the Delete-workspace section.
 */
describe('GeneralTabView', () => {
  test('renders the general fields slot', () => {
    const out = renderToStaticMarkup(
      <GeneralTabView generalFieldsSlot={<div>name-icon-marker</div>} />,
    );
    expect(out).toContain('name-icon-marker');
  });

  test('the general fields slot renders before the Delete workspace section', () => {
    const out = renderToStaticMarkup(
      <GeneralTabView generalFieldsSlot={<div>fields-marker</div>} />,
    );
    expect(out.indexOf('fields-marker')).toBeLessThan(out.indexOf('Delete workspace'));
  });

  /**
   * The sandbox-provider pin moved to `sandbox-tab.tsx` (Sandbox templates) —
   * see both tabs' header comments. This asserts the removal is real: General
   * must not name the control, its section, or the provider vocabulary again.
   * Asserted against the FULLY populated view (a slot present, delete section
   * on), so it cannot pass just because the pane rendered nothing.
   */
  test('never mentions the sandbox provider — that control lives on the Sandbox templates tab', () => {
    const out = renderToStaticMarkup(
      <GeneralTabView generalFieldsSlot={<div>fields-marker</div>} workspaceName="My Workspace" />,
    );
    expect(out).toContain('fields-marker');
    expect(out).toContain('Delete workspace');
    expect(out).not.toContain('Sandbox provider');
    expect(out).not.toContain('sandbox');
    expect(out).not.toContain('Automatic');
  });

  test('renders a Delete workspace row with a destructive action by default', () => {
    const out = renderToStaticMarkup(<GeneralTabView />);
    expect(out).toContain('Delete workspace');
    expect(out).toContain('destructive');
  });

  /**
   * Was pinned as a `SettingsSectionHeader` + a bordered box of its own. Since
   * the Linear restyle every setting is a row inside a `SettingsRowGroup`, so
   * the assertion moves to the group's own slot — one border around the rows,
   * hairlines between them, rather than one bordered card per setting.
   */
  test('the Delete workspace row sits in a bordered settings group', () => {
    const out = renderToStaticMarkup(<GeneralTabView />);
    expect(out).toContain('data-slot="settings-row-group"');
  });

  /**
   * Linear's rule, and Jay's: a destructive trigger is red TEXT, and the
   * filled button is reserved for the confirmation. `bg-destructive/80` is the
   * `destructive` Button variant's fill — its absence is what says the trigger
   * did not silently go back to a solid red button. `ConfirmDialog` still
   * stands between the trigger and the mutation (`confirmVariant` below).
   */
  test('Delete workspace is a red text trigger, not a filled destructive button', () => {
    const out = renderToStaticMarkup(<GeneralTabView />);
    expect(out).toContain('text-destructive');
    expect(out).not.toContain('bg-destructive/80');
  });

  test('the Danger zone label sits above the Delete workspace row', () => {
    const out = renderToStaticMarkup(<GeneralTabView />);
    expect(out).toContain('Danger zone');
    expect(out.indexOf('Danger zone')).toBeLessThan(out.indexOf('Delete workspace'));
  });

  test('the Delete workspace section is absent when canDelete is false', () => {
    const out = renderToStaticMarkup(<GeneralTabView canDelete={false} />);
    expect(out).not.toContain('Delete workspace');
  });

  test('does not render the experimental feature list — that lives in ExperimentalTab', () => {
    const out = renderToStaticMarkup(<GeneralTabView />);
    expect(out).not.toContain('Early-access capabilities');
    expect(out).not.toContain('experimental_features');
  });

  test('loading state shows a skeleton, not the Delete workspace section', () => {
    const out = renderToStaticMarkup(<GeneralTabView isLoading />);
    expect(out).not.toContain('Delete workspace');
  });

  test('error state shows a retry action, not the Delete workspace section', () => {
    const out = renderToStaticMarkup(<GeneralTabView isError errorMessage="boom" />);
    expect(out).toContain('Retry');
    expect(out).toContain('boom');
    expect(out).not.toContain('Delete workspace');
  });

  test('renders cleanly with the confirm dialog open — ConfirmDialog is Radix AlertDialog-portal-based and renders nothing under renderToStaticMarkup regardless of `open`, same as ModalContent (see settings-panel.tsx); this only pins that the rest of the tree still renders', () => {
    expect(() =>
      renderToStaticMarkup(<GeneralTabView archiveOpen workspaceName="My Workspace" />),
    ).not.toThrow();
  });
});
