import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every surface on this route carries a way back to the sidebar.
 *
 * `SessionSiteHeader` owns the opener, and it only exists once `SessionChat` or
 * `InstantSessionShell` mounts. Everything before or instead of that — the boot
 * loader, the session-switch loader, the billing gate, and the five terminal
 * cards — is a bare centred block with no chrome at all. Collapse the sidebar,
 * then open a session that is booting, stopped, or whose computer was lost, and
 * there was no control on screen to bring the panel back. The app's primary
 * navigation surface was reachable only by reloading the page, in exactly the
 * states a user most wants to leave.
 *
 * Composition facts spread across a wrapper and eight call sites, expressible
 * only in CSS — no render of any single component shows them — so they are
 * pinned against the source, the way the boot overlay's layering is.
 */
const routeDir = import.meta.dir;
const page = readFileSync(resolve(routeDir, 'page.tsx'), 'utf8');

/** Comments stripped: a call site named only in prose is not a call site. */
const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Is `index` inside a `HeaderlessSessionSurface` element? */
function insideSurface(index: number): boolean {
  const open = code.lastIndexOf('<HeaderlessSessionSurface>', index);
  if (open === -1) return false;
  const close = code.lastIndexOf('</HeaderlessSessionSurface>', index);
  return close < open;
}

function allIndexesOf(needle: string): number[] {
  const out: number[] = [];
  for (let i = code.indexOf(needle); i !== -1; i = code.indexOf(needle, i + 1)) out.push(i);
  return out;
}

describe('headerless session surfaces carry the sidebar opener', () => {
  test('the fixture this suite reads is the real route', () => {
    // Without this every assertion below degrades to "a string is missing from
    // a file I could not find", which passes for the wrong reason.
    expect(code).toContain('function ProjectSessionView(');
    expect(code).toContain('function HeaderlessSessionSurface(');
  });

  // `relative` is load-bearing, not decoration: `placement="floating"` puts the
  // toggle at `absolute top-2 left-2`, which resolves against the nearest
  // POSITIONED ancestor. Drop it and the opener flies to whatever ancestor
  // happens to be positioned — on this route, the full-viewport shell.
  test('the wrapper is a positioned box holding the floating opener', () => {
    const body = code.slice(
      code.indexOf('function HeaderlessSessionSurface('),
      code.indexOf('function InlineSessionError('),
    );
    expect(body).toContain('<SidebarToggle placement="floating" />');
    const wrapper = body.slice(body.indexOf('<div className='), body.indexOf('<SidebarToggle'));
    expect(wrapper).toContain('relative');
  });

  // Four of these: the session-switch loader, the wake-ladder holding loader
  // (added with the wake auto-escalation ladder, #6916), the auto-resume
  // loader, and the boot overlay's loader. None of them renders a header.
  test('every SessionStartingLoader on this route is wrapped', () => {
    const sites = allIndexesOf('<SessionStartingLoader');
    expect(sites.length).toBe(4);
    for (const at of sites) expect(insideSurface(at)).toBe(true);
  });

  // One card covers seven states — billing gate, missing session, provisioning
  // failure, legacy/dormant, lost computer, stopped sandbox, runtime error —
  // so wrapping it once covers all of them, including the two returned from
  // ActiveSessionChat before `SessionLayout` mounts.
  test('the terminal card wraps itself, so every state that uses it is covered', () => {
    const body = code.slice(code.indexOf('function InlineSessionError('));
    const returnAt = body.indexOf('return (');
    expect(body.slice(returnAt, returnAt + 60)).toContain('<HeaderlessSessionSurface>');
    expect(allIndexesOf('<InlineSessionError').length).toBeGreaterThanOrEqual(7);
  });

  // The other half of the rule. `InstantSessionShell` renders `SessionLayout` +
  // `SessionSiteHeader`, which already carries the opener — wrapping it would
  // put two on one screen, which is the exact bug `sidebar-opener.ts` exists to
  // prevent.
  test('the instant shell is NOT wrapped — it has a header of its own', () => {
    const sites = allIndexesOf('<InstantSessionShell');
    expect(sites.length).toBeGreaterThan(0);
    for (const at of sites) expect(insideSurface(at)).toBe(false);
  });

  // The chat layer likewise. Its header is the opener's home.
  test('the mounted chat is NOT wrapped', () => {
    const sites = allIndexesOf('<ActiveSessionChat');
    expect(sites.length).toBeGreaterThan(0);
    for (const at of sites) expect(insideSurface(at)).toBe(false);
  });
});
