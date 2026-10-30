import { describe, expect, test } from 'bun:test';

import { resolveHomeLanding } from './home-landing';

const base = { flagLoading: false, channelsOn: false, spacesLoaded: false, spacesFailed: false, defaultSlug: null };

describe('resolveHomeLanding', () => {
  test('waits while the flag loads: home never mounts under a redirect', () => {
    expect(resolveHomeLanding({ ...base, flagLoading: true })).toEqual({ kind: 'wait' });
    expect(resolveHomeLanding({ ...base, flagLoading: true, channelsOn: true, defaultSlug: 'general' })).toEqual({
      kind: 'wait',
    });
  });

  test('channels off: project home', () => {
    expect(resolveHomeLanding(base)).toEqual({ kind: 'home' });
  });

  test('channels on: waits for the list, then the default channel by its current slug', () => {
    expect(resolveHomeLanding({ ...base, channelsOn: true })).toEqual({ kind: 'wait' });
    expect(resolveHomeLanding({ ...base, channelsOn: true, spacesLoaded: true, defaultSlug: 'team' })).toEqual({
      kind: 'channel',
      slug: 'team',
    });
  });

  test('channels on but the list failed or has no default: project home stays usable', () => {
    expect(resolveHomeLanding({ ...base, channelsOn: true, spacesFailed: true })).toEqual({ kind: 'home' });
    expect(resolveHomeLanding({ ...base, channelsOn: true, spacesLoaded: true })).toEqual({ kind: 'home' });
  });
});
