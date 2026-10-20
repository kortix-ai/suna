import { useAccountPanelStore } from '@kortix/ui/internal/stores/account-panel-store';
import { useCurrentAccountStore } from '@kortix/ui/internal/stores/current-account-store';
import type { KortixAccount } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
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

  for (const host of ['sidebar', 'hub'] as const) {
    test(`${host} executes selection and modal cleanup before its navigation`, async () => {
      const events: unknown[] = [];
      const key = ['accounts', 'synthetic-host-reader'];
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      // Observe real store transitions, not replacement implementations of the handoff.
      useCurrentAccountStore.setState({ selectedAccountId: null });
      useAccountPanelStore.getState().setPushedEntry(true);
      const stopSelection = useCurrentAccountStore.subscribe((state, previous) => {
        if (state.selectedAccountId !== previous.selectedAccountId) {
          events.push(['select', state.selectedAccountId]);
        }
      });
      const stopPanel = useAccountPanelStore.subscribe((state, previous) => {
        if (state.pushedEntry !== previous.pushedEntry) events.push(['modal', state.pushedEntry]);
      });
      const navigate = (method: string) => (path: string) => {
        events.push([method, path]);
        expect(client.getQueryData<KortixAccount[]>(key)).toEqual([account('created')]);
        expect(useCurrentAccountStore.getState().selectedAccountId).toBe('created');
        expect(useAccountPanelStore.getState().pushedEntry).toBe(host === 'sidebar');
      };
      mock.module('@kortix/ui/internal/lib/use-project-can', () => ({
        useProjectCan: () => ({ allowed: false }),
      }));
      mock.module('next/navigation', () => ({
        useRouter: () => ({
          push: navigate('push'),
          replace: navigate('replace'),
        }),
      }));
      mock.module('@kortix/ui/internal/hooks/account/use-accounts-list', () => ({
        useAccountsQueryKey: () => key,
        useAccountsList: () => ({ data: [], isLoading: false, isError: false }),
      }));
      mock.module('@/hooks/account/use-ensure-selected-account', () => ({
        useEnsureSelectedAccount() {},
      }));
      mock.module('@kortix/ui/internal/hooks/admin/use-admin-role', () => ({ useAdminRole: () => ({ data: null }) }));
      mock.module('@/features/providers/auth-provider', () => ({
        useAuth: () => ({ user: { id: 'synthetic-reader' }, isLoading: false }),
      }));
      mock.module('@/lib/auth/use-signed-out-redirect', () => ({ useSignedOutRedirect() {} }));
      mock.module('@/lib/config', () => ({ isAccountCreationRestricted: () => false }));
      mock.module('@/i18n/use-translations', () => ({
        useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
      }));
      const children = ({ children }: { children?: ReactNode }) =>
        createElement('div', null, children);
      const realDropdownMenu = await import('@kortix/ui/dropdown-menu');
      const uiDropdownMenuMock = () => ({
        ...realDropdownMenu,
        ...Object.fromEntries(
          [
            'DropdownMenu',
            'DropdownMenuContent',
            'DropdownMenuItem',
            'DropdownMenuLabel',
            'DropdownMenuPortal',
            'DropdownMenuSeparator',
            'DropdownMenuShortcut',
            'DropdownMenuSub',
            'DropdownMenuSubContent',
            'DropdownMenuSubTrigger',
            'DropdownMenuTrigger',
          ].map((name) => [name, children]),
        ),
      });
      mock.module('@kortix/ui/dropdown-menu', uiDropdownMenuMock);
      mock.module('@kortix/ui/dropdown-menu', uiDropdownMenuMock);
      const { createContext } = await import('react');
      const uiSidebarMock = () => ({
        SidebarContext: createContext(null),
        SidebarMenu: children,
        SidebarMenuButton: children,
        SidebarMenuItem: children,
      });
      mock.module('@kortix/ui/sidebar', uiSidebarMock);
      mock.module('@kortix/ui/sidebar', uiSidebarMock);
      mock.module('@/features/layout/user-menu-shared', () => ({
        HelpSubmenu: () => null,
        ThemeSubmenu: () => null,
        useLogoutFlow: () => ({ openConfirm() {}, dialog: null }),
      }));
      mock.module('@kortix/ui/internal/tunnel/computer-connect', () => ({
        COMPUTER_SETUP_EVENT: 'synthetic-setup',
      }));
      mock.module('@/features/tunnel/local-computer-modal', () => ({
        LocalComputerModal: () => null,
      }));
      mock.module('@kortix/ui/workspace/sidebar/workspace-menu-section', () => ({
        WorkspaceMenuSection: () => null,
      }));
      mock.module('./hub/account-pane', () => ({ AccountPane: children }));
      mock.module('@kortix/ui/internal/account-hub/account-hub-location', () => ({ HubLink: children }));
      // The child is an external creation boundary. Execute the real host's callback.
      function CreationBoundary(_props: { onCreated: (value: KortixAccount) => void }) {
        return null;
      }
      mock.module('./create-account-modal', () => ({ CreateAccountModal: CreationBoundary }));
      const originalWindow = globalThis.window;
      // The sidebar host registers a window event listener in an effect. A
      // real happy-dom window replaces the global — the same cast-free
      // fixture apps-feature-gate.test.ts installs.
      Object.assign(globalThis, { window: new Window() });
      let renderer: ReactTestRenderer | undefined;
      try {
        const Host =
          host === 'sidebar'
            ? (await import('../workspace/project-sidebar/workspace-switcher')).WorkspaceSwitcher
            : (await import('./hub/account-list-content')).AccountListContent;
        await act(async () => {
          renderer = create(
            createElement(QueryClientProvider, { client }, createElement(Host, { projectId: '' })),
          );
        });
        await act(async () => {
          renderer!.root.findByType(CreationBoundary).props.onCreated(account('created'));
        });
        expect(events).toEqual(
          host === 'sidebar'
            ? [
                ['select', 'created'],
                ['push', '/new?account=created'],
              ]
            : [
                ['select', 'created'],
                ['modal', false],
                ['replace', '/new?account=created'],
              ],
        );
      } finally {
        if (renderer) await act(async () => renderer!.unmount());
        Object.assign(globalThis, { window: originalWindow });
        stopSelection();
        stopPanel();
        client.clear();
      }
    });
  }
});
