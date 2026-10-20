import { qk } from '@kortix/sdk/react';
import { PROJECT_ACTIONS } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { createElement, type ReactNode } from 'react';
import { act, create } from 'react-test-renderer';
let allowed: boolean | undefined = true;
mock.module('@kortix/ui/internal/lib/use-project-can', () => ({
  useProjectCan: (_id: string, action: string) => ({
    allowed: action === PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE ? allowed : false,
  }),
}));
mock.module('next/navigation', () => ({
  useRouter: () => ({ push() {}, replace() {} }),
}));
mock.module('@/hooks/account/use-accounts-list', () => ({
  useAccountsQueryKey: () => ['accounts'],
  useAccountsList: () => ({ data: [], isLoading: false, isError: false }),
}));
mock.module('@/hooks/account/use-ensure-selected-account', () => ({
  useEnsureSelectedAccount() {},
}));
mock.module('@/hooks/admin/use-admin-role', () => ({ useAdminRole: () => ({ data: null }) }));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'synthetic-reader' }, isLoading: false }),
}));
mock.module('@/lib/auth/use-signed-out-redirect', () => ({ useSignedOutRedirect() {} }));
mock.module('@/lib/config', () => ({ isAccountCreationRestricted: () => false }));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => Object.assign((key: string) => key, { raw: (key: string) => key }),
}));
const children = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
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
mock.module('@/components/ui/dropdown-menu', uiDropdownMenuMock);
mock.module('@kortix/ui/dropdown-menu', uiDropdownMenuMock);
const { createContext } = await import('react');
const realSidebar = await import('@kortix/ui/sidebar');
const uiSidebarMock = () => ({
  ...realSidebar,
  SidebarContext: createContext(null),
  SidebarMenu: children,
  SidebarMenuButton: children,
  SidebarMenuItem: children,
});
mock.module('@/components/ui/sidebar', uiSidebarMock);
mock.module('@kortix/ui/sidebar', uiSidebarMock);
mock.module('@/features/layout/user-menu-shared', () => ({
  HelpSubmenu: () => null,
  ThemeSubmenu: () => null,
  useLogoutFlow: () => ({ openConfirm() {}, dialog: null }),
}));
mock.module('@/features/tunnel/computer-connect', () => ({
  COMPUTER_SETUP_EVENT: 'synthetic-setup',
}));
mock.module('@/features/tunnel/local-computer-modal', () => ({
  LocalComputerModal: () => null,
}));
mock.module('@/features/workspace/project-sidebar/workspace-menu-section', () => ({
  WorkspaceMenuSection: () => null,
}));

mock.module('@/features/accounts/create-account-modal', () => ({ CreateAccountModal: () => null }));
const { WorkspaceSwitcher } = await import('./workspace-switcher');
Object.assign(globalThis, { window: new Window(), IS_REACT_ACT_ENVIRONMENT: true });
for (const permission of [true, false, undefined]) {
  test(`Rename shortcut follows settings-write permission: ${permission}`, async () => {
    allowed = permission;
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    client.setQueryData(qk.project.summary('synthetic-project'), {
      project_id: 'synthetic-project',
      name: 'Sample',
    });
    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(
        createElement(
          QueryClientProvider,
          { client },
          createElement(WorkspaceSwitcher, { projectId: 'synthetic-project' }),
        ),
      );
    });
    if (!renderer) throw new Error('switcher did not mount');
    const mounted = renderer;
    try {
      const links = mounted.root.findAll(
        (node) => node.props.href === '/projects/synthetic-project/customize/settings',
      );
      expect(links.length > 0).toBe(permission === true);
      if (permission === true)
        expect(
          links.some((node) =>
            node.props.children?.some?.((child: unknown) => child === 'text3064d79a295c'),
          ),
        ).toBe(true);
    } finally {
      await act(async () => mounted.unmount());
      client.clear();
    }
  });
}
