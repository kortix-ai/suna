/**
 * KRTX-2639: one Create-key click produced TWO active keys with the same
 * name on the personal API keys pane.
 *
 * The submit guard was `mutation.isPending`. TanStack's observer notification
 * is scheduled with `setTimeout(0)` (`notifyManager`'s default scheduler), so
 * `isPending` is NOT true yet when a second submit event fires in the same
 * tick — two clicks (or a click plus a form submit, or a retried automation
 * click) both passed the guard and both minted a key.
 *
 * This test fires the form's submit twice back-to-back in one tick, before
 * React could have re-rendered, and pins ONE mint. It then re-submits after
 * the failed mint settled to pin that the guard releases — a real error must
 * still leave the form retryable.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realReactQuery from '@tanstack/react-query';
// A dynamic import: the restricted-import lint rule forbids a namespace import
// of the SDK root, and the mock below must spread the real module.
const realSdk = await import('@kortix/sdk');
const realAccess = await import('@/features/workspace/shared/access');
import { createElement, Fragment, type ReactNode } from 'react';
import { act, create } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const ACCOUNT = '00000000-0000-4000-8000-000000000001';

type Mint = { name: string; accountId: string };
const mints: Mint[] = [];
let firstMintFails = false;

mock.module('@kortix/sdk', () => ({
  ...realSdk,
  listProjectsForAccount: async () => [],
  createAccountToken: async (input: Mint) => {
    mints.push({ name: input.name, accountId: input.accountId });
    if (firstMintFails) throw new Error('Synthetic mint failure');
    return {
      token_id: `tok-${mints.length}`,
      name: input.name,
      project_id: null,
      public_key: 'pk_synthetic0000000000000000000000',
      secret_key: 'kortix_pat_synthetic',
      status: 'active',
      expires_at: null,
      created_at: '2026-10-19T00:00:00.000Z',
    };
  },
}));

// The workspace's key rules are not the subject; no policy, every expiry legal.
mock.module('@/lib/iam-client', () => ({
  getPatPolicy: async () => null,
}));

const uiToastMock = () => ({
  successToast: () => {},
  errorToast: () => {},
});
mock.module('@/components/ui/toast', uiToastMock);
mock.module('@kortix/ui/toast', uiToastMock);

function Pass({ children }: { children?: ReactNode }) {
  return createElement(Fragment, null, children);
}

// The real Modal and Select are Radix portals; the wiring under test is the
// form's submit guard, which stays real. A div keeps the tree assertable.
const uiModalMock = () => {
  const Modal = ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? createElement('div', null, children) : null;
  return {
    Modal,
    ModalBody: Pass,
    ModalContent: Pass,
    ModalDescription: Pass,
    ModalFooter: Pass,
    ModalHeader: Pass,
    ModalTitle: Pass,
  };
};
mock.module('@/components/ui/modal', uiModalMock);
mock.module('@kortix/ui/modal', uiModalMock);
const uiSelectMock = () => ({
  Select: Pass,
  SelectContent: Pass,
  SelectGroup: Pass,
  SelectItem: Pass,
  SelectLabel: Pass,
  SelectTrigger: Pass,
  SelectValue: () => null,
});
mock.module('@/components/ui/select', uiSelectMock);
mock.module('@kortix/ui/select', uiSelectMock);
mock.module('@kortix/ui/access/access/index', () => ({ ...realAccess, CopyRow: Pass }));

const translate = (key: string) => key.split('.').pop() || key;
mock.module('@/i18n/use-translations', () => ({
  useLocale: () => 'en',
  useTranslations: () =>
    Object.assign((key: string) => translate(key), {
      raw: translate,
      rich: (key: string) => translate(key),
    }),
}));

const { CreateApiKeyDialog } = await import('./tokens-tab');

async function mountDialog() {
  const client = new realReactQuery.QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: ReturnType<typeof create> | undefined;
  await act(async () => {
    root = create(
      createElement(
        realReactQuery.QueryClientProvider,
        { client },
        createElement(CreateApiKeyDialog, {
          accountId: ACCOUNT,
          open: true,
          onOpenChange: () => {},
          onCreated: () => {},
        }),
      ),
    );
  });
  if (!root) throw new Error('CreateApiKeyDialog did not render');
  return root;
}

/** Type a name and return the form's submit handler. */
async function fillAndSubmit(root: ReturnType<typeof create>): Promise<() => void> {
  const input = root.root.findByProps({ id: 'personal-api-key-name' });
  await act(async () => {
    input.props.onChange({ target: { value: 'regression-key' } });
  });
  const form = root.root.findByType('form');
  return () => form.props.onSubmit({ preventDefault() {} });
}

beforeEach(() => {
  mints.length = 0;
  firstMintFails = false;
});

describe('CreateApiKeyDialog', () => {
  test('two submits in one tick mint ONE key (KRTX-2639)', async () => {
    firstMintFails = true;
    const root = await mountDialog();
    try {
      const submit = await fillAndSubmit(root);
      // Both events land in the same tick — no render between them, so
      // `mutation.isPending` could not have flipped yet.
      await act(async () => {
        submit();
        submit();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(mints).toHaveLength(1);
      expect(mints[0]).toEqual({ name: 'regression-key', accountId: ACCOUNT });
    } finally {
      await act(async () => root.unmount());
    }
  });

  test('a settled failed mint releases the guard — the form retries', async () => {
    firstMintFails = true;
    const root = await mountDialog();
    try {
      const submit = await fillAndSubmit(root);
      await act(async () => {
        submit();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(mints).toHaveLength(1);

      firstMintFails = false;
      const form = root.root.findByType('form');
      await act(async () => {
        form.props.onSubmit({ preventDefault() {} });
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(mints).toHaveLength(2);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
