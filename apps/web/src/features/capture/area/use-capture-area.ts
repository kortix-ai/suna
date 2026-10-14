'use client';

import type { CaptureDevice } from '@kortix/sdk';
import { useCaptureWorkspace } from '@kortix/sdk/react';
import { useCallback, useMemo } from 'react';

import { useAccountMembers } from '@/features/accounts/hub/use-account-members';
import { useAuth } from '@/features/providers/auth-provider';
import { useAccountsList } from '@/hooks/account/use-accounts-list';

/**
 * Kortix Capture lives at `/capture/[accountId]`: the Kortix account is its
 * tenant (no project). Every page of the area reads the account's Capture
 * workspace once, here: on or off, and what Kortix IAM lets the viewer do. The
 * API enforces the same rules (`apps/api/src/capture/account-routes.ts`):
 *
 * - every member: their own devices and timeline;
 * - `capture.read_all` (owner and admin by default): every member's, audited;
 * - `capture.manage` (owner and admin by default): Settings (the switch, the policy) and revoking any device.
 */
export function useCaptureArea(accountId: string) {
  const workspace = useCaptureWorkspace(accountId);
  const accounts = useAccountsList();
  const account = accounts.data?.find((candidate) => candidate.account_id === accountId) ?? null;
  return {
    workspace,
    enabled: workspace.data?.enabled ?? false,
    /** `capture.read_all`: every member's devices and timelines (audited). */
    readsEveryone: workspace.data?.can_read_all ?? false,
    /** `capture.manage`: Settings, the switch, the policy, revoking any device. */
    canManage: workspace.data?.can_manage ?? false,
    accountName: account?.name ?? '',
    accounts: accounts.data ?? [],
  };
}

/** The pages of the area, in the header's order. */
// `settings` (the organization's Kortix Capture settings) shows only to people with capture.manage.
export const CAPTURE_SECTIONS = ['devices', 'settings'] as const;
export type CaptureSection = (typeof CAPTURE_SECTIONS)[number];

export function captureHref(accountId: string, section: CaptureSection = 'devices', rest = '') {
  return `/capture/${accountId}/${section}${rest}`;
}

/** The section of a `/capture/[accountId]/…` path. */
export function sectionOf(pathname: string | null): CaptureSection {
  const part = pathname?.split('/capture/')[1]?.split('/')[1] ?? '';
  return (CAPTURE_SECTIONS as readonly string[]).includes(part)
    ? (part as CaptureSection)
    : 'devices';
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

// ── People: names for user ids ──────────────────────────────────────────────

export interface CapturePerson {
  /** null: a device linked to no one (an IT-enrolled computer). */
  userId: string | null;
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
    (userId: string | null): CapturePerson =>
      userId === null
        ? { userId: null, email: null, isYou: false }
        : {
            userId,
            email: byId.get(userId) ?? (userId === viewerId ? (user?.email ?? null) : null),
            isYou: userId === viewerId,
          },
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
