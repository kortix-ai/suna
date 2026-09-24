import { describe, expect, test } from 'bun:test';

import { CUSTOMIZE_TAB_ID } from '@/stores/project-session-tabs-store';

import { isActiveProjectTab } from './use-close-project-tab';

describe('isActiveProjectTab', () => {
  test('matches the Customize sentinel on every project Customize subroute', () => {
    expect(
      isActiveProjectTab('/projects/project-1/customize/connectors', 'project-1', CUSTOMIZE_TAB_ID),
    ).toBe(true);
  });

  test('matches only the requested session and project', () => {
    expect(
      isActiveProjectTab('/projects/project-1/sessions/session-1', 'project-1', 'session-1'),
    ).toBe(true);
    expect(
      isActiveProjectTab('/projects/project-1/sessions/session-2', 'project-1', 'session-1'),
    ).toBe(false);
    expect(
      isActiveProjectTab('/projects/project-2/sessions/session-1', 'project-1', 'session-1'),
    ).toBe(false);
  });
});
