'use client';

import { getCaptureWorkspace } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQueries } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { ProjectPendingScreen } from '@/components/projects/project-pending-screen';
import { useAccountsList } from '@/hooks/account/use-accounts-list';

import { captureHref, lastCaptureAccount } from './use-capture-area';

/**
 * `/capture`: opens the organization used last in this browser, else the only
 * one, else the first with Capture on, else the first.
 */
export function CaptureStart() {
  const router = useRouter();
  const accounts = useAccountsList();
  const list = accounts.data ?? [];
  const remembered = lastCaptureAccount();
  const direct =
    list.find((account) => account.account_id === remembered) ?? (list.length === 1 ? list[0] : null);
  const workspaces = useQueries({
    queries: direct
      ? []
      : list.map((account) => ({
          queryKey: qk.capture.workspace(account.account_id),
          queryFn: () => getCaptureWorkspace(account.account_id),
          retry: false,
          ...contract('config'),
        })),
  });
  const settled = workspaces.every((query) => !query.isLoading);
  const target =
    direct?.account_id ??
    (settled
      ? (workspaces.find((query) => query.data?.enabled)?.data?.account_id ??
        list[0]?.account_id ??
        null)
      : null);

  useEffect(() => {
    if (target) router.replace(captureHref(target));
    else if (accounts.isSuccess && list.length === 0) router.replace('/projects');
  }, [target, accounts.isSuccess, list.length, router]);

  return <ProjectPendingScreen />;
}
