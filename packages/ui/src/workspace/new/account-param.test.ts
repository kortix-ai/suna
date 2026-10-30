/**
 * `/new?account=` — the destination after creating an account.
 *
 * The landing door cannot serve that flow: it opens the first project found in
 * ANY account, so a brand-new empty account falls through to a different
 * account's project and `projects/start/page.tsx` heals the persisted selection
 * to THAT account. These cases pin the param that keeps the new account
 * selected instead.
 */

import { describe, expect, test } from 'bun:test';

import { newWorkspacePathForAccount, readAccountParam } from './account-param';

const ACCOUNT = '295a434d-410f-49f0-a305-7790f3efe640';

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe('readAccountParam', () => {
  test('reads a uuid account id', () => {
    expect(readAccountParam(params(`account=${ACCOUNT}`))).toBe(ACCOUNT);
  });

  test('trims surrounding whitespace', () => {
    expect(readAccountParam(params(`account=%20${ACCOUNT}%20`))).toBe(ACCOUNT);
  });

  test('absent, empty and whitespace-only all read as null', () => {
    expect(readAccountParam(params(''))).toBeNull();
    expect(readAccountParam(params('account='))).toBeNull();
    expect(readAccountParam(params('account=%20%20'))).toBeNull();
  });

  test('a value that is not a uuid is rejected rather than passed through', () => {
    // The picker renders an id it cannot find as "Choose an account", so a
    // rejected value degrades to the ordinary unpicked state. Shape is still
    // checked here so nothing but a uuid reaches the form at all.
    expect(readAccountParam(params('account=not-an-id'))).toBeNull();
    expect(readAccountParam(params('account=../../etc/passwd'))).toBeNull();
    expect(readAccountParam(params(`account=${ACCOUNT}x`))).toBeNull();
  });
});

describe('newWorkspacePathForAccount', () => {
  test('scopes /new to one account', () => {
    expect(newWorkspacePathForAccount(ACCOUNT)).toBe(`/new?account=${ACCOUNT}`);
  });

  test('round-trips through readAccountParam', () => {
    const path = newWorkspacePathForAccount(ACCOUNT);
    const query = path.slice(path.indexOf('?') + 1);
    expect(readAccountParam(params(query))).toBe(ACCOUNT);
  });
});
