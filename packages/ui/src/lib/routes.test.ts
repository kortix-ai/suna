import { afterEach, expect, test } from 'bun:test';

import { filesRow } from '../internal/layout/files-nav-label';
import { capabilityTabHref } from '../internal/lib/capability-tab-routes';
import { projectSessionHref } from '../internal/lib/navigation/session-href';
import { setUiRoutes, uiRoutes } from './routes';

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
});
