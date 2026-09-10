import { test, expect } from 'bun:test';
import { configuredPublicOrigin, publicOriginFor } from './public-origin';

test('an https KORTIX_URL names the public origin, path and slash dropped', () => {
  expect(configuredPublicOrigin('https://pi-js.kortix.com/')).toBe('https://pi-js.kortix.com');
  expect(configuredPublicOrigin('https://api.kortix.com/v1')).toBe('https://api.kortix.com');
});
test('a laptop (http) or nothing at all keeps the request host — the subdomain scheme needs it', () => {
  expect(configuredPublicOrigin('http://localhost:8008')).toBeNull();
  expect(configuredPublicOrigin('')).toBeNull();
  expect(configuredPublicOrigin('not a url')).toBeNull();
  expect(publicOriginFor('http://localhost:8008', 'http', 'p3000-abc.localhost:8008')).toBe('http://p3000-abc.localhost:8008');
});
test('behind an ingress that rewrites Host, the configured origin wins (the dev-stack case)', () => {
  expect(publicOriginFor('https://pi-js.kortix.com', 'http', '8080-01m1sj00xfm1axhq1ya1e296g6.aec.local')).toBe('https://pi-js.kortix.com');
});
