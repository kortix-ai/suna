import { describe, expect, test } from 'bun:test';

import { voiceCallSocketUrl, voiceRelayHealthUrl } from './voice-call-url';

const PORT_URL = 'https://api.example.test/v1/p/sbx-fixture/6902';

describe('voiceCallSocketUrl', () => {
  test('the relay stream behind the path proxy, with the session and the token; a first dial greets', () => {
    const url = new URL(voiceCallSocketUrl(PORT_URL, { session: 'ses-fixture', token: 'jwt-fixture', redial: false, securePage: true }));
    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('api.example.test');
    expect(url.pathname).toBe('/v1/p/sbx-fixture/6902/stream');
    expect(url.searchParams.get('session')).toBe('ses-fixture');
    expect(url.searchParams.get('token')).toBe('jwt-fixture');
    expect(url.searchParams.has('greet')).toBe(false);
  });

  test('http becomes ws, and wss on an https page (a browser blocks ws:// there)', () => {
    const local = 'http://localhost:8008/v1/p/sbx-fixture/6902';
    expect(voiceCallSocketUrl(local, { session: 's', token: null, redial: false, securePage: false })).toStartWith('ws://');
    expect(voiceCallSocketUrl(local, { session: 's', token: null, redial: false, securePage: true })).toStartWith('wss://');
  });

  test('a redial asks the relay not to greet again, and no token means no token parameter', () => {
    const url = new URL(voiceCallSocketUrl(PORT_URL, { session: 's', token: null, redial: true, securePage: true }));
    expect(url.searchParams.get('greet')).toBe('0');
    expect(url.searchParams.has('token')).toBe(false);
  });

  test('a trailing slash on the port URL gives one slash before stream', () => {
    const url = new URL(voiceCallSocketUrl(`${PORT_URL}/`, { session: 's', token: null, redial: false, securePage: true }));
    expect(url.pathname).toBe('/v1/p/sbx-fixture/6902/stream');
  });

  test('the session id is encoded as a query value', () => {
    const url = new URL(voiceCallSocketUrl(PORT_URL, { session: 'a b&c', token: null, redial: false, securePage: true }));
    expect(url.searchParams.get('session')).toBe('a b&c');
  });
});

describe('voiceRelayHealthUrl', () => {
  test('the health route on the same port, with no credential in its URL', () => {
    const url = new URL(voiceRelayHealthUrl(PORT_URL));
    expect(url.protocol).toBe('https:');
    expect(url.pathname).toBe('/v1/p/sbx-fixture/6902/health');
    expect(url.searchParams.has('token')).toBe(false);
  });
});
