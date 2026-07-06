import { test, expect } from 'bun:test';
import {
  ACTIVE_INSTANCE_COOKIE,
  buildInstancePath,
  extractInstanceRoute,
  getActiveInstanceIdFromCookie,
  getCurrentInstanceIdFromPathname,
  getCurrentInstanceIdFromWindow,
  isInstanceDetailPath,
  isInstanceScopedAppPath,
  normalizeAppPathname,
  setActiveInstanceCookie,
  stripInstancePrefix,
  toInstanceAwarePath,
} from './instance-routes';

// This whole file runs with no `window`/`document` global (bun test has no DOM
// by default — confirmed: `typeof window` is 'undefined' here). That's exactly
// the "non-browser branch" this task wants exercised for the guarded functions
// below: each one checks `typeof window/document === 'undefined'` and must
// degrade to a safe no-op/null instead of throwing ReferenceError.

test('ACTIVE_INSTANCE_COOKIE is the stable cookie name', () => {
  expect(ACTIVE_INSTANCE_COOKIE).toBe('kortix-active-instance');
});

// ── isInstanceScopedAppPath ────────────────────────────────────────────────

test('isInstanceScopedAppPath matches an exact route and any nested sub-path', () => {
  expect(isInstanceScopedAppPath('/dashboard')).toBe(true);
  expect(isInstanceScopedAppPath('/dashboard/foo')).toBe(true);
  expect(isInstanceScopedAppPath('/sessions/abc123')).toBe(true);
});

test('isInstanceScopedAppPath rejects unrelated paths and near-misses', () => {
  expect(isInstanceScopedAppPath('/login')).toBe(false);
  expect(isInstanceScopedAppPath('/dashboards')).toBe(false); // prefix, not a route boundary
  expect(isInstanceScopedAppPath('/')).toBe(false);
});

// ── extractInstanceRoute ────────────────────────────────────────────────────

test('extractInstanceRoute parses an instance id with a nested inner path', () => {
  expect(extractInstanceRoute('/instances/inst-1/sessions/s1')).toEqual({
    instanceId: 'inst-1',
    innerPath: '/sessions/s1',
  });
});

test('extractInstanceRoute parses a bare instance id with no inner path', () => {
  expect(extractInstanceRoute('/instances/inst-1')).toEqual({
    instanceId: 'inst-1',
    innerPath: '',
  });
});

test('extractInstanceRoute URL-decodes the instance id', () => {
  expect(extractInstanceRoute('/instances/inst%20one/x')?.instanceId).toBe('inst one');
});

test('extractInstanceRoute returns null for a non-instance path', () => {
  expect(extractInstanceRoute('/dashboard')).toBeNull();
});

// ── isInstanceDetailPath ─────────────────────────────────────────────────────

test('isInstanceDetailPath is true only for the bare /instances/<id> path', () => {
  expect(isInstanceDetailPath('/instances/inst-1')).toBe(true);
  expect(isInstanceDetailPath('/instances/inst-1/sessions/s1')).toBe(false);
  expect(isInstanceDetailPath('/dashboard')).toBe(false);
});

// ── stripInstancePrefix ──────────────────────────────────────────────────────

test('stripInstancePrefix strips the /instances/<id> prefix, keeping the inner path', () => {
  expect(stripInstancePrefix('/instances/inst-1/sessions/s1')).toBe('/sessions/s1');
});

test('stripInstancePrefix leaves a non-instance path untouched', () => {
  expect(stripInstancePrefix('/dashboard')).toBe('/dashboard');
});

test('stripInstancePrefix leaves a bare instance-detail path (no inner path) untouched', () => {
  expect(stripInstancePrefix('/instances/inst-1')).toBe('/instances/inst-1');
});

// ── buildInstancePath ────────────────────────────────────────────────────────

test('buildInstancePath prefixes an instance-scoped path with /instances/<id>', () => {
  expect(buildInstancePath('inst-1', '/dashboard')).toBe('/instances/inst-1/dashboard');
});

test('buildInstancePath URL-encodes the instance id', () => {
  expect(buildInstancePath('inst one', '/dashboard')).toBe('/instances/inst%20one/dashboard');
});

test('buildInstancePath normalizes a pathname missing its leading slash', () => {
  expect(buildInstancePath('inst-1', 'dashboard')).toBe('/instances/inst-1/dashboard');
});

test('buildInstancePath leaves a non-scoped path untouched', () => {
  expect(buildInstancePath('inst-1', '/login')).toBe('/login');
});

test('buildInstancePath returns the pathname unchanged when instanceId is empty', () => {
  expect(buildInstancePath('', '/dashboard')).toBe('/dashboard');
});

test('buildInstancePath re-targets an already-instance-prefixed path at the new instance id', () => {
  expect(buildInstancePath('inst-2', '/instances/inst-1/sessions/s1')).toBe('/instances/inst-2/sessions/s1');
});

test('buildInstancePath returns an already-instance-prefixed path unchanged if it fails to parse', () => {
  // extractInstanceRoute requires at least a non-empty id segment; an
  // /instances/ path with nothing after it doesn't match the regex.
  expect(buildInstancePath('inst-2', '/instances/')).toBe('/instances/');
});

// ── getCurrentInstanceIdFromPathname ────────────────────────────────────────

test('getCurrentInstanceIdFromPathname extracts the id from an instance path', () => {
  expect(getCurrentInstanceIdFromPathname('/instances/inst-1/dashboard')).toBe('inst-1');
});

test('getCurrentInstanceIdFromPathname returns null for a non-instance path', () => {
  expect(getCurrentInstanceIdFromPathname('/dashboard')).toBeNull();
});

test('getCurrentInstanceIdFromPathname returns null for null/undefined input', () => {
  expect(getCurrentInstanceIdFromPathname(null)).toBeNull();
  expect(getCurrentInstanceIdFromPathname(undefined)).toBeNull();
});

// ── window/document-guarded functions (non-browser branch) ─────────────────

test('getCurrentInstanceIdFromWindow returns null when window is undefined (non-browser host)', () => {
  expect(typeof window).toBe('undefined');
  expect(getCurrentInstanceIdFromWindow()).toBeNull();
});

test('getActiveInstanceIdFromCookie returns null when document is undefined (non-browser host)', () => {
  expect(typeof document).toBe('undefined');
  expect(getActiveInstanceIdFromCookie()).toBeNull();
});

test('setActiveInstanceCookie is a no-op (never throws) when document is undefined', () => {
  expect(() => setActiveInstanceCookie('inst-1')).not.toThrow();
  expect(() => setActiveInstanceCookie(null)).not.toThrow();
  expect(() => setActiveInstanceCookie()).not.toThrow();
});

// ── toInstanceAwarePath ──────────────────────────────────────────────────────

test('toInstanceAwarePath prefixes when an instanceId is given', () => {
  expect(toInstanceAwarePath('/dashboard', 'inst-1')).toBe('/instances/inst-1/dashboard');
});

test('toInstanceAwarePath returns the pathname unchanged when instanceId is falsy', () => {
  expect(toInstanceAwarePath('/dashboard', null)).toBe('/dashboard');
  expect(toInstanceAwarePath('/dashboard', undefined)).toBe('/dashboard');
  expect(toInstanceAwarePath('/dashboard', '')).toBe('/dashboard');
});

// ── normalizeAppPathname ─────────────────────────────────────────────────────

test('normalizeAppPathname strips the instance prefix, defaulting to /dashboard for a bare instance path', () => {
  expect(normalizeAppPathname('/instances/inst-1')).toBe('/dashboard');
});

test('normalizeAppPathname strips the instance prefix, keeping a nested inner path', () => {
  expect(normalizeAppPathname('/instances/inst-1/sessions/s1')).toBe('/sessions/s1');
});

test('normalizeAppPathname leaves a non-instance path untouched', () => {
  expect(normalizeAppPathname('/dashboard')).toBe('/dashboard');
});
