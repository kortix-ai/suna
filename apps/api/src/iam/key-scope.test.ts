/**
 * Workspace key scopes: a permission decision (design.md §3.2 C4a). A key does
 * what its scope allows, inside its creator's role; the role half is the
 * engine's, tested over HTTP in WS-AUTH-10.
 */
import { describe, expect, test } from 'bun:test';
import {
  keyScopeAllows,
  keyScopeIsReadOnly,
  keyScopeMethodAllows,
  keyScopeWithin,
  keyScopeWire,
  parseKeyScopesInput,
  readKeyScopes,
} from './key-scope';

const READ = { preset: 'read' as const };

describe('keyScopeAllows', () => {
  test('full (null) allows every action', () => {
    expect(keyScopeAllows(null, 'member.remove')).toBe(true);
    expect(keyScopeAllows(null, 'workspace.delete')).toBe(true);
  });

  test('read allows every *.read action in either spelling, and nothing else', () => {
    expect(keyScopeAllows(READ, 'project.session.read')).toBe(true);
    expect(keyScopeAllows(READ, 'workspace.session.read')).toBe(true);
    expect(keyScopeAllows(READ, 'member.read')).toBe(true);
    expect(keyScopeAllows(READ, 'workspace.member.read')).toBe(true);
    expect(keyScopeAllows(READ, 'project.session.start')).toBe(false);
    expect(keyScopeAllows(READ, 'member.remove')).toBe(false);
    expect(keyScopeAllows(READ, 'project.write')).toBe(false);
    expect(keyScopeAllows(READ, 'capture.read_all')).toBe(false);
  });

  test('custom allows exactly its list, in either spelling, plus the workspace read gate', () => {
    const custom = { permissions: ['project.session.start'] };
    expect(keyScopeAllows(custom, 'project.session.start')).toBe(true);
    expect(keyScopeAllows(custom, 'workspace.session.start')).toBe(true);
    expect(keyScopeAllows(custom, 'project.read')).toBe(true);
    expect(keyScopeAllows(custom, 'workspace.read')).toBe(true);
    expect(keyScopeAllows(custom, 'project.session.read')).toBe(false);
    expect(keyScopeAllows(custom, 'project.session.stop')).toBe(false);
  });
});

describe('readKeyScopes', () => {
  test('a malformed stored value fails closed, never to full', () => {
    expect(readKeyScopes({ preset: 'admin' })).toEqual({ permissions: [] });
    expect(readKeyScopes('read')).toEqual({ permissions: [] });
    expect(keyScopeAllows(readKeyScopes(42), 'member.remove')).toBe(false);
  });
  test('null stays full; workspace names are stored in the legacy spelling', () => {
    expect(readKeyScopes(null)).toBeNull();
    expect(readKeyScopes({ permissions: ['workspace.session.start'] })).toEqual({ permissions: ['project.session.start'] });
  });
});

describe('read-only by method', () => {
  test('a read key and an all-read custom key reach only GET, HEAD, OPTIONS', () => {
    for (const s of [READ, { permissions: ['project.session.read', 'member.read'] }]) {
      expect(keyScopeIsReadOnly(s)).toBe(true);
      expect(keyScopeMethodAllows(s, 'GET')).toBe(true);
      expect(keyScopeMethodAllows(s, 'head')).toBe(true);
      expect(keyScopeMethodAllows(s, 'POST')).toBe(false);
      expect(keyScopeMethodAllows(s, 'DELETE')).toBe(false);
    }
  });
  test('a full key and a custom key with a write reach every method', () => {
    expect(keyScopeMethodAllows(null, 'DELETE')).toBe(true);
    expect(keyScopeMethodAllows({ permissions: ['project.session.read', 'project.session.start'] }, 'POST')).toBe(true);
  });
});

describe('keyScopeWithin (a scoped key mints only inside its scope)', () => {
  test('a full parent mints anything', () => {
    expect(keyScopeWithin(null, null)).toBe(true);
    expect(keyScopeWithin(READ, null)).toBe(true);
  });
  test('a scoped parent never mints a full key', () => {
    expect(keyScopeWithin(null, READ)).toBe(false);
    expect(keyScopeWithin(null, { permissions: ['token.create'] })).toBe(false);
  });
  test('a read parent mints read and all-read custom keys only', () => {
    expect(keyScopeWithin(READ, READ)).toBe(true);
    expect(keyScopeWithin({ permissions: ['member.read'] }, READ)).toBe(true);
    expect(keyScopeWithin({ permissions: ['member.remove'] }, READ)).toBe(false);
  });
  test('a custom parent mints a subset of its list only', () => {
    const parent = { permissions: ['token.create', 'project.session.start'] };
    expect(keyScopeWithin({ permissions: ['project.session.start'] }, parent)).toBe(true);
    expect(keyScopeWithin({ permissions: ['project.session.stop'] }, parent)).toBe(false);
    expect(keyScopeWithin(READ, parent)).toBe(false);
  });
});

describe('parseKeyScopesInput', () => {
  test('absent is not a choice; full and read are presets', () => {
    expect(parseKeyScopesInput(undefined)).toEqual({ ok: true, scopes: null, explicit: false });
    expect(parseKeyScopesInput('full')).toEqual({ ok: true, scopes: null, explicit: true });
    expect(parseKeyScopesInput('read')).toEqual({ ok: true, scopes: READ, explicit: true });
  });
  test('a list is deduplicated, sorted and stored in the legacy spelling', () => {
    expect(parseKeyScopesInput(['workspace.session.start', 'project.session.read', 'project.session.start'])).toEqual({
      ok: true,
      scopes: { permissions: ['project.session.read', 'project.session.start'] },
      explicit: true,
    });
  });
  test('an unknown name, an empty list or another shape is refused', () => {
    const unknown = parseKeyScopesInput(['project.session.read', 'project.nope']);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain('"project.nope"');
    expect(parseKeyScopesInput([]).ok).toBe(false);
    expect(parseKeyScopesInput('admin').ok).toBe(false);
    expect(parseKeyScopesInput({ preset: 'read' }).ok).toBe(false);
  });
});

test('keyScopeWire names the scope and both spellings of a custom list', () => {
  expect(keyScopeWire(null)).toEqual({ scope: 'full', permissions: null, workspace_permissions: null });
  expect(keyScopeWire(READ)).toEqual({ scope: 'read', permissions: null, workspace_permissions: null });
  expect(keyScopeWire({ permissions: ['project.session.start'] })).toEqual({
    scope: 'custom',
    permissions: ['project.session.start'],
    workspace_permissions: ['workspace.session.start'],
  });
});
