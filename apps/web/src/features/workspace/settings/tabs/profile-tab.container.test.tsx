import { describe, expect, jest, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';
import * as realModal from '@kortix/ui/modal';

/**
 * The Delete-account dialog's own state contract (KRTX-1403): the
 * confirmation input starts empty on every open, whichever path closed it
 * last. The state lives in the container's open handler, so this drives
 * `ProfileTab` — with the portal-based `Modal` replaced by a flat stand-in
 * (the app's Bun tests have no DOM; the same handling as
 * `sub-session-modal.characterization.test.tsx`) and the container's data
 * hooks mocked to static answers. Asserts the controlled input's `value`,
 * which is what the confirm button is gated on. The dialog's copy is pinned
 * by `profile-tab.test.tsx`.
 */

const uploadAvatar = mock(
  async (_path: string, _file: File, _options: { cacheControl: string; upsert: boolean }) => ({
    error: null,
  }),
);
const getUser = async () => ({
  data: { user: { id: 'synthetic-user', user_metadata: {} } },
  error: null,
});

mock.module('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser, updateUser: async () => ({ error: null }) },
    storage: {
      from: () => ({
        list: async () => ({ data: [], error: null }),
        upload: uploadAvatar,
        getPublicUrl: () => ({ data: { publicUrl: 'https://storage.example.test/avatar.png' } }),
      }),
    },
  }),
}));
mock.module('@kortix/ui/toast', () => ({ successToast: () => {}, errorToast: () => {} }));
mock.module('@/lib/config', () => ({ isBillingEnabled: () => true }));
/** The deletion-status hook's answer, mutable per test. The dialog test
 *  mounts with the supported answer; the fail-closed test swaps in the error
 *  shape — `data` undefined, `isError` set, the exact state a useQuery leaves
 *  behind when the fetch rejects — and restores it afterwards. */
let deletionStatusAnswer: {
  data?: { has_pending_deletion: boolean; deletion_scheduled_for: string | null; supported: boolean };
  isLoading: boolean;
  isError: boolean;
  fetchStatus?: 'fetching' | 'paused' | 'idle';
  errorUpdatedAt?: number;
  dataUpdatedAt?: number;
  refetch: () => void;
} = {
  data: { has_pending_deletion: false, deletion_scheduled_for: null, supported: true },
  isLoading: false,
  isError: false,
  refetch: () => {},
};

mock.module('@/hooks/account/use-account-deletion', () => ({
  useAccountDeletionStatus: () => deletionStatusAnswer,
  useRequestAccountDeletion: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useDeleteAccountImmediately: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useCancelAccountDeletion: () => ({ mutateAsync: async () => ({}), isPending: false }),
}));
mock.module('./account-memberships', () => ({
  useAccountMemberships: () => ({ accounts: [], isLoading: false }),
  AccountMembershipsSection: () => null,
}));
// The real exports, so a new one (ModalClose, ModalContentInner, …) never breaks the mock;
// only the portal-based parts are replaced.
const uiModalMock = () => ({
  ...realModal,
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  ModalBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
});
mock.module('@kortix/ui/modal', uiModalMock);
const uiRadioGroupMock = () => ({
  RadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  RadioGroupItem: () => <div />,
});
mock.module('@kortix/ui/radio-group', uiRadioGroupMock);

// The container reads `t('key')` and `t.raw('key')`. Returning the key's last
// segment keeps the trigger findable by its label without loading the
// translation catalogs.
const translate = (key: string) => key.split('.').pop() || key;
mock.module('@/i18n/use-translations', () => ({
  useLocale: () => 'en',
  useTranslations: () => Object.assign((key: string) => translate(key), { raw: translate }),
}));

const { ProfileTab } = await import('./profile-tab');

async function mountTab() {
  const { ProfileTab } = await import('./profile-tab');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(createElement(QueryClientProvider, { client }, createElement(ProfileTab)));
  });
  if (!renderer) throw new Error('ProfileTab did not mount');
  return { renderer, client };
}

const confirmInput = (root: ReactTestInstance) =>
  root.findAll((n) => n.props.id === 'profile-delete-confirm')[0];

describe('ProfileTab — the delete dialog opens fresh', () => {
  test('the confirmation input starts empty on every open', async () => {
    const { renderer, client } = await mountTab();
    try {
      const root = renderer.root;
      const trigger = root.findAll(
        (n) =>
          n.props.className?.includes?.('text-destructive') &&
          n.children.length === 1 &&
          n.children[0] === 'deleteAccount',
      )[0];
      expect(trigger).toBeDefined();

      // First open: type the word, then close through the modal's generic
      // dismissal path (the one Escape and the backdrop click take).
      await act(async () => trigger.props.onClick());
      const typed = confirmInput(root);
      expect(typed).toBeDefined();
      await act(async () => typed.props.onChange({ target: { value: 'delete' } }));
      expect(confirmInput(root).props.value).toBe('delete');
      const modal = root.findAll((n) => n.props.onOpenChange !== undefined)[0];
      await act(async () => modal.props.onOpenChange(false));

      // Second open: the field is empty again — the word cannot leak in.
      await act(async () => trigger.props.onClick());
      expect(confirmInput(root).props.value).toBe('');
    } finally {
      await act(async () => renderer.unmount());
      client.clear();
    }
  });
});

/**
 * KRTX-2177: the Delete-account gate must fail closed. A destructive-action
 * gate that derives "supported" from "not loading" arms the dialog whenever
 * the status check ERRORS (useQuery leaves `data` undefined and `isLoading`
 * false on a rejected fetch), so the confirm then fires against an endpoint
 * of unknown state. The characterization: with the query in the error state
 * the row shows no destructive affordance at all — it says the check failed
 * and offers Retry, and the dialog never mounts. Assertions use
 * `toHaveLength`, never `toEqual` on ReactTestInstance arrays: their internal
 * links are circular and hang the deep comparator.
 */
describe('ProfileTab — a failed deletion-status check fails closed', () => {
  test('renders no destructive affordance and offers Retry', async () => {
    const refetchCalls: number[] = [];
    const success = deletionStatusAnswer;
    deletionStatusAnswer = {
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: () => refetchCalls.push(1),
    };
    const { renderer, client } = await mountTab();
    try {
      const root = renderer.root;
      // No destructive trigger anywhere in the pane, and no dialog body —
      // `accountDeletionSupported` must not have been invented from "not
      // loading". The class check is token-precise: every row wrapper carries
      // the `data-[invalid=true]:text-destructive` variant, which a plain
      // substring match would count as a hit.
      const destructive = root.findAll((n) =>
        /(?:^|\s)text-destructive(?:\s|$)/.test(String(n.props.className ?? '')),
      );
      expect(destructive).toHaveLength(0);
      const dialogInput = root.findAll((n) => n.props.id === 'profile-delete-confirm');
      expect(dialogInput).toHaveLength(0);
      // The row states the check failed instead of claiming a definitive
      // answer it does not have.
      const failedCopy = root.findAll(
        (n) => n.children.length === 1 && n.children[0] === 'deletionStatusCheckFailed',
      );
      expect(failedCopy).not.toHaveLength(0);
      // Retry refetches the status — the recovery path.
      const retry = root.findAll(
        (n) => n.children.length === 1 && n.children[0] === 'retry' && n.props.onClick,
      )[0];
      expect(retry).toBeDefined();
      await act(async () => retry.props.onClick());
      expect(refetchCalls).toEqual([1]);
    } finally {
      deletionStatusAnswer = success;
      await act(async () => renderer.unmount());
      client.clear();
    }
  });

  /** Found live on the local stack: query-core clears the error of a data-less
   *  query the moment a retry starts (fetchState → `status: 'pending'`), so a
   *  bare `isError` flag flips false mid-retry and the row flashes the
   *  definitive "isn't available on this deployment" claim. While a retry is
   *  in flight after a failure — `fetchStatus: 'fetching'` with
   *  `errorUpdatedAt > dataUpdatedAt` — the failed row must hold. */
  test.each(['fetching', 'paused'] as const)('keeps the failed row while a retry is %s', async (fetchStatus) => {
    const success = deletionStatusAnswer;
    deletionStatusAnswer = {
      data: undefined,
      isLoading: false,
      isError: false,
      fetchStatus,
      errorUpdatedAt: 5,
      dataUpdatedAt: 0,
      refetch: () => {},
    };
    const { renderer, client } = await mountTab();
    try {
      const root = renderer.root;
      const destructive = root.findAll((n) =>
        /(?:^|\s)text-destructive(?:\s|$)/.test(String(n.props.className ?? '')),
      );
      expect(destructive).toHaveLength(0);
      const failedCopy = root.findAll(
        (n) => n.children.length === 1 && n.children[0] === 'deletionStatusCheckFailed',
      );
      expect(failedCopy).not.toHaveLength(0);
      const retry = root.findAll(
        (n) => n.children.length === 1 && n.children[0] === 'retry' && n.props.onClick,
      )[0];
      expect(retry).toBeDefined();
    } finally {
      deletionStatusAnswer = success;
      await act(async () => renderer.unmount());
      client.clear();
    }
  });

  /** A failed REFETCH on a query that still holds data must not swallow the
   *  row's real state: query-core keeps the previous answer on a failed
   *  refetch, so a user with a scheduled deletion would otherwise see the
   *  failed row (and lose the schedule + cancel control) over a network
   *  blip. The failed shape is for an UNKNOWN answer only — no data. */
  test('a stale answer with a failed refetch keeps the armed row', async () => {
    const success = deletionStatusAnswer;
    deletionStatusAnswer = {
      data: { has_pending_deletion: true, deletion_scheduled_for: '2026-11-01T00:00:00.000Z', supported: true },
      isLoading: false,
      isError: true,
      fetchStatus: 'fetching',
      errorUpdatedAt: 5,
      dataUpdatedAt: 4,
      refetch: () => {},
    };
    const { renderer, client } = await mountTab();
    try {
      const root = renderer.root;
      const failedCopy = root.findAll(
        (n) => n.children.length === 1 && n.children[0] === 'deletionStatusCheckFailed',
      );
      expect(failedCopy).toHaveLength(0);
      const retry = root.findAll(
        (n) => n.children.length === 1 && n.children[0] === 'retry' && n.props.onClick,
      );
      expect(retry).toHaveLength(0);
      const scheduled = root.findAll(
        (n) =>
          n.children.length === 1 &&
          typeof n.children[0] === 'string' &&
          n.children[0].startsWith('scheduledForDeletionOn'),
      );
      expect(scheduled).not.toHaveLength(0);
    } finally {
      deletionStatusAnswer = success;
      await act(async () => renderer.unmount());
      client.clear();
    }
  });
});

describe('ProfileTab — deletion date before consent', () => {
  test('shows the date fourteen days after opening, including a month boundary', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-25T12:00:00Z'));
    const { renderer, client } = await mountTab();
    try {
      const root = renderer.root;
      const trigger = root.findAll(
        (n) =>
          n.props.className?.includes?.('text-destructive') &&
          n.children.length === 1 &&
          n.children[0] === 'deleteAccount',
      )[0];
      await act(async () => trigger.props.onClick());
      const { ProfileTabView } = await import('./profile-tab');
      const view = root.findByType(ProfileTabView);
      const { renderToStaticMarkup } = await import('react-dom/server');
      const out = renderToStaticMarkup(<ProfileTabView {...view.props} />);
      expect(out).toContain('February 8, 2026');
      expect(confirmInput(root).props.value).toBe('');
      const immediate = renderToStaticMarkup(
        <ProfileTabView {...view.props} deletionType="immediate" />,
      );
      expect(immediate).not.toContain('February 8, 2026');
      await act(async () => view.props.onCloseDeleteDialog());
      jest.setSystemTime(new Date('2026-02-01T12:00:00Z'));
      await act(async () => trigger.props.onClick());
      const reopened = renderToStaticMarkup(
        <ProfileTabView {...root.findByType(ProfileTabView).props} />,
      );
      expect(reopened).toContain('February 15, 2026');
      expect(reopened).not.toContain('February 8, 2026');
    } finally {
      await act(async () => renderer.unmount());
      client.clear();
      jest.useRealTimers();
    }
  });
});

test('avatar upload requires revalidation so deletion cannot leave an hour-long fresh response', async () => {
  const { renderer, client } = await mountTab();
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:synthetic-avatar';
  URL.revokeObjectURL = () => {};
  uploadAvatar.mockClear();
  try {
    const { ProfileTabView } = await import('./profile-tab');
    const file = new File(['synthetic-image'], 'avatar.png', { type: 'image/png' });
    await act(async () => {
      renderer.root
        .findByType(ProfileTabView)
        .props.onAvatarFileChange({ target: { files: [file], value: '' } });
    });
    expect(uploadAvatar).toHaveBeenCalledTimes(1);
    expect(uploadAvatar.mock.calls[0]?.[1]).toBe(file);
    expect(uploadAvatar.mock.calls[0]?.[2]).toEqual({ cacheControl: '0', upsert: true });
  } finally {
    await act(async () => renderer.unmount());
    client.clear();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});
