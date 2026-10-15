import type { KortixAccount } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { QueryClient, type QueryKey } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { accountCreated } from './account-created';

const account = (id: string, name = id) => ({ account_id: id, name }) as KortixAccount;

describe('account creation handoff', () => {
  test('seeds only the supplied reader slot, selects, invalidates both scopes, then navigates', () => {
    const client = new QueryClient();
    const key = ['accounts', 'synthetic-reader'];
    const other = ['accounts', 'other-reader'];
    const calls: unknown[] = [];
    client.setQueryData<KortixAccount[]>(other, [account('other')]);
    client.invalidateQueries = (options?: { queryKey?: QueryKey }) => {
      calls.push(options?.queryKey);
      return Promise.resolve();
    };
    accountCreated(
      account('created'),
      client,
      key,
      (id) => calls.push(['select', id]),
      (path) => calls.push(['navigate', path]),
    );
    expect(client.getQueryData<KortixAccount[]>(key)).toEqual([account('created')]);
    expect(client.getQueryData<KortixAccount[]>(other)).toEqual([account('other')]);
    expect(calls).toEqual([
      qk.accounts.scope(),
      ['select', 'created'],
      qk.projects.scope(),
      ['navigate', '/new?account=created'],
    ]);
  });

  test('prepends new accounts and replaces an existing account without duplicates or reordering', () => {
    const client = new QueryClient();
    const key = ['synthetic-slot'];
    client.setQueryData<KortixAccount[]>(key, [account('first'), account('second')]);
    accountCreated(
      account('third'),
      client,
      key,
      () => {},
      () => {},
    );
    accountCreated(
      account('second', 'updated'),
      client,
      key,
      () => {},
      () => {},
    );
    expect(client.getQueryData<KortixAccount[]>(key)).toEqual([
      account('third'),
      account('first'),
      account('second', 'updated'),
    ]);
  });

  test('sidebar pushes while hub forgets the modal entry before replacing', () => {
    const sidebar = readFileSync(
      `${import.meta.dir}/../workspace/project-sidebar/workspace-switcher.tsx`,
      'utf8',
    );
    const hub = readFileSync(`${import.meta.dir}/hub/account-list-content.tsx`, 'utf8');
    for (const source of [sidebar, hub]) {
      expect(source).toContain(
        'accountCreated(account, queryClient, accountsQueryKey, setSelectedAccountId',
      );
    }
    expect(sidebar).toContain('router.push(path)');
    expect(sidebar).not.toContain('forgetPushedEntry');
    expect(hub).toMatch(/forgetPushedEntry\(\);\s*router.replace\(path\)/);
  });
});
