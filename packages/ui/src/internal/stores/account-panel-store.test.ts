// The account hub's URL contract.
//
// The hub has no route. It is a modal addressed by `?accountId=` on the page
// you are already on, so the claim under test is that the address bar stays
// TRUE — reload it or paste it and the same modal comes back over the same
// page — in the three halves that can silently break:
//
//   1. the rewrite — the path never moves, the page's own query survives, the
//      hub's params are PREFIXED so they cannot collide with the page
//      underneath, and a stale drill-down never accumulates;
//   2. the reverse — `hubParamsFromUrl` gives every pane the SHORT names it
//      reads, so the prefix exists on the wire and nowhere else;
//   3. the history invariant — opening pushes EXACTLY one entry, every move
//      inside replaces it, closing pops exactly it. Break that and Back needs
//      one press per section the user glanced at, which is the classic failure
//      of URL-syncing overlays.
//
// `window.history` is stubbed rather than driven, because what is asserted is
// which call the store makes, not what a browser does with it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  accountPanelClosedUrl,
  accountPanelUrl,
  closeAccountPanel,
  forgetPushedEntry,
  hubParamsFromUrl,
  hubTarget,
  openAccountPanel,
  readAccountPanelUrl,
  useAccountPanelStore,
} from './account-panel-store';

type HistoryCall = { op: 'push' | 'replace' | 'back'; url?: string };

const calls: HistoryCall[] = [];
const originalWindow = (globalThis as { window?: unknown }).window;

/** Put the fake browser on a page, then let the store act on it. */
function at(url: string) {
  const parsed = new URL(url, 'https://x.invalid');
  (globalThis as { window?: unknown }).window = {
    location: { pathname: parsed.pathname, search: parsed.search },
    history: {
      pushState: (_s: unknown, _t: unknown, next: string) => {
        calls.push({ op: 'push', url: next });
        apply(next);
      },
      replaceState: (_s: unknown, _t: unknown, next: string) => {
        calls.push({ op: 'replace', url: next });
        apply(next);
      },
      back: () => calls.push({ op: 'back' }),
    },
  };
}

/** History writes move the fake browser, exactly as a real one would — without
 *  this, "the second open replaces" would pass for the wrong reason. */
function apply(next: string) {
  const parsed = new URL(next, 'https://x.invalid');
  const win = (globalThis as { window: { location: { pathname: string; search: string } } }).window;
  win.location.pathname = parsed.pathname;
  win.location.search = parsed.search;
}

beforeEach(() => {
  calls.length = 0;
  useAccountPanelStore.setState({ pushedEntry: false });
  at('/projects/p_1');
});

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

describe('hubTarget — naming a place in the hub', () => {
  test('an account and its section', () => {
    expect(hubTarget('acc_1', { tab: 'members' })).toEqual({
      accountId: 'acc_1',
      params: { tab: 'members' },
    });
  });

  // So a caller can pass its optional drill-down straight through without
  // building a conditional object at every call site.
  test('nullish and empty values are dropped, not written as empty params', () => {
    expect(hubTarget('acc_1', { tab: 'groups', group: undefined, member: null, project: '' })).toEqual(
      { accountId: 'acc_1', params: { tab: 'groups' } },
    );
  });

  test('no account is the account list', () => {
    expect(hubTarget(null)).toEqual({ accountId: '', params: {} });
    expect(hubTarget(undefined)).toEqual({ accountId: '', params: {} });
  });
});

describe('accountPanelUrl — a param on the page you are on', () => {
  const target = hubTarget('acc_1', { tab: 'members' });

  test('the path never moves, and the hub keys are prefixed', () => {
    expect(accountPanelUrl('/projects/p_1/sessions/s_1', target)).toBe(
      '/projects/p_1/sessions/s_1?accountId=acc_1&accountTab=members',
    );
  });

  test("the page's own query survives", () => {
    expect(accountPanelUrl('/projects/p_1?view=grid', target)).toBe(
      '/projects/p_1?view=grid&accountId=acc_1&accountTab=members',
    );
  });

  // The reason for the prefix: the modal writes onto whatever page you are on,
  // so a bare `tab`/`project` would take a name any page might want.
  test("a page's own tab and project params are left completely alone", () => {
    const url = accountPanelUrl('/projects/p_1?tab=logs&project=x', target);
    expect(url).toContain('tab=logs');
    expect(url).toContain('project=x');
    expect(url).toContain('accountTab=members');
    expect(accountPanelClosedUrl(url)).toBe('/projects/p_1?tab=logs&project=x');
  });

  // Opening Members, then Billing, must not leave `accountMember=` behind
  // pointing at someone you are no longer looking at.
  test('a stale drill-down from a previous open is dropped, not merged', () => {
    const from = '/projects/p_1?accountId=acc_1&accountTab=members&accountMember=u_1';
    expect(accountPanelUrl(from, hubTarget('acc_1', { tab: 'billing' }))).toBe(
      '/projects/p_1?accountId=acc_1&accountTab=billing',
    );
  });

  test('the account list is the param with no value', () => {
    expect(accountPanelUrl('/projects/p_1', hubTarget(null))).toBe('/projects/p_1?accountId=');
    expect(readAccountPanelUrl('/projects/p_1?accountId=')).toEqual({ accountId: '' });
  });

  test('closing restores the page exactly, keeping its own query', () => {
    expect(accountPanelClosedUrl('/projects/p_1?view=grid&accountId=acc_1&accountTab=git')).toBe(
      '/projects/p_1?view=grid',
    );
    expect(accountPanelClosedUrl('/projects/p_1?accountId=acc_1')).toBe('/projects/p_1');
  });

  test('readAccountPanelUrl is what "open" means', () => {
    expect(readAccountPanelUrl('/projects/p_1')).toBe(null);
    expect(readAccountPanelUrl('/projects/p_1?accountId=acc_1')).toEqual({ accountId: 'acc_1' });
  });

  // The prefix exists on the wire and nowhere else: every pane inside the hub
  // reads `tab`/`member`/`group`/`project`/`from`/`setup`/`provider`.
  test('hubParamsFromUrl translates back into the hub’s own vocabulary', () => {
    const url = accountPanelUrl(
      '/projects/p_1',
      hubTarget('acc_1', { tab: 'identity', setup: 'scim', provider: 'okta' }),
    );
    const hub = hubParamsFromUrl(new URL(url, 'https://x.invalid').searchParams);
    expect(hub.get('tab')).toBe('identity');
    expect(hub.get('setup')).toBe('scim');
    expect(hub.get('provider')).toBe('okta');
    expect(hub.get('member')).toBe(null);
  });

  // A page that happens to use the short name must not leak into the hub.
  test('hubParamsFromUrl ignores the page’s own unprefixed params', () => {
    const hub = hubParamsFromUrl(new URLSearchParams('tab=logs&project=x&accountTab=roles'));
    expect(hub.get('tab')).toBe('roles');
    expect(hub.get('project')).toBe(null);
  });
});

describe('openAccountPanel — exactly one history entry', () => {
  test('the first open pushes; every move inside the hub replaces', () => {
    openAccountPanel(hubTarget('acc_1', { tab: 'members' }));
    openAccountPanel(hubTarget('acc_1', { tab: 'billing' }));
    openAccountPanel(hubTarget('acc_2'));

    expect(calls).toEqual([
      { op: 'push', url: '/projects/p_1?accountId=acc_1&accountTab=members' },
      { op: 'replace', url: '/projects/p_1?accountId=acc_1&accountTab=billing' },
      { op: 'replace', url: '/projects/p_1?accountId=acc_2' },
    ]);
  });

  test('closing pops that one entry — one Back press leaves the hub', () => {
    openAccountPanel(hubTarget('acc_1'));
    openAccountPanel(hubTarget('acc_1', { tab: 'roles' }));
    calls.length = 0;

    closeAccountPanel();

    expect(calls).toEqual([{ op: 'back' }]);
    expect(useAccountPanelStore.getState().pushedEntry).toBe(false);
  });

  // A reload, or a pasted link. Nothing of ours is on the stack, so popping
  // would throw the user off a page they arrived on directly.
  test('a modal it did not push closes by rewriting the entry, not by popping', () => {
    at('/projects/p_1?accountId=acc_1&accountTab=members');
    closeAccountPanel();
    expect(calls).toEqual([{ op: 'replace', url: '/projects/p_1' }]);
  });

  test('closing an already-closed modal is a no-op', () => {
    closeAccountPanel();
    expect(calls).toEqual([]);
  });

  // The exit that replaces the modal's entry instead of popping it: a
  // `router.replace` to a real page. A later close must not pop someone else's.
  test('forgetPushedEntry disarms the pop without touching history', () => {
    openAccountPanel(hubTarget('acc_1'));
    calls.length = 0;
    forgetPushedEntry();
    closeAccountPanel();
    expect(calls).toEqual([{ op: 'replace', url: '/projects/p_1' }]);
  });
});
