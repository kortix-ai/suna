/**
 * Shared pieces for the account screens (`/accounts/[id]`).
 *
 * `useEffectiveAccountCaps` gates the web-handoff rows on `/accounts/[id]`.
 * `accountColors`, `InitialsAvatar`, `SheetCloseButton` and `PrimaryButton`
 * remain for `NewAccountSheet`. The role pickers, member/group detail
 * helpers, and legacy card / pill / uppercase label / skeleton primitives
 * were deleted once no screen imported them (see apps/mobile/design.md —
 * mobile hands Members, Groups, Git and Audit off to web, COR-120).
 */

import React, { useMemo } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { XIcon as X } from '@/lib/icons';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { useThemeColors } from '@/lib/theme-colors';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { useAccount, useAccountCapabilities, type AccountCapability } from '@/lib/accounts/hooks';

export type AccountCaps = Record<AccountCapability, boolean>;

/**
 * The account plus the current user's capabilities on it. The IAM probe is
 * merged with the account role so owners/admins keep full access even if the
 * probe is slow or unavailable (it can't *remove* a granted capability).
 */
export function useEffectiveAccountCaps(accountId: string | null, userId: string | null) {
  const accountQuery = useAccount(accountId);
  const { can } = useAccountCapabilities(accountId, userId);
  const account = accountQuery.data;
  const isAdmin = account?.role === 'owner' || account?.role === 'admin';
  const isOwner = account?.role === 'owner';
  const effectiveCan = useMemo<AccountCaps>(
    () => ({
      'account.write': can['account.write'] || isAdmin,
      'account.delete': can['account.delete'] || isOwner,
      'member.invite': can['member.invite'] || isAdmin,
      'member.remove': can['member.remove'] || isAdmin,
      'member.update': can['member.update'] || isAdmin,
      'group.create': can['group.create'] || isAdmin,
      'audit.read': can['audit.read'] || isAdmin,
    }),
    [can, isAdmin, isOwner]
  );
  return { accountQuery, account, can: effectiveCan };
}

/**
 * `fg`/`muted` reuse the same THEME mapping as `useThemeColors().primary` /
 * `--muted-foreground` (see `lib/theme-colors.ts`'s header comment — dark
 * `fg` intentionally reads `THEME.dark.foreground`, not `--primary`, to
 * avoid a 7.5pp dark-mode dimming). The alpha-tinted fields
 * (`border`/`inputBorder`/`inputBg`/`cardBg`/`avatarBg`) were literal
 * black-at-alpha (light) / white-at-alpha (dark) overlays —
 * `withAlpha(THEME.x.foreground, X)` reproduces the same base color
 * (near-black light / near-white dark) at the same alpha, so every field
 * below renders pixel-identical to its old literal.
 */
export function accountColors(isDark: boolean) {
  return {
    fg: isDark ? THEME.dark.foreground : THEME.light.primary,
    muted: isDark ? THEME.dark.foregroundWeak : THEME.light.foregroundWeak,
    border: withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, 0.08),
    inputBorder: withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, isDark ? 0.1 : 0.12),
    inputBg: withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, isDark ? 0.05 : 0.03),
    cardBg: withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, isDark ? 0.02 : 0.015),
    avatarBg: withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, isDark ? 0.08 : 0.06),
  };
}

export function InitialsAvatar({ label, isDark, size = 36 }: { label: string | null; isDark: boolean; size?: number }) {
  const c = accountColors(isDark);
  const letter = (label || '?').trim().charAt(0).toUpperCase();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c.avatarBg, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontSize: size * 0.42, fontFamily: 'Roobert-Medium', color: c.fg }}>{letter}</Text>
    </View>
  );
}

/** Round 30×30 sheet-header dismiss button (the "X" every account sheet uses). */
export function SheetCloseButton({ onPress, isDark }: { onPress: () => void; isDark: boolean }) {
  const c = accountColors(isDark);
  return (
    <Button
      variant="secondary"
      size="icon"
      onPress={onPress}
      hitSlop={8}
      className="rounded-full"
    >
      <X size={17} color={c.muted} />
    </Button>
  );
}

export function PrimaryButton({ label, onPress, disabled, pending, icon, isDark }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  pending?: boolean;
  icon?: React.ReactNode;
  isDark?: boolean;
}) {
  const theme = useThemeColors();
  return (
    <Button
      size="lg"
      onPress={onPress}
      disabled={disabled}
      className="rounded-full"
    >
      {pending ? <ActivityIndicator size="small" color={theme.primaryForeground} /> : icon}
      <Text>{label}</Text>
    </Button>
  );
}
