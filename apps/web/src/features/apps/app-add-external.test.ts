import { describe, expect, test } from 'bun:test';
import { externalAppUrl } from './app-add-external';

describe('externalAppUrl', () => {
  test('adds https:// to a bare host', () => {
    expect(externalAppUrl('example.com')?.href).toBe('https://example.com/');
    expect(externalAppUrl('  docs.example.com/guide?x=1 ')?.href).toBe('https://docs.example.com/guide?x=1');
  });

  test('keeps an explicit https URL as typed', () => {
    expect(externalAppUrl('https://www.example.com/app')?.href).toBe('https://www.example.com/app');
  });

  test('rejects http, other schemes, hosts without a dot and empty input', () => {
    expect(externalAppUrl('http://example.com')).toBeNull();
    expect(externalAppUrl('ftp://example.com')).toBeNull();
    expect(externalAppUrl('localhost')).toBeNull();
    expect(externalAppUrl('')).toBeNull();
    expect(externalAppUrl('not a url')).toBeNull();
  });
});
