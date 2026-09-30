import { describe, expect, test } from 'bun:test';

import {
  childSessionHref,
  projectChildSessionHref,
  readRuntimeSessionParam,
} from './session-spawn-urls';

describe('projectChildSessionHref', () => {
  test('deep-links from a project session route to a child runtime session', () => {
    expect(projectChildSessionHref('/projects/proj-1/sessions/route-session-1', 'ses_child1')).toBe(
      '/projects/proj-1/sessions/route-session-1?rs=ses_child1',
    );
  });

  test('encodes the child session id query value', () => {
    expect(projectChildSessionHref('/projects/p/sessions/s', 'ses_child/one')).toBe(
      '/projects/p/sessions/s?rs=ses_child%2Fone',
    );
  });

  test('returns null outside a project session route', () => {
    expect(projectChildSessionHref('/projects/p', 'ses_child1')).toBeNull();
    expect(projectChildSessionHref('/marketplace', 'ses_child1')).toBeNull();
    expect(projectChildSessionHref('/projects/p/sessions/s', undefined)).toBeNull();
  });
});

describe('the runtime session query parameter', () => {
  test('a link names the child as `rs`', () => {
    expect(childSessionHref('/projects/p/sessions/s', 'ses_child/one')).toBe(
      '/projects/p/sessions/s?rs=ses_child%2Fone',
    );
  });

  test('a pre-W4 `?oc=` link still opens its child; `rs` wins when both are present', () => {
    expect(readRuntimeSessionParam(new URLSearchParams('oc=ses_old'))).toBe('ses_old');
    expect(readRuntimeSessionParam(new URLSearchParams('rs=ses_new&oc=ses_old'))).toBe('ses_new');
    expect(readRuntimeSessionParam(new URLSearchParams(''))).toBeNull();
  });
});
