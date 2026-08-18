import { describe, expect, test } from 'bun:test';

import {
  ACCOUNT_SCOPED_SETTINGS_TABS,
  isSettingsTabAllowed,
} from './settings-panel';
import { DEFAULT_SETTINGS_TAB } from './settings-tabs';
import {
  resolveSettingsExitPath,
  STANDALONE_DEFAULT_SETTINGS_TAB,
} from './standalone-settings-route';

/**
 * JAY-547. The component itself is not exercised here: it renders
 * `SettingsPanel`, which calls `useQuery`/`useProjectCans`/`useRouter` in its
 * own body and so cannot run under `renderToStaticMarkup` (see
 * `settings-panel.test.tsx`'s header for the full reasoning, and this
 * package's no-DOM-testing-library constraint). Both decisions the route makes
 * are pure and exported for exactly that reason.
 */

const PROJECT_ID = '1b1e6c9e-2a5d-4f1a-9f0b-7c3d2e5a8b41';

describe('resolveSettingsExitPath', () => {
  test('a remembered project sends the user back to it', () => {
    expect(resolveSettingsExitPath(PROJECT_ID)).toBe(`/projects/${PROJECT_ID}`);
  });

  test('no remembered project falls back to the list, never the provisioning door', () => {
    // `/projects/start` (`PROJECT_LANDING_PATH`) creates a project when the
    // account has none. This route exists so a user with NO app access can
    // reach billing without that happening, so closing the overlay must not
    // hand them one either. `/projects` applies the entitlement-aware rule
    // instead (`shouldAutoCreateFirstProject`).
    expect(resolveSettingsExitPath(null)).toBe('/projects');
    expect(resolveSettingsExitPath(undefined)).toBe('/projects');
  });

  test('a tampered cookie value is never interpolated into the path', () => {
    // The id comes from a browser-writable cookie, so it goes through
    // `projectPathFromId`'s UUID check rather than straight into the URL.
    expect(resolveSettingsExitPath('../../admin')).toBe('/projects');
    expect(resolveSettingsExitPath('')).toBe('/projects');
    expect(resolveSettingsExitPath(`${PROJECT_ID} `)).toBe('/projects');
  });
});

describe('STANDALONE_DEFAULT_SETTINGS_TAB', () => {
  test('is a tab that actually renders with no project', () => {
    // A project-scoped default would be filtered straight out of the rail and
    // the panel would bounce off it on the first frame.
    expect(ACCOUNT_SCOPED_SETTINGS_TABS).toContain(STANDALONE_DEFAULT_SETTINGS_TAB);
    expect(
      isSettingsTabAllowed(STANDALONE_DEFAULT_SETTINGS_TAB, { hasProject: false }),
    ).toBe(true);
  });

  test('the project-scoped default is reachable with no project too', () => {
    // The two constants converged when project configuration left the overlay
    // for `/projects/[id]/config`: `DEFAULT_SETTINGS_TAB` was `general`, the
    // project workspace tab, and is `profile` now. They stay separate
    // constants because they answer different questions — what the panel opens
    // on, and what the project-less route opens on — and a future
    // project-scoped default would split them again. What must hold either way
    // is that the standalone route never lands on a tab it cannot render.
    expect(isSettingsTabAllowed(DEFAULT_SETTINGS_TAB, { hasProject: false })).toBe(true);
  });
});
