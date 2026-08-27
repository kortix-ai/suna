const { describe, it, expect } = require('bun:test');
const { resolveChannel, isUpdaterSupported } = require('./update-channel');

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

describe('isUpdaterSupported', () => {
  it('enables only packaged stable builds', () => {
    expect(isUpdaterSupported({ isPackaged: true, channel: 'stable' })).toBe(true);
  });

  it('disables unpackaged (dev `electron .`) runs', () => {
    expect(isUpdaterSupported({ isPackaged: false, channel: 'stable' })).toBe(false);
  });

  // dev and staging publish to mutable prereleases, not versioned feeds, so
  // there is nothing for electron-updater to compare against — and a successful
  // "update" would silently move the user onto a prod installer.
  it.each(['dev', 'staging'])('disables the %s channel even when packaged', (channel) => {
    expect(isUpdaterSupported({ isPackaged: true, channel })).toBe(false);
  });
});
