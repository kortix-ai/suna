import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, create } from 'react-test-renderer';

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

const getUser = async () => ({
  data: { user: { user_metadata: {}, email: 'demo@example.test' } },
  error: null,
});

mock.module('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getUser, updateUser: async () => ({ error: null }) } }),
}));
mock.module('@/lib/config', () => ({ isBillingEnabled: () => true }));
mock.module('@/hooks/account/use-account-deletion', () => ({
  useAccountDeletionStatus: () => ({
    data: { has_pending_deletion: false, deletion_scheduled_for: null, supported: true },
    isLoading: false,
  }),
  useRequestAccountDeletion: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useDeleteAccountImmediately: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useCancelAccountDeletion: () => ({ mutateAsync: async () => ({}), isPending: false }),
}));
mock.module('./account-memberships', () => ({
  useAccountMemberships: () => ({ accounts: [], isLoading: false }),
  AccountMembershipsSection: () => null,
}));
mock.module('@/components/ui/modal', () => ({
  Modal: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  ModalBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ModalTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
mock.module('@/components/ui/radio-group', () => ({
  RadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  RadioGroupItem: () => <div />,
}));

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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => {
    renderer = create(createElement(QueryClientProvider, { client }, createElement(ProfileTab)));
  });
  return { renderer: renderer!, client };
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
