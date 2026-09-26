const { describe, it, expect } = require('bun:test');
const { resolveChannel, isDevChannel, isUpdaterSupported } = require('./update-channel');

describe('resolveChannel', () => {
  it('defaults to stable when unset', () => {
    expect(resolveChannel({})).toBe('stable');
    expect(resolveChannel(null)).toBe('stable');
    expect(resolveChannel(undefined)).toBe('stable');
  });

  it('reads the baked channel', () => {
    expect(resolveChannel({ kortixUpdateChannel: 'dev' })).toBe('dev');
    expect(resolveChannel({ kortixUpdateChannel: 'stable' })).toBe('stable');
  });
});

describe('isDevChannel', () => {
  it('is true only for the dev feed', () => {
    expect(isDevChannel('dev')).toBe(true);
    expect(isDevChannel('stable')).toBe(false);
    expect(isDevChannel(undefined)).toBe(false);
  });
});

describe('isUpdaterSupported', () => {
  it('enables only packaged stable builds', () => {
    expect(isUpdaterSupported({ isPackaged: true, channel: 'stable' })).toBe(true);
  });

  it('disables unpackaged (dev `electron .`) runs', () => {
    expect(isUpdaterSupported({ isPackaged: false, channel: 'stable' })).toBe(false);
  });

  it('disables the dev channel even when packaged', () => {
    expect(isUpdaterSupported({ isPackaged: true, channel: 'dev' })).toBe(false);
  });
});
