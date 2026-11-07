import { afterEach, expect, test } from 'bun:test';

import { filesRow } from '../internal/layout/files-nav-label';
import {
  capabilityLinkHref,
  capabilityTabHref,
  remindersHref,
  reviewHref,
} from '../internal/lib/capability-tab-routes';
import { projectSessionHref } from '../internal/lib/navigation/session-href';
import { canonicalAppPath } from '../internal/lib/onboarding/landing-destination';
import { isProjectPath, sessionIdFromPath, setUiRoutes, uiRoutes } from './routes';

afterEach(() => setUiRoutes({}));

test('the defaults are apps/web paths', () => {
  expect(uiRoutes().session('p', 's')).toBe('/workspaces/p/sessions/s');
  expect(uiRoutes().sessions('p', 'archived')).toBe('/workspaces/p/sessions?view=archived');
  expect(capabilityTabHref('p', 'models')).toBe('/workspaces/p/admin/models');
  expect(filesRow('p', 'drive')).toEqual({ label: 'drive', href: '/workspaces/p/drive' });
});

test('every default route is under /workspaces, never /projects (2026-11-06)', () => {
  const r = uiRoutes();
  const built = [
    r.project('p'),
    r.session('p', 's'),
    r.sessions('p'),
    r.files('p', 'proposed-changes'),
    r.drive('p'),
    r.apps('p'),
    r.goals('p'),
    r.artifacts('p'),
    r.space('p', 'sales'),
    r.members('p'),
    r.sandboxSettings('p'),
    r.customize('p', 'agents'),
    r.admin('p', 'models'),
    r.channel('p', 'general'),
    r.dm('p', 'kortix'),
    r.memory('p'),
    r.review?.('p'),
  ];
  for (const href of built) expect(href).toStartWith('/workspaces/p');
  expect(isProjectPath('/workspaces/p/sessions/s', 'p')).toBe(true);
  expect(sessionIdFromPath('/workspaces/p/sessions/s', 'p')).toBe('s');
});

test('canonicalAppPath moves an old /projects or /new path to /workspaces and leaves the rest', () => {
  expect(canonicalAppPath('/projects/p/sessions/s?notification=n')).toBe('/workspaces/p/sessions/s?notification=n');
  expect(canonicalAppPath('/projects')).toBe('/workspaces');
  expect(canonicalAppPath('/new?source=github-import')).toBe('/workspaces/new?source=github-import');
  for (const path of ['/workspaces/p', '/projectsx', '/newsroom', '/settings/billing', '/capture/a/devices']) {
    expect(canonicalAppPath(path)).toBe(path);
  }
});

test('a host route replaces the default everywhere it is built', () => {
  setUiRoutes({ session: (p, s) => `/w/${p}/c/${s}`, customize: (p, path) => `/w/${p}/setup/${path ?? ''}` });
  expect(projectSessionHref('p', 's')).toBe('/w/p/c/s');
  expect(capabilityTabHref('p', 'models')).toBe('/w/p/setup/models');
});

test('a route the host maps to null hides its row; the customize pages keep their own links', () => {
  setUiRoutes({ drive: () => null, customize: () => null });
  expect(filesRow('p', 'drive')).toBeNull();
  expect(uiRoutes().customize('p', 'models')).toBeNull();
  expect(capabilityTabHref('p', 'models')).toBe('/workspaces/p/admin/models');
  // Links from outside the customize pages hide: sidebar row, review and reminders links.
  expect(capabilityLinkHref('p', 'agent')).toBeNull();
  expect(reviewHref('p')).toBeNull();
  expect(remindersHref('p')).toBeNull();
});

test('review and reminders links follow the host customize route', () => {
  // Review is its own page by default; a host that routes its own customize pages serves it there.
  expect(reviewHref('p')).toBe('/workspaces/p/review');
  setUiRoutes({ customize: (p, path) => `/w/${p}/setup/${path ?? ''}` });
  expect(remindersHref('p')).toBe('/w/p/setup/triggers');
  expect(reviewHref('p')).toBe('/w/p/setup/review');
});

test('the Inbox is its own page by default; a host with its own router serves it only when it routes it', () => {
  expect(uiRoutes().inbox?.('p')).toBe('/workspaces/p/inbox');
  // A host that maps other routes predates the Inbox page: no row links to a page it does not serve.
  setUiRoutes({ drive: () => null });
  expect(uiRoutes().inbox?.('p') ?? null).toBeNull();
  setUiRoutes({ drive: () => null, inbox: (p) => `/w/${p}/inbox` });
  expect(uiRoutes().inbox?.('p')).toBe('/w/p/inbox');
});

test('the open session and project are read through the host routes', () => {
  expect(sessionIdFromPath('/workspaces/p/sessions/s1', 'p')).toBe('s1');
  expect(sessionIdFromPath('/workspaces/p/sessions/s1/files', 'p')).toBe('s1');
  expect(sessionIdFromPath('/workspaces/p2/sessions/s1', 'p')).toBeNull();
  expect(isProjectPath('/workspaces/p/files', 'p')).toBe(true);
  expect(isProjectPath('/workspaces/p2', 'p')).toBe(false);
  setUiRoutes({ project: (p) => `/w/${p}`, session: (p, s) => `/w/${p}/chat/${s}` });
  expect(sessionIdFromPath('/w/p/chat/s1', 'p')).toBe('s1');
  expect(sessionIdFromPath('/workspaces/p/sessions/s1', 'p')).toBeNull();
  expect(isProjectPath('/w/p/chat/s1', 'p')).toBe(true);
  expect(isProjectPath('/workspaces/p', 'p')).toBe(false);
});
