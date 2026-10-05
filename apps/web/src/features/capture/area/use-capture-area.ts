'use client';

import type { CaptureDevice } from '@kortix/sdk';
import { useCaptureWorkspace } from '@kortix/sdk/react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import { useAccountMembers } from '@/features/accounts/hub/use-account-members';
import { useAuth } from '@/features/providers/auth-provider';
import { useAccountsList } from '@/hooks/account/use-accounts-list';

import { lastDaysWindow } from '../capture-time';

/**
 * Kortix Capture lives at `/capture/[accountId]`: the Kortix account is its
 * tenant (no project). Every page of the area reads the account's Capture
 * workspace once, here: on or off, and the viewer's Capture role. The API
 * enforces the same rules (`apps/api/src/capture/account-routes.ts`):
 *
 * - `admin` (account owners and admins by default): every member, the policy, Settings;
 * - `viewer`: every member, read only;
 * - `member`: their own devices only.
 */
export function useCaptureArea(accountId: string) {
  const workspace = useCaptureWorkspace(accountId);
  const accounts = useAccountsList();
  const role = workspace.data?.role ?? null;
  const account = accounts.data?.find((candidate) => candidate.account_id === accountId) ?? null;
  return {
    workspace,
    enabled: workspace.data?.enabled ?? false,
    role,
    /** Settings, the policy, roles. */
    isAdmin: role === 'admin',
    /** Reads every member's devices and timelines (audited). */
    readsEveryone: role === 'admin' || role === 'viewer',
    /** May turn Capture on or off (account owners and admins). */
    canManage: workspace.data?.can_manage ?? false,
    accountName: account?.name ?? '',
    accounts: accounts.data ?? [],
  };
}

/** The pages of the area, in the header's order. */
export const CAPTURE_SECTIONS = ['overview', 'workflows', 'ask', 'devices'] as const;
export type CaptureSection = (typeof CAPTURE_SECTIONS)[number] | 'settings' | 'this-computer';

export function captureHref(accountId: string, section: CaptureSection = 'overview', rest = '') {
  return `/capture/${accountId}${section === 'overview' ? '' : `/${section}`}${rest}`;
}

/** The section of a `/capture/[accountId]/…` path. */
export function sectionOf(pathname: string | null): CaptureSection {
  const part = pathname?.split('/capture/')[1]?.split('/')[1] ?? '';
  return (
    [...CAPTURE_SECTIONS, 'settings', 'this-computer'] as readonly string[]
  ).includes(part)
    ? (part as CaptureSection)
    : 'overview';
}

// ── The last account used in the area (per browser) ─────────────────────────

const LAST_ACCOUNT_KEY = 'kortix.capture.account';

export function rememberCaptureAccount(accountId: string) {
  try {
    localStorage.setItem(LAST_ACCOUNT_KEY, accountId);
  } catch {
    // A private window or blocked storage: `/capture` falls back to the first account.
  }
}

export function lastCaptureAccount(): string | null {
  try {
    return localStorage.getItem(LAST_ACCOUNT_KEY);
  } catch {
    return null;
  }
}

// ── The header's date range (`?range=`) ─────────────────────────────────────

/** Day counts the range menu offers. The API reads at most 31 days per request. */
export const CAPTURE_RANGES = [1, 7, 30] as const;
export type CaptureRangeDays = (typeof CAPTURE_RANGES)[number];

export function useCaptureRange() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = Number(params.get('range'));
  const days: CaptureRangeDays = (CAPTURE_RANGES as readonly number[]).includes(raw)
    ? (raw as CaptureRangeDays)
    : 30;
  // The window moves at most once a day; the key keeps it stable within one.
  const today = new Date().toDateString();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const window = useMemo(() => lastDaysWindow(days), [days, today]);
  const setDays = useCallback(
    (next: CaptureRangeDays) => {
      const query = new URLSearchParams(params.toString());
      if (next === 30) query.delete('range');
      else query.set('range', String(next));
      const qs = query.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  return { days, window, setDays };
}

// ── People: names for user ids ──────────────────────────────────────────────

export interface CapturePerson {
  userId: string;
  /** The member's email, or null when the viewer may not read the member list. */
  email: string | null;
  isYou: boolean;
}

/**
 * Who a `user_id` is. Capture rows carry ids only; the account member list
 * has the emails. A member who may not read that list still knows themselves.
 */
export function useCaptureDirectory(accountId: string, enabled: boolean) {
  const { user } = useAuth();
  const members = useAccountMembers(accountId, enabled);
  const byId = useMemo(
    () => new Map((members.data ?? []).map((member) => [member.user_id, member.email])),
    [members.data],
  );
  const viewerId = user?.id ?? null;
  const personOf = useCallback(
    (userId: string): CapturePerson => ({
      userId,
      email: byId.get(userId) ?? (userId === viewerId ? (user?.email ?? null) : null),
      isYou: userId === viewerId,
    }),
    [byId, viewerId, user?.email],
  );
  return { personOf, viewerId, members: members.data ?? [], isLoading: members.isLoading };
}

/** A device's display name: its computer name, else its OS. */
export function deviceName(device: Pick<CaptureDevice, 'name' | 'os'>, fallback: string) {
  return device.name?.trim() || fallback;
}

/** `macOS 26.0`, `Windows 11`. */
export function deviceOs(device: Pick<CaptureDevice, 'os' | 'os_version'>): string {
  const os = device.os?.toLowerCase();
  const name =
    os === 'macos' || os === 'darwin'
      ? 'macOS'
      : os === 'windows' || os === 'win32'
        ? 'Windows'
        : os === 'linux'
          ? 'Linux'
          : (device.os ?? '');
  return [name, device.os_version].filter(Boolean).join(' ');
}
