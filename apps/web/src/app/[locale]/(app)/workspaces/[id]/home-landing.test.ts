import { describe, expect, test } from 'bun:test';

import { resolveHomeLanding } from './home-landing';

const base = { flagLoading: false, channelsOn: false };

describe('resolveHomeLanding', () => {
  test('waits while the flag loads: home never mounts under a redirect', () => {
    expect(resolveHomeLanding({ ...base, flagLoading: true })).toEqual({ kind: 'wait' });
    expect(resolveHomeLanding({ ...base, flagLoading: true, channelsOn: true })).toEqual({ kind: 'wait' });
  });

  test('spaces off: project home', () => {
    expect(resolveHomeLanding(base)).toEqual({ kind: 'home' });
  });

  test("spaces on: the person's own space, at once", () => {
    expect(resolveHomeLanding({ ...base, channelsOn: true })).toEqual({ kind: 'space' });
  });

  test('spaces on with a new-session request (`?new=1`): project home, never the space', () => {
    expect(resolveHomeLanding({ ...base, channelsOn: true, newSessionRequested: true })).toEqual({ kind: 'home' });
    expect(resolveHomeLanding({ ...base, flagLoading: true, newSessionRequested: true })).toEqual({ kind: 'wait' });
  });
});
