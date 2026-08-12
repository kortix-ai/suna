import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ApiKeysTabView } from './api-keys-tab';

/**
 * `ApiKeysTabView` is the pure, props-only half — see that file's header
 * comment. The keys table and the rules form both call `useQuery` internally,
 * so they arrive as slots and only their placement can be pinned here. What
 * the table itself decides — which keys are hidden, the sort order, what the
 * search and the filters match — is tested for real in
 * `components/iam/api-key-rows.test.ts`; the create form's expiry choices in
 * `components/iam/api-key-expiry.test.ts`.
 *
 * `section` is a prop rather than internal state for a reason that shows up
 * here: Radix unmounts an inactive `TabsContent`, so the second pane is
 * genuinely absent from the markup until `section="usage"` is passed.
 */
describe('ApiKeysTabView', () => {
  /**
   * The description comes from the rail item (`rail.ts`), which had none for
   * this tab — so the pane opened on a bare title. This is the assertion that
   * fails if that rail entry loses its description again.
   */
  test('renders the header title and description', () => {
    const out = renderToStaticMarkup(<ApiKeysTabView />);
    expect(out).toContain('API keys');
    expect(out).toContain('Let the Kortix CLI, a script, or a CI job use this workspace.');
  });

  test('offers both panes as tabs', () => {
    const out = renderToStaticMarkup(<ApiKeysTabView />);
    expect(out).toContain('>Keys<');
    expect(out).toContain('Usage');
  });

  test('opens on the keys pane', () => {
    const out = renderToStaticMarkup(
      <ApiKeysTabView keysSlot={<div>keys-content</div>} rulesSlot={<div>rules-content</div>} />,
    );
    expect(out).toContain('keys-content');
    // Radix leaves the inactive pane unmounted — the usage content is not
    // merely hidden, it is absent.
    expect(out).not.toContain('rules-content');
    expect(out).not.toContain('kortix login --token');
  });

  test('the usage pane carries the snippets and the rules form together', () => {
    const out = renderToStaticMarkup(
      <ApiKeysTabView
        section="usage"
        keysSlot={<div>keys-content</div>}
        rulesSlot={<div>rules-content</div>}
      />,
    );
    expect(out).toContain('Using a key');
    expect(out).toContain('kortix login --token');
    expect(out).toContain('rules-content');
    expect(out).not.toContain('keys-content');
  });

  test('the snippets come before the rules form in the usage pane', () => {
    const out = renderToStaticMarkup(
      <ApiKeysTabView section="usage" rulesSlot={<div>rules-marker</div>} />,
    );
    expect(out.indexOf('Using a key')).toBeLessThan(out.indexOf('rules-marker'));
  });

  /**
   * A member without `account.write` gets no rules form, so the tab must not
   * promise one. The label is the only thing that changes with the slot.
   */
  test('the second tab is labelled Usage alone when there is no rules form', () => {
    const withRules = renderToStaticMarkup(<ApiKeysTabView rulesSlot={<div>rules</div>} />);
    const withoutRules = renderToStaticMarkup(<ApiKeysTabView />);
    expect(withRules).toContain('Usage &amp; rules');
    expect(withoutRules).not.toContain('Usage &amp; rules');
    expect(withoutRules).toContain('Usage');
  });

  /**
   * The create action sits above the tab bar so it is reachable from both
   * panes — putting it inside the keys pane would hide the one control the
   * rebuild exists to surface whenever someone opened the rules.
   */
  test('renders the create action in the pane header, outside both panes', () => {
    const out = renderToStaticMarkup(
      <ApiKeysTabView headerAction={<button>Create key</button>} keysSlot={<div>keys</div>} />,
    );
    expect(out.indexOf('Create key')).toBeLessThan(out.indexOf('role="tablist"'));
  });

  test('omits the create action when the container supplies none', () => {
    const out = renderToStaticMarkup(<ApiKeysTabView />);
    expect(out).not.toContain('Create key');
  });

  test('shows both ways to use a key, each separately copyable', () => {
    const out = renderToStaticMarkup(<ApiKeysTabView section="usage" />);
    expect(out).toContain('kortix login --token');
    expect(out).toContain('Authorization: Bearer');
    // One copy control per snippet — the shared CopyButton, not a hand-rolled one.
    expect(out.split('aria-label="Copy code"').length - 1).toBe(2);
  });

  test('the curl example uses this deployment’s own API base', () => {
    const out = renderToStaticMarkup(
      <ApiKeysTabView section="usage" apiBase="https://dev-api.kortix.com/v1" />,
    );
    expect(out).toContain('curl https://dev-api.kortix.com/v1/projects');
    expect(out).not.toContain('curl https://api.kortix.com/v1/projects');
  });

  test('falls back to the public API base when the container has none', () => {
    const out = renderToStaticMarkup(<ApiKeysTabView section="usage" />);
    expect(out).toContain('curl https://api.kortix.com/v1/projects');
  });

  /**
   * The wide tier is earned by rendering a table, and this tab does — in its
   * slot child (`components/iam/api-keys-card.tsx`).
   * `tab-content-width.test.ts` owns that rule across every tab; this pins the
   * column at the point of use, including the padding bug that started it:
   * the pane already applies `px-4 py-10`, so a tab adding its own is double.
   */
  test('renders in the wide column, with no padding of its own', () => {
    const out = renderToStaticMarkup(<ApiKeysTabView />);
    expect(out).toContain('mx-auto w-full max-w-4xl');
    expect(out).not.toContain('px-6 py-10');
  });
});
