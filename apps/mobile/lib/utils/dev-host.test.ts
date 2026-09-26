import { describe, expect, it } from 'bun:test';

import { hostFromMetroUri, pickDevHost } from './dev-host';

describe('hostFromMetroUri', () => {
  it('returns the LAN host from a Metro host URI', () => {
    expect(hostFromMetroUri('192.168.0.126:8081')).toBe('192.168.0.126');
  });

  it('accepts a host URI without a port', () => {
    expect(hostFromMetroUri('192.168.0.126')).toBe('192.168.0.126');
  });

  it('strips the brackets and port from an IPv6 host URI', () => {
    expect(hostFromMetroUri('[fe80::1]:8081')).toBe('fe80::1');
  });

  it('returns null for loopback hosts, which point at the device itself', () => {
    expect(hostFromMetroUri('localhost:8081')).toBeNull();
    expect(hostFromMetroUri('127.0.0.1:8081')).toBeNull();
    expect(hostFromMetroUri('[::1]:8081')).toBeNull();
  });

  it('returns null when there is no Metro host (release builds)', () => {
    expect(hostFromMetroUri(undefined)).toBeNull();
    expect(hostFromMetroUri(null)).toBeNull();
    expect(hostFromMetroUri('')).toBeNull();
  });
});

describe('pickDevHost', () => {
  it('prefers an explicit EXPO_PUBLIC_DEV_HOST', () => {
    expect(
      pickDevHost({ envHost: '10.0.0.5', metroHostUri: '192.168.0.126:8081', platform: 'android' })
    ).toBe('10.0.0.5');
  });

  it('uses the Metro host on a physical Android device (Expo Go)', () => {
    expect(pickDevHost({ metroHostUri: '192.168.0.126:8081', platform: 'android' })).toBe(
      '192.168.0.126'
    );
  });

  it('uses the Metro host on iOS too', () => {
    expect(pickDevHost({ metroHostUri: '192.168.0.126:8081', platform: 'ios' })).toBe(
      '192.168.0.126'
    );
  });

  it('falls back to the emulator bridge on Android without a Metro host', () => {
    expect(pickDevHost({ platform: 'android' })).toBe('10.0.2.2');
    expect(pickDevHost({ metroHostUri: 'localhost:8081', platform: 'android' })).toBe('10.0.2.2');
  });

  it('falls back to localhost on iOS without a Metro host', () => {
    expect(pickDevHost({ platform: 'ios' })).toBe('localhost');
  });

  it('ignores a blank EXPO_PUBLIC_DEV_HOST', () => {
    expect(pickDevHost({ envHost: '  ', metroHostUri: '192.168.0.126:8081', platform: 'android' })).toBe(
      '192.168.0.126'
    );
  });
});
