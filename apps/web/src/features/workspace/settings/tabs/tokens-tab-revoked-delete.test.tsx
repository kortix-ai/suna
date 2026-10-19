/**
 * KRTX-2656: a revoked personal API key lingered on the pane with no way to
 * remove it — the detail dialog offered only Close and the list row had no
 * ⋯ at all, while the cleanup journey (`proj-delete-account-cleanup`) needs
 * the row gone. The API has supported deleting a dead personal key all along
 * (`DELETE /accounts/tokens/:id?delete_revoked=true`, own key +
 * `token.personal.revoke`); the pane just never offered it.
 *
 * This pins the wiring: a revoked row's ⋯ offers Delete (an active row's does
 * not — it offers Revoke), the detail dialog of a revoked row offers it too,
 * and confirming deletes through the SDK with `deleteRevoked: true`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realReactQuery from '@tanstack/react-query';
// A dynamic import: the restricted-import lint rule forbids a namespace import
// of the SDK root, and the mock below must spread the real module.
const realSdk = await import('@kortix/sdk');
import { createElement, Fragment, type ReactNode } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const ACCOUNT = '00000000-0000-4000-8000-000000000001';

const token = (overrides: Record<string, unknown>) => ({
  token_id: 'tok-revoked',
  name: 'old laptop',
  project_id: null,
  public_key: 'pk_synthetic0000000000000000000000',
  status: 'active',
  expires_at: null,
  last_used_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
  revoked_at: null,
  ...overrides,
});

const REVOKED = token({ token_id: 'tok-revoked', name: 'old laptop', status: 'revoked', revoked_at: '2026-10-02T00:00:00.000Z' });
const ACTIVE = token({ token_id: 'tok-active', name: 'my laptop' });

let listCalls = 0;
const revokeCalls: { tokenId: string; accountId: string | undefined; deleteRevoked: boolean }[] = [];

mock.module('@kortix/sdk', () => ({
  ...realSdk,
  listAccountTokens: async () => {
    listCalls += 1;
    return [REVOKED, ACTIVE];
  },
  listProjectsForAccount: async () => [],
  revokeAccountToken: (tokenId: string, accountId?: string, opts?: { deleteRevoked?: boolean }) => {
    revokeCalls.push({ tokenId, accountId, deleteRevoked: opts?.deleteRevoked === true });
    return { ok: true };
  },
}));

mock.module('@/lib/iam-client', () => ({
  getPatPolicy: async () => null,
}));

mock.module('@kortix/ui/internal/lib/use-permission', () => ({
  usePermission: () => ({ allowed: true, isLoading: false }),
}));

const uiToastMock = () => ({
  successToast: () => {},
  errorToast: () => {},
});
mock.module('@/components/ui/toast', uiToastMock);
mock.module('@kortix/ui/toast', uiToastMock);

// The real Modal and ConfirmDialog are Radix portals; the wiring under test is
// which action a row offers and what confirming calls. Keep both assertable.
const uiModalMock = () => ({
  Modal: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? createElement('div', null, children) : null,
  ModalBody: Pass,
  ModalContent: Pass,
  ModalDescription: Pass,
  ModalFooter: Pass,
  ModalHeader: Pass,
  ModalTitle: Pass,
});
mock.module('@/components/ui/modal', uiModalMock);
mock.module('@kortix/ui/modal', uiModalMock);
const uiConfirmDialogMock = () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
    confirmLabel,
  }: {
    open?: boolean;
    onConfirm?: () => void;
    confirmLabel?: string;
  }) =>
    open
      ? createElement('button', { onClick: onConfirm, 'data-testid': 'confirm-action' }, confirmLabel ?? 'confirm')
      : null,
});
mock.module('@/components/ui/confirm-dialog', uiConfirmDialogMock);
mock.module('@kortix/ui/confirm-dialog', uiConfirmDialogMock);

function makeKebab() {
  const Kebab = (props: { items: unknown[]; label?: string }) => null;
  return Kebab;
}
const RowKebabMock = makeKebab();
mock.module('@kortix/ui/access/access/access-row', () => ({ RowKebab: RowKebabMock }));
mock.module('@kortix/ui/access/access/index', () => ({ CopyRow: Pass }));

mock.module('@kortix/ui/customize/settings/tabs/connected-apps', () => ({ ConnectedApps: () => null }));
mock.module('@kortix/ui/customize/settings/settings-tab-header', () => ({ SettingsTabHeader: () => null }));
mock.module('@kortix/ui/internal/account-hub/account-hub-location', () => ({
  HubLink: ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children),
}));

const translate = (key: string) => key.split('.').pop() || key;
mock.module('@/i18n/use-translations', () => ({
  useLocale: () => 'en',
  useTranslations: () =>
    Object.assign((key: string) => translate(key), {
      raw: translate,
      rich: (key: string) => translate(key),
    }),
}));

const { TokensTab } = await import('./tokens-tab');

function Pass({ children }: { children?: ReactNode }) {
  return createElement(Fragment, null, children);
}

beforeEach(() => {
  listCalls = 0;
  revokeCalls.length = 0;
});

describe('TokensTab — a revoked key can be deleted', () => {
  test('a revoked row offers Delete; an active row offers Revoke, not Delete', async () => {
    const client = new realReactQuery.QueryClient({ defaultOptions: { queries: { retry: false } } });
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(
        createElement(realReactQuery.QueryClientProvider, { client }, createElement(TokensTab, { accountId: ACCOUNT })),
      );
    });
    if (!root) throw new Error('TokensTab did not render');
    try {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      const kebabs = root.root.findAllByType(RowKebabMock) as unknown as { props: { items: { label: string }[] } }[];
      expect(kebabs).toHaveLength(2);
      const items = kebabs.map((k) => k.props!.items.map((i) => i.label).sort());
      expect(items).toContainEqual(['revokeKey']); // active row
      expect(items).toContainEqual(['deleteKey']); // revoked row
    } finally {
      await act(async () => root!.unmount());
    }
  });

  test('confirming the delete calls the SDK with deleteRevoked and refetches the list', async () => {
    const client = new realReactQuery.QueryClient({ defaultOptions: { queries: { retry: false } } });
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(
        createElement(realReactQuery.QueryClientProvider, { client }, createElement(TokensTab, { accountId: ACCOUNT })),
      );
    });
    if (!root) throw new Error('TokensTab did not render');
    try {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(listCalls).toBe(1);
      const kebabs = root.root.findAllByType(RowKebabMock) as unknown as {
        props: { items: { label: string; onSelect: () => void }[] };
      }[];
      const deleteItem = kebabs
        .flatMap((k) => k.props!.items)
        .find((i) => i.label === 'deleteKey');
      expect(deleteItem).toBeDefined();
      await act(async () => {
        deleteItem!.onSelect();
      });
      const confirm = root.root.findByProps({ 'data-testid': 'confirm-action' });
      await act(async () => {
        confirm.props.onClick();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(revokeCalls).toEqual([
        { tokenId: 'tok-revoked', accountId: ACCOUNT, deleteRevoked: true },
      ]);
      // The list was invalidated: the pane refetched the keys after the delete.
      expect(listCalls).toBeGreaterThan(1);
    } finally {
      await act(async () => root!.unmount());
    }
  });

  test('the detail dialog of a revoked row offers Delete too', async () => {
    const client = new realReactQuery.QueryClient({ defaultOptions: { queries: { retry: false } } });
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(
        createElement(realReactQuery.QueryClientProvider, { client }, createElement(TokensTab, { accountId: ACCOUNT })),
      );
    });
    if (!root) throw new Error('TokensTab did not render');
    try {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      // The whole row is a button labelled with the key's name.
      const rowButton = root.root.findByProps({ 'aria-label': 'old laptop' });
      await act(async () => {
        rowButton.props.onClick();
      });
      const kebabsAfter = root.root.findAllByType(RowKebabMock) as unknown as {
        props: { items: { label: string }[] };
      }[];
      // Two list rows + the detail modal's own ⋯.
      expect(kebabsAfter).toHaveLength(3);
      const detailItems = kebabsAfter[2]!.props!.items.map((i) => i.label);
      expect(detailItems).toContain('deleteKey');
      expect(detailItems).not.toContain('revokeKey');
    } finally {
      await act(async () => root!.unmount());
    }
  });
});
