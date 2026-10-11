import { describe, expect, test } from 'bun:test';

import { connectorNotice, splitNoticeReason } from './connector-notice';

const base = {
  provider: 'mcp' as const,
  status: 'active' as const,
  lastError: null,
  connected: false,
  hasAuth: true,
  credentialSet: false,
  managed: false,
  accountCount: 0,
  accountsLoaded: true,
};

describe('connectorNotice', () => {
  test('a connected connector says nothing', () => {
    expect(connectorNotice({ ...base, connected: true, credentialSet: true })).toEqual({
      kind: 'none',
    });
  });

  test('nothing is claimed before the accounts have loaded', () => {
    expect(connectorNotice({ ...base, accountsLoaded: false })).toEqual({ kind: 'none' });
  });

  test('channels and computers have their own connect surface', () => {
    expect(connectorNotice({ ...base, provider: 'channel' })).toEqual({ kind: 'none' });
    expect(connectorNotice({ ...base, provider: 'computer' })).toEqual({ kind: 'none' });
  });

  test('no account yet: add one', () => {
    expect(connectorNotice(base)).toEqual({ kind: 'no_account', action: 'add_account' });
  });

  test('a direct account with no credential: set it', () => {
    expect(connectorNotice({ ...base, accountCount: 1 })).toEqual({
      kind: 'needs_credential',
      action: 'set_credential',
    });
  });

  test('a managed account that is not authorized: reconnect it on its row', () => {
    expect(connectorNotice({ ...base, managed: true, accountCount: 1 })).toEqual({
      kind: 'needs_credential',
      action: 'open_accounts',
    });
  });

  test('an error carries the reason the server stored', () => {
    expect(
      connectorNotice({
        ...base,
        provider: 'openapi',
        status: 'error',
        lastError: '  401 Unauthorized  ',
        accountCount: 1,
      }),
    ).toEqual({ kind: 'error', reason: '401 Unauthorized', action: 'set_credential' });
  });

  test('an error with no account points at adding one', () => {
    expect(connectorNotice({ ...base, status: 'error' })).toEqual({
      kind: 'error',
      reason: null,
      action: 'add_account',
    });
  });

  test('an error with a credential in place offers a retry', () => {
    expect(
      connectorNotice({ ...base, status: 'error', credentialSet: true, accountCount: 1 }),
    ).toEqual({ kind: 'error', reason: null, action: 'retry' });
  });

  test('an error on a connector that needs no credential offers a retry', () => {
    expect(connectorNotice({ ...base, status: 'error', hasAuth: false })).toEqual({
      kind: 'error',
      reason: null,
      action: 'retry',
    });
  });
});

describe('splitNoticeReason', () => {
  test('pulls the HTTP status out of the failure line', () => {
    expect(splitNoticeReason('MCP tools/list failed: HTTP 401')).toEqual({
      code: '401',
      detail: 'MCP tools/list failed',
    });
  });

  test('keeps a reason with no HTTP status whole', () => {
    expect(splitNoticeReason('connect ECONNREFUSED')).toEqual({
      code: null,
      detail: 'connect ECONNREFUSED',
    });
  });
});

describe('connectorNotice: MCP sign-in still to do', () => {
  test('a 401 from an MCP server asks for sign-in, not a retry', () => {
    expect(
      connectorNotice({
        ...base,
        status: 'error',
        lastError: 'MCP tools/list failed: HTTP 401',
        hasAuth: false,
        accountCount: 1,
      }),
    ).toEqual({ kind: 'sign_in' });
  });
});
