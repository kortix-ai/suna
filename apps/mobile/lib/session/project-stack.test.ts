import { describe, expect, test } from 'bun:test';
import {
  PROJECT_ACCOUNT_ROUTE,
  PROJECT_FILES_ROUTE,
  PROJECT_HOME_ROUTE,
  PROJECT_SESSIONS_ROUTE,
  PROJECT_VIEW_ROUTE,
  androidBackMove,
  drawerRouteMove,
  drawerSessionRowMove,
  returnHomeMove,
  shownProjectSessionId,
} from './project-stack';

const COVERING = [
  PROJECT_VIEW_ROUTE,
  PROJECT_SESSIONS_ROUTE,
  PROJECT_FILES_ROUTE,
  PROJECT_ACCOUNT_ROUTE,
] as const;
const DRAWER_ROUTES = [PROJECT_SESSIONS_ROUTE, PROJECT_FILES_ROUTE, PROJECT_ACCOUNT_ROUTE] as const;

describe('route names', () => {
  test('match the files under app/projects/[id]', () => {
    expect([
      PROJECT_HOME_ROUTE,
      PROJECT_VIEW_ROUTE,
      PROJECT_SESSIONS_ROUTE,
      PROJECT_FILES_ROUTE,
      PROJECT_ACCOUNT_ROUTE,
    ]).toEqual(['index', 'view', 'sessions', 'files', 'account']);
  });
});

describe('drawerRouteMove', () => {
  test('project home on top: push the route', () => {
    for (const route of DRAWER_ROUTES) {
      expect(drawerRouteMove(PROJECT_HOME_ROUTE, route)).toBe('push');
    }
  });

  test('the same route on top: nothing', () => {
    for (const route of DRAWER_ROUTES) {
      expect(drawerRouteMove(route, route)).toBe('none');
    }
  });

  test('another covering route on top: replace it, so the stack stays one screen deep', () => {
    for (const top of COVERING) {
      for (const route of DRAWER_ROUTES) {
        if (top === route) continue;
        expect(drawerRouteMove(top, route)).toBe('replace');
      }
    }
  });

  test('an unknown top (no focus event yet) is treated as project home', () => {
    expect(drawerRouteMove(null, PROJECT_FILES_ROUTE)).toBe('push');
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
});

describe('shownProjectSessionId', () => {
  const none = { showTabsOverview: false, activePageId: null, threadSessionId: null, connectingSessionId: null };

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

  test('a tool page or the tabs overview covers the session: none on screen', () => {
    expect(shownProjectSessionId({ ...none, activePageId: 'page:files', threadSessionId: 'ps-1' })).toBeNull();
    expect(shownProjectSessionId({ ...none, showTabsOverview: true, connectingSessionId: 'ps-2' })).toBeNull();
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
