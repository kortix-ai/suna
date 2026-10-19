import { describe, expect, test } from 'bun:test';

import { connectorNotice, noticeButton, noticeTarget, splitNoticeReason } from './connector-notice';

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

  test('with no account yet, a 401 on a connector with an auth scheme still asks for sign-in', () => {
    const unsigned = {
      ...base,
      status: 'error' as const,
      lastError: 'MCP tools/list failed: HTTP 401',
      accountCount: 0,
    };
    expect(connectorNotice(unsigned)).toEqual({ kind: 'sign_in' });
    expect(noticeButton(connectorNotice(unsigned), noticeTarget([]), false)).toEqual({
      kind: 'sign_in',
      run: 'add',
      account: null,
    });
    // No auth scheme and no account: the 401 is the failure.
    expect(connectorNotice({ ...unsigned, hasAuth: false }).kind).toBe('error');
  });
});

describe('noticeTarget: the account the banner button fixes', () => {
  const project = { owner_type: 'project', status: 'active', authorized: false };
  const mine = { owner_type: 'member', status: 'active', authorized: false };

  test('no account of your own: Add account, never the empty project account', () => {
    expect(noticeTarget([project])).toBe('add');
    expect(noticeTarget([])).toBe('add');
  });

  test('your own unsigned account comes before a project account listed first', () => {
    expect(noticeTarget([project, mine])).toBe(mine);
  });

  test('your only account is the target even when it reads signed in', () => {
    const signed = { ...mine, authorized: true };
    expect(noticeTarget([project, signed])).toBe(signed);
  });

  test('an account of yours in error counts as not signed in', () => {
    const work = { ...mine, authorized: true };
    const broken = { ...mine, authorized: true, status: 'error' };
    expect(noticeTarget([work, broken])).toBe(broken);
  });

  test('several signed-in accounts of your own: no single target', () => {
    const work = { ...mine, authorized: true };
    const personal = { ...mine, authorized: true };
    expect(noticeTarget([work, personal])).toBeNull();
  });
});

describe('noticeButton: what the banner button says and runs', () => {
  const mine = { connection_id: 'mine-1' };
  const signIn = { kind: 'sign_in' } as const;
  const setCredential = { kind: 'needs_credential', action: 'set_credential' } as const;
  const reconnect = { kind: 'needs_credential', action: 'open_accounts' } as const;

  test('no notice, no button', () => {
    expect(noticeButton({ kind: 'none' }, 'add', false)).toBeNull();
  });

  test('sign-in with no account of your own opens Add account', () => {
    expect(noticeButton(signIn, 'add', false)).toEqual({
      kind: 'sign_in',
      run: 'add',
      account: null,
    });
  });

  test('sign-in on your own account signs that account in', () => {
    expect(noticeButton(signIn, mine, false)).toEqual({
      kind: 'sign_in',
      run: 'sign_in',
      account: mine,
    });
  });

  test('sign-in with several signed-in accounts of your own has no button', () => {
    expect(noticeButton(signIn, null, false)).toBeNull();
  });

  test('no account yet: the Add account control', () => {
    expect(noticeButton({ kind: 'no_account', action: 'add_account' }, 'add', false)).toEqual({
      kind: 'add_account',
      run: 'add',
      account: null,
    });
    expect(
      noticeButton({ kind: 'error', reason: null, action: 'add_account' }, mine, false),
    ).toEqual({ kind: 'add_account', run: 'add', account: null });
  });

  test('a credential to set with no account of your own opens Add account', () => {
    expect(noticeButton(setCredential, 'add', false)).toEqual({
      kind: 'set_credential',
      run: 'add',
      account: null,
    });
  });

  test('a credential to set on your own account opens its credential entry', () => {
    expect(noticeButton(setCredential, mine, false)).toEqual({
      kind: 'set_credential',
      run: 'reconnect',
      account: mine,
    });
  });

  test('a managed provider says Connect with no account, Reconnect on yours', () => {
    expect(noticeButton(reconnect, 'add', true)).toEqual({
      kind: 'connect',
      run: 'add',
      account: null,
    });
    expect(noticeButton(reconnect, mine, true)).toEqual({
      kind: 'reconnect',
      run: 'reconnect',
      account: mine,
    });
  });

  test('a failure only Retry fixes has no fix button', () => {
    expect(
      noticeButton({ kind: 'error', reason: 'HTTP 500', action: 'retry' }, 'add', false),
    ).toBeNull();
  });

  test('no single account of yours to fix: no button', () => {
    expect(noticeButton(setCredential, null, false)).toBeNull();
  });
});
