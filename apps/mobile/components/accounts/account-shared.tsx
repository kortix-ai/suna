/**
 * Shared primitives for the Account Settings tabs — colors, cards, avatars,
 * badges, role pills — so every tab pulls from one place and matches the rest
 * of the mobile app.
 */

import React, { useEffect, useRef } from 'react';
import { View, TouchableOpacity, ActivityIndicator, Animated, Easing, type ViewStyle } from 'react-native';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/theme-colors';
import type { AccountRole } from '@/lib/projects/projects-client';
import type { AccountCapability } from '@/lib/accounts/hooks';

export type AccountCaps = Record<AccountCapability, boolean>;

export const ACCOUNT_ROLE_LABEL: Record<AccountRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

export function accountColors(isDark: boolean) {
  return {
    fg: isDark ? '#F8F8F8' : '#121215',
    muted: isDark ? '#9b9b9b' : '#6e6e6e',
    border: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    inputBorder: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)',
    inputBg: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
    cardBg: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)',
    avatarBg: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
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

export function Pill({ label, isDark, tone = 'neutral' }: { label: string; isDark: boolean; tone?: 'neutral' | 'amber' | 'emerald' | 'primary' }) {
  const c = accountColors(isDark);
  const theme = useThemeColors();
  const color = tone === 'amber' ? '#d97706' : tone === 'emerald' ? '#16a34a' : tone === 'primary' ? theme.primary : c.muted;
  const bg = tone === 'amber' ? 'rgba(217,119,6,0.12)' : tone === 'emerald' ? 'rgba(34,197,94,0.12)' : tone === 'primary' ? theme.primaryLight : c.avatarBg;
  return (
    <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: bg }}>
      <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color }}>{label}</Text>
    </View>
  );
}

export function RolePill({ role, isDark }: { role: AccountRole; isDark: boolean }) {
  const c = accountColors(isDark);
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1, borderColor: role === 'owner' ? (isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)') : c.inputBorder }}>
      <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: c.fg }}>{ACCOUNT_ROLE_LABEL[role]}</Text>
    </View>
  );
}

export function Card({ title, description, count, tone, isDark, action, children }: {
  title?: string;
  description?: string;
  count?: number;
  tone?: 'destructive';
  isDark: boolean;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const c = accountColors(isDark);
  const borderColor = tone === 'destructive' ? 'rgba(239,68,68,0.3)' : c.border;
  const bg = tone === 'destructive' ? 'rgba(239,68,68,0.04)' : c.cardBg;
  const titleColor = tone === 'destructive' ? '#ef4444' : c.fg;
  return (
    <View style={{ borderRadius: 16, borderWidth: 1, borderColor, backgroundColor: bg, padding: 16 }}>
      {(title || action) && (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1 }}>
            {title && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: titleColor }}>{title}</Text>
                {typeof count === 'number' && (
                  <View style={{ minWidth: 20, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: c.avatarBg, alignItems: 'center' }}>
                    <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: c.muted }}>{count}</Text>
                  </View>
                )}
              </View>
            )}
            {description && <Text style={{ fontSize: 12, lineHeight: 17, color: c.muted, marginTop: 4 }}>{description}</Text>}
          </View>
          {action}
        </View>
      )}
      {children}
    </View>
  );
}

/** Centered placeholder for tabs not yet built / empty. */
export function TabPlaceholder({ text, isDark, loading }: { text: string; isDark: boolean; loading?: boolean }) {
  const c = accountColors(isDark);
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40, gap: 12 }}>
      {loading ? <ActivityIndicator size="small" color={c.muted} /> : <Text style={{ fontSize: 14, color: c.muted, textAlign: 'center' }}>{text}</Text>}
    </View>
  );
}

// ─── Skeletons ────────────────────────────────────────────────────────────────

function useShimmer() {
  const v = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 720, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0.45, duration: 720, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return v;
}

export function Skeleton({ w, h, r = 8, isDark, style }: { w: number | string; h: number; r?: number; isDark: boolean; style?: ViewStyle }) {
  const opacity = useShimmer();
  const bg = isDark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.07)';
  return <Animated.View style={[{ width: w as any, height: h, borderRadius: r, backgroundColor: bg, opacity }, style]} />;
}

/** A row of avatar + two text lines — used for member/group list loading. */
export function SkeletonRow({ isDark, avatar = true }: { isDark: boolean; avatar?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 }}>
      {avatar && <Skeleton w={36} h={36} r={18} isDark={isDark} />}
      <View style={{ flex: 1, gap: 7 }}>
        <Skeleton w={'55%'} h={13} isDark={isDark} />
        <Skeleton w={'32%'} h={11} isDark={isDark} />
      </View>
      <Skeleton w={56} h={22} r={999} isDark={isDark} />
    </View>
  );
}

/** N skeleton rows with dividers. `bare` drops the card border/background to
 *  match a borderless list. */
export function SkeletonList({ count = 3, isDark, avatar = true, bare = false }: { count?: number; isDark: boolean; avatar?: boolean; bare?: boolean }) {
  const c = accountColors(isDark);
  const wrap = bare
    ? {}
    : { borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.cardBg, paddingHorizontal: 12 } as const;
  return (
    <View style={wrap}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={{ borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}>
          <SkeletonRow isDark={isDark} avatar={avatar} />
        </View>
      ))}
    </View>
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
    <TouchableOpacity onPress={onPress} disabled={disabled} activeOpacity={0.85} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 16, height: 44, borderRadius: 9999, backgroundColor: theme.primary, opacity: disabled ? 0.5 : 1 }}>
      {pending ? <ActivityIndicator size="small" color={theme.primaryForeground} /> : icon}
      <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>{label}</Text>
    </TouchableOpacity>
  );
}
