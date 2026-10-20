import { afterEach, expect, test } from 'bun:test';

import { filesRow } from '../internal/layout/files-nav-label';
import {
  capabilityLinkHref,
  capabilityTabHref,
  remindersHref,
  reviewHref,
} from '../internal/lib/capability-tab-routes';
import { projectSessionHref } from '../internal/lib/navigation/session-href';
import { isProjectPath, sessionIdFromPath, setUiRoutes, uiRoutes } from './routes';

afterEach(() => setUiRoutes({}));

test('the defaults are apps/web paths', () => {
  expect(uiRoutes().session('p', 's')).toBe('/projects/p/sessions/s');
  expect(uiRoutes().sessions('p', 'archived')).toBe('/projects/p/sessions?view=archived');
  expect(capabilityTabHref('p', 'models')).toBe('/projects/p/customize/models');
  expect(filesRow('p', 'drive')).toEqual({ label: 'drive', href: '/projects/p/drive' });
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
  expect(capabilityTabHref('p', 'models')).toBe('/projects/p/customize/models');
  // Links from outside the customize pages hide: sidebar row, review and reminders links.
  expect(capabilityLinkHref('p', 'agent')).toBeNull();
  expect(reviewHref('p')).toBeNull();
  expect(remindersHref('p')).toBeNull();
});

test('review and reminders links follow the host customize route', () => {
  expect(reviewHref('p')).toBe('/projects/p/customize/review');
  setUiRoutes({ customize: (p, path) => `/w/${p}/setup/${path ?? ''}` });
  expect(remindersHref('p')).toBe('/w/p/setup/reminders');
});

test('the open session and project are read through the host routes', () => {
  expect(sessionIdFromPath('/projects/p/sessions/s1', 'p')).toBe('s1');
  expect(sessionIdFromPath('/projects/p/sessions/s1/files', 'p')).toBe('s1');
  expect(sessionIdFromPath('/projects/p2/sessions/s1', 'p')).toBeNull();
  expect(isProjectPath('/projects/p/files', 'p')).toBe(true);
  expect(isProjectPath('/projects/p2', 'p')).toBe(false);
  setUiRoutes({ project: (p) => `/w/${p}`, session: (p, s) => `/w/${p}/chat/${s}` });
  expect(sessionIdFromPath('/w/p/chat/s1', 'p')).toBe('s1');
  expect(sessionIdFromPath('/projects/p/sessions/s1', 'p')).toBeNull();
  expect(isProjectPath('/w/p/chat/s1', 'p')).toBe(true);
  expect(isProjectPath('/projects/p', 'p')).toBe(false);
});
