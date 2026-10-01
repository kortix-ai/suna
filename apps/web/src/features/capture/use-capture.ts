'use client';

import {
  getCaptureSettings,
  listAccountMembers,
  listCaptureDevices,
  type CaptureDevice,
  type CaptureSettings,
} from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

import { useSettingsAccountId } from '@/features/workspace/settings/use-settings-account-id';
import { useAccountsList } from '@/hooks/account/use-accounts-list';

import { isManagerRole } from './capture-model';

export const captureKeys = {
  all: ['capture'] as const,
  settings: (accountId: string) => ['capture', 'settings', accountId] as const,
  devices: ['capture', 'devices'] as const,
  members: (accountId: string) => ['capture', 'members', accountId] as const,
  timeline: (accountId: string, userId: string, day: string) =>
    ['capture', 'timeline', accountId, userId, day] as const,
  frames: (accountId: string, userId: string, chunkId: string) =>
    ['capture', 'frames', accountId, userId, chunkId] as const,
};

/** The current account, the caller's role in it, and Capture's settings there. */
export function useCaptureAccount() {
  const accountId = useSettingsAccountId();
  const accounts = useAccountsList().data;
  const account = accounts?.find((a) => a.account_id === accountId);
  const role = account?.account_role;
  const settings = useQuery({
    queryKey: captureKeys.settings(accountId ?? ''),
    queryFn: () => getCaptureSettings(accountId!),
    enabled: !!accountId,
    staleTime: 30_000,
  });
  return {
    accountId,
    accounts: accounts ?? [],
    account,
    role,
    isManager: isManagerRole(role),
    isOwner: role === 'owner',
    settings,
  };
}

export function useCaptureDevices() {
  return useQuery({
    queryKey: captureKeys.devices,
    queryFn: async () => (await listCaptureDevices()).devices,
    staleTime: 15_000,
  });
}

/** Members an owner or admin may pick, only while the owner allows admin views. */
export function useCaptureMembers(accountId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: captureKeys.members(accountId ?? ''),
    queryFn: () => listAccountMembers(accountId!),
    enabled: enabled && !!accountId,
    staleTime: 60_000,
  });
}

export type { CaptureDevice, CaptureSettings };
