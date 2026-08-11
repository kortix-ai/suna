import { describe, expect, test } from 'bun:test';

import { workspaceChildSessionHref } from './session-spawn-urls';

describe('workspaceChildSessionHref', () => {
  test('deep-links from a workspace session route to a child OpenCode session', () => {
    expect(workspaceChildSessionHref('/projects/proj-1/sessions/route-session-1', 'ses_child1')).toBe(
      '/workspaces/proj-1/sessions/route-session-1?oc=ses_child1',
    );
  });

  test('encodes the child session id query value', () => {
    expect(workspaceChildSessionHref('/projects/p/sessions/s', 'ses_child/one')).toBe(
      '/workspaces/p/sessions/s?oc=ses_child%2Fone',
    );
  });

  test('returns null outside a workspace session route', () => {
    expect(workspaceChildSessionHref('/projects/p', 'ses_child1')).toBeNull();
    expect(workspaceChildSessionHref('/marketplace', 'ses_child1')).toBeNull();
    expect(workspaceChildSessionHref('/projects/p/sessions/s', undefined)).toBeNull();
  });
});
