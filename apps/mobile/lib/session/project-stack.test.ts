import { describe, expect, test } from 'bun:test';
import {
  PROJECT_ACCOUNT_ROUTE,
  PROJECT_FILES_ROUTE,
  PROJECT_HOME_ROUTE,
  PROJECT_PAGE_ROUTE,
  PROJECT_SESSIONS_ROUTE,
  PROJECT_VIEW_ROUTE,
  SUB_PAGE_IDS,
  androidBackMove,
  homeAndRoute,
  isSubPageId,
  projectEdgeGesture,
  subPageLeaveMove,
  subPageOpenMove,
  subPageBackMove,
  drawerRouteMove,
  drawerSessionRowMove,
  returnHomeMove,
  shownProjectSessionId,
  pageBackMove,
  returnThreadForPage,
} from './project-stack';

const COVERING = [
  PROJECT_VIEW_ROUTE,
  PROJECT_SESSIONS_ROUTE,
  PROJECT_FILES_ROUTE,
  PROJECT_ACCOUNT_ROUTE,
] as const;
const DRAWER_ROUTES = [PROJECT_SESSIONS_ROUTE, PROJECT_FILES_ROUTE, PROJECT_ACCOUNT_ROUTE] as const;
const HOME = PROJECT_HOME_ROUTE;
const PAGE = PROJECT_PAGE_ROUTE;

describe('route names', () => {
  test('match the files under app/projects/[id]', () => {
    expect([
      PROJECT_HOME_ROUTE,
      PROJECT_VIEW_ROUTE,
      PROJECT_SESSIONS_ROUTE,
      PROJECT_FILES_ROUTE,
      PROJECT_ACCOUNT_ROUTE,
      PROJECT_PAGE_ROUTE,
    ]).toEqual(['index', 'view', 'sessions', 'files', 'account', 'page']);
  });
});

describe('drawerRouteMove', () => {
  test('project home on top: push the route', () => {
    for (const route of DRAWER_ROUTES) {
      expect(drawerRouteMove([HOME], route)).toBe('push');
    }
  });

  test('the same route alone over home: nothing', () => {
    for (const route of DRAWER_ROUTES) {
      expect(drawerRouteMove([HOME, route], route)).toBe('none');
    }
  });

  test('another covering route on top: replace it, so the stack stays one screen deep', () => {
    for (const top of COVERING) {
      for (const route of DRAWER_ROUTES) {
        if (top === route) continue;
        expect(drawerRouteMove([HOME, top], route)).toBe('replace');
      }
    }
  });

  test('an unknown stack (no focus event yet) is treated as project home', () => {
    expect(drawerRouteMove(null, PROJECT_FILES_ROUTE)).toBe('push');
  });

  test('sub-pages over the same route: pop back to it (Settings with Schedules pushed, avatar tapped)', () => {
    expect(drawerRouteMove([HOME, PROJECT_ACCOUNT_ROUTE, PAGE], PROJECT_ACCOUNT_ROUTE)).toBe('pop-to');
    expect(drawerRouteMove([HOME, PROJECT_ACCOUNT_ROUTE, PAGE, PAGE], PROJECT_ACCOUNT_ROUTE)).toBe('pop-to');
  });

  test('sub-pages over another route: reset to [home, route], never deeper', () => {
    expect(drawerRouteMove([HOME, PROJECT_ACCOUNT_ROUTE, PAGE], PROJECT_FILES_ROUTE)).toBe('reset');
    expect(drawerRouteMove([HOME, PROJECT_VIEW_ROUTE, PAGE, PAGE], PROJECT_SESSIONS_ROUTE)).toBe('reset');
  });

  test('a stack that does not start on home (deep link): same rules over the first route', () => {
    expect(drawerRouteMove([PROJECT_ACCOUNT_ROUTE], PROJECT_ACCOUNT_ROUTE)).toBe('none');
    expect(drawerRouteMove([PROJECT_ACCOUNT_ROUTE], PROJECT_FILES_ROUTE)).toBe('replace');
    expect(drawerRouteMove([PROJECT_ACCOUNT_ROUTE, PAGE], PROJECT_ACCOUNT_ROUTE)).toBe('pop-to');
    expect(drawerRouteMove([PROJECT_ACCOUNT_ROUTE, PAGE], PROJECT_FILES_ROUTE)).toBe('reset');
  });
});

describe('returnHomeMove', () => {
  test('project home on top: nothing to pop', () => {
    expect(returnHomeMove(PROJECT_HOME_ROUTE)).toBe('none');
    expect(returnHomeMove(null)).toBe('none');
  });

  test('any covering route on top: pop to project home', () => {
    for (const top of COVERING) {
      expect(returnHomeMove(top)).toBe('pop-home');
    }
  });
});

describe('androidBackMove', () => {
  test('an open drawer closes first, on every route', () => {
    for (const top of [PROJECT_HOME_ROUTE, ...COVERING]) {
      expect(androidBackMove(top, true)).toBe('close-drawer');
    }
  });

  test('a covering route pops to project home', () => {
    for (const top of COVERING) {
      expect(androidBackMove(top, false)).toBe('pop-home');
    }
  });

  test('project home keeps the existing home rule', () => {
    expect(androidBackMove(PROJECT_HOME_ROUTE, false)).toBe('home');
    expect(androidBackMove(null, false)).toBe('home');
  });

  test('a pushed sub-page pops one level: back to the page it was opened from', () => {
    expect(androidBackMove(PAGE, false)).toBe('pop');
  });

  test('an open drawer still closes first over a sub-page', () => {
    expect(androidBackMove(PAGE, true)).toBe('close-drawer');
  });
});

describe('sub-pages', () => {
  test('project Settings, Schedules and Secrets are the pages that open as sub-pages', () => {
    expect([...SUB_PAGE_IDS]).toEqual(['page:settings', 'page:schedules', 'page:secrets-nav']);
    for (const id of SUB_PAGE_IDS) expect(isSubPageId(id)).toBe(true);
  });

  test('other page ids, and a missing param, are not sub-pages', () => {
    for (const id of ['page:review', 'page:files-nav', 'page:browser', '', undefined, null]) {
      expect(isSubPageId(id)).toBe(false);
    }
  });
});

describe('subPageOpenMove', () => {
  test('push the sub-page over the screen it is opened from', () => {
    expect(subPageOpenMove({ name: PROJECT_ACCOUNT_ROUTE }, 'page:settings')).toBe('push');
    expect(subPageOpenMove({ name: PAGE, pageId: 'page:settings' }, 'page:schedules')).toBe('push');
  });

  test('the same sub-page already on top (a double tap): nothing', () => {
    expect(subPageOpenMove({ name: PAGE, pageId: 'page:schedules' }, 'page:schedules')).toBe('none');
  });

  test('no stack yet: nothing to push onto', () => {
    expect(subPageOpenMove(null, 'page:settings')).toBe('none');
  });
});

describe('subPageBackMove', () => {
  test('a screen under the sub-page: pop to it', () => {
    expect(subPageBackMove([HOME, PROJECT_ACCOUNT_ROUTE, PAGE])).toBe('pop');
    expect(subPageBackMove([PROJECT_ACCOUNT_ROUTE, PAGE])).toBe('pop');
  });

  test('nothing under it (a deep link straight to a sub-page): replace it with project home', () => {
    expect(subPageBackMove([PAGE])).toBe('replace-home');
  });
});

describe('subPageLeaveMove', () => {
  test('a view under the sub-pages: pop to it, and it swaps its content (never replace view with view)', () => {
    expect(subPageLeaveMove([HOME, PROJECT_VIEW_ROUTE, PAGE])).toBe('pop-to-view');
    expect(subPageLeaveMove([HOME, PROJECT_VIEW_ROUTE, PAGE, PAGE])).toBe('pop-to-view');
  });

  test('another covering route under the sub-pages: reset to [home, view]', () => {
    expect(subPageLeaveMove([HOME, PROJECT_ACCOUNT_ROUTE, PAGE])).toBe('reset-to-view');
    expect(subPageLeaveMove([HOME, PROJECT_ACCOUNT_ROUTE, PAGE, PAGE])).toBe('reset-to-view');
  });
});

describe('projectEdgeGesture', () => {
  test('the left edge opens the drawer on home and on every covering route', () => {
    for (const top of [null, HOME, ...COVERING]) {
      expect(projectEdgeGesture(top)).toBe('drawer');
    }
  });

  test('on a pushed sub-page the left edge goes back (iOS swipe-back), not the drawer', () => {
    expect(projectEdgeGesture(PAGE)).toBe('back');
  });
});

describe('shownProjectSessionId', () => {
  const none = { activePageId: null, threadSessionId: null, connectingSessionId: null };

  test('project home: no session on screen', () => {
    expect(shownProjectSessionId(none)).toBeNull();
  });

  test('a thread on screen: its project session id', () => {
    expect(shownProjectSessionId({ ...none, threadSessionId: 'ps-1' })).toBe('ps-1');
  });

  test('a connecting session on screen: its id', () => {
    expect(shownProjectSessionId({ ...none, connectingSessionId: 'ps-2' })).toBe('ps-2');
  });

  test('the thread wins over a stale connecting id, like the view render order', () => {
    expect(
      shownProjectSessionId({ ...none, threadSessionId: 'ps-1', connectingSessionId: 'ps-2' })
    ).toBe('ps-1');
  });

  test('a tool page covers the session: none on screen', () => {
    expect(shownProjectSessionId({ ...none, activePageId: 'page:browser', threadSessionId: 'ps-1' })).toBeNull();
    expect(shownProjectSessionId({ ...none, activePageId: 'page:review', connectingSessionId: 'ps-2' })).toBeNull();
  });
});

describe('drawerSessionRowMove', () => {
  test('the row of the session on screen only closes the drawer', () => {
    expect(drawerSessionRowMove('ps-1', 'ps-1')).toBe('close');
  });

  test('another row opens its session', () => {
    expect(drawerSessionRowMove('ps-2', 'ps-1')).toBe('open');
    expect(drawerSessionRowMove('ps-2', null)).toBe('open');
  });
});

describe('returnThreadForPage', () => {
  test('a page opened over a thread remembers that thread', () => {
    expect(
      returnThreadForPage({ activeSessionId: 'ses-1', activePageId: null, current: null }),
    ).toBe('ses-1');
  });

  test('a second page opened from the first keeps the same thread', () => {
    expect(
      returnThreadForPage({ activeSessionId: null, activePageId: 'page:agents', current: 'ses-1' }),
    ).toBe('ses-1');
  });

  test('a page opened from project home has no thread to return to', () => {
    expect(
      returnThreadForPage({ activeSessionId: null, activePageId: null, current: null }),
    ).toBeNull();
  });

  test('a stale thread does not survive a page opened from project home', () => {
    expect(
      returnThreadForPage({ activeSessionId: null, activePageId: null, current: 'ses-1' }),
    ).toBeNull();
  });
});

describe('pageBackMove', () => {
  test('back from a page opened over a thread returns to that thread', () => {
    expect(pageBackMove({ activePageId: 'page:review', returnThreadId: 'ses-1' })).toBe(
      'return-to-thread',
    );
  });

  test('back from a page opened from project home goes home', () => {
    expect(pageBackMove({ activePageId: 'page:review', returnThreadId: null })).toBe('home');
  });

  test('back from a thread goes home, whatever was remembered', () => {
    expect(pageBackMove({ activePageId: null, returnThreadId: 'ses-1' })).toBe('home');
  });
});

describe('homeAndRoute', () => {
  test('keeps the mounted project home (its key), then the new route', () => {
    expect(
      homeAndRoute({ key: 'index-1', name: HOME, params: { id: 'p' } }, { name: PROJECT_VIEW_ROUTE })
    ).toEqual({
      index: 1,
      routes: [{ key: 'index-1', name: HOME, params: { id: 'p' } }, { name: PROJECT_VIEW_ROUTE }],
    });
  });

  test('a stack that does not start on home gets a new home under the route', () => {
    expect(
      homeAndRoute({ key: 'account-1', name: PROJECT_ACCOUNT_ROUTE }, { name: PROJECT_FILES_ROUTE, params: { id: 'p' } })
    ).toEqual({ index: 1, routes: [{ name: HOME }, { name: PROJECT_FILES_ROUTE, params: { id: 'p' } }] });
  });
});
