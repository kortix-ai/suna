import { describe, expect, test } from 'bun:test';

import { projectChildSessionHref } from './session-spawn-urls';

describe('projectChildSessionHref', () => {
  test('deep-links from a project session route to a child OpenCode session', () => {
    expect(
      projectChildSessionHref(
        '/projects/proj-1/sessions/route-session-1',
        'ses_child1',
      ),
    ).toBe('/projects/proj-1/sessions/route-session-1?oc=ses_child1');
  });

  test('encodes the child session id query value', () => {
    expect(
      projectChildSessionHref('/projects/p/sessions/s', 'ses_child/one'),
    ).toBe('/projects/p/sessions/s?oc=ses_child%2Fone');
  });

  test('returns null outside a project session route', () => {
    expect(projectChildSessionHref('/projects/p', 'ses_child1')).toBeNull();
    expect(projectChildSessionHref('/marketplace', 'ses_child1')).toBeNull();
    expect(projectChildSessionHref('/projects/p/sessions/s', undefined)).toBeNull();
  });
});
