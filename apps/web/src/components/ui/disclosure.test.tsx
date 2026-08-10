/**
 * Disclosure's controlled/uncontrolled contract.
 *
 * The bug this guards: `DisclosureProvider` used to copy `open` into internal
 * state and reconcile the two in a `useEffect`, while the trigger negated the
 * COPY and fired `onOpenChange` from inside a `setState` updater. That produced
 * "I click Advanced and nothing happens, then it opens by itself" — a click
 * could resolve to the state the disclosure was already in, and a prop-driven
 * change landed a frame late because it arrived via a passive effect.
 *
 * `apps/web` has no browser harness, so clicks cannot be simulated. The toggle
 * decision is therefore a pure function (`resolveDisclosureToggle`) that the
 * component actually calls, and the render-time contract is asserted through
 * `data-state` in SSR markup.
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  resolveDisclosureToggle,
} from './disclosure';

describe('resolveDisclosureToggle', () => {
  test('always negates the value currently rendered', () => {
    expect(resolveDisclosureToggle({ open: false, isControlled: false }).nextOpen).toBe(true);
    expect(resolveDisclosureToggle({ open: true, isControlled: false }).nextOpen).toBe(false);
    expect(resolveDisclosureToggle({ open: false, isControlled: true }).nextOpen).toBe(true);
    expect(resolveDisclosureToggle({ open: true, isControlled: true }).nextOpen).toBe(false);
  });

  test('a controlled disclosure writes no state of its own', () => {
    // The second source of truth is the whole defect. A controlled disclosure
    // must report only what the parent should do.
    expect(resolveDisclosureToggle({ open: false, isControlled: true }).writesInternalState).toBe(
      false,
    );
    expect(resolveDisclosureToggle({ open: true, isControlled: true }).writesInternalState).toBe(
      false,
    );
  });

  test('an uncontrolled disclosure owns its state', () => {
    expect(resolveDisclosureToggle({ open: false, isControlled: false }).writesInternalState).toBe(
      true,
    );
  });
});

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

function body(open?: boolean, defaultOpen?: boolean) {
  return (
    <Disclosure open={open} defaultOpen={defaultOpen}>
      <DisclosureTrigger>
        <button type="button">Advanced</button>
      </DisclosureTrigger>
      <DisclosureContent>
        <p>details</p>
      </DisclosureContent>
    </Disclosure>
  );
}

describe('render-time state', () => {
  test('uncontrolled starts closed', () => {
    const markup = render(body());
    expect(markup).toContain('data-state="closed"');
    expect(markup).not.toContain('data-state="open"');
  });

  test('defaultOpen starts open without being controlled', () => {
    // Fails on the previous implementation, which had no `defaultOpen` at all
    // and defaulted `open` to false — there was no way to say "start open, then
    // let the user decide", which is exactly what scim-card.tsx needed and
    // faked with a derived `open` that fought every click.
    expect(render(body(undefined, true))).toContain('data-state="open"');
  });

  test('a controlled disclosure renders the prop it was given', () => {
    expect(render(body(true))).toContain('data-state="open"');
    expect(render(body(false))).toContain('data-state="closed"');
  });

  test('open wins over defaultOpen when both are supplied', () => {
    expect(render(body(false, true))).toContain('data-state="closed"');
  });

  test('the trigger reports expansion to assistive tech', () => {
    expect(render(body(true))).toContain('aria-expanded="true"');
    expect(render(body(false))).toContain('aria-expanded="false"');
  });

  test('content is present when open and absent when closed', () => {
    expect(render(body(true))).toContain('details');
    expect(render(body(false))).not.toContain('details');
  });
});
