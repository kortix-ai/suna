/**
 * AccountMenuSheet — the top-right account/user menu, mirroring web's user-menu.tsx.
 *
 * Current account (+ account settings) → Home / Docs / Support / User settings →
 * Appearance → Log out.
 *
 * Built on the shared `Sheet` primitive rather than a per-screen gorhom modal, and
 * on `ListRow` / `ToggleGroup` rather than hand-rolled menu rows. Actions are
 * grouped into cards, and Log out sits alone in its own card so a destructive tap
 * can never be a slip from the row above it.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  ArrowUpRight,
  BookOpen,
  Home,
  LifeBuoy,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Sun,
} from 'lucide-react-native';

import { Sheet, SheetBody, type SheetRef } from '@/components/ui/sheet';
import { ToggleGroup, ToggleGroupIcon, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ListRow } from '@/components/ui/list-row';
import { Icon } from '@/components/ui/icon';
import { Avatar } from '@/components/ui/Avatar';
import { getFrontendUrl } from '@/api/config';
import { useThemeStore, type ThemePreference } from '@/stores/theme-store';
import { haptics } from '@/lib/haptics';

/** Let the sheet finish dismissing before we navigate away underneath it. */
const DISMISS_MS = 160;

const THEME_OPTIONS: { value: ThemePreference; icon: typeof Sun; label: string }[] = [
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
  { value: 'system', icon: Monitor, label: 'System' },
];

/** Rounded card that groups related rows, clipping their dividers to the radius. */
function MenuGroup({ children }: { children: React.ReactNode }) {
  return <View className="overflow-hidden rounded-2xl bg-secondary/50">{children}</View>;
}

function RowIcon({ as, destructive }: { as: typeof Home; destructive?: boolean }) {
  return (
    <Icon
      as={as}
      size={18}
      strokeWidth={2}
      className={destructive ? 'text-destructive' : 'text-muted-foreground'}
    />
  );
}

const ExternalHint = <Icon as={ArrowUpRight} size={16} className="text-muted-foreground/60" />;

interface AccountMenuSheetProps {
  open: boolean;
  name?: string | null;
  email?: string | null;
  accountName?: string | null;
  accountId?: string | null;
  isSigningOut?: boolean;
  onSignOut: () => void;
  onClose: () => void;
}

export function AccountMenuSheet({
  open,
  name,
  email,
  accountName,
  accountId,
  isSigningOut,
  onSignOut,
  onClose,
}: AccountMenuSheetProps) {
  const sheetRef = useRef<SheetRef>(null);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);

  useEffect(() => {
    if (open) sheetRef.current?.open();
    else sheetRef.current?.close();
  }, [open]);

  /** Dismiss first, then run the action — never navigate mid-animation. */
  const go = useCallback((fn: () => void) => {
    haptics.tap();
    sheetRef.current?.close();
    setTimeout(fn, DISMISS_MS);
  }, []);

  const openExternal = useCallback(
    (path: string) => {
      const frontend = getFrontendUrl().replace(/\/$/, '');
      go(() => { void Linking.openURL(`${frontend}${path}`).catch(() => {}); });
    },
    [go],
  );

  // The account row is now the only identity on the sheet, so it must never be
  // empty — fall back to the user's own name when there is no account name.
  const accountTitle = (accountName || name || email?.split('@')[0] || 'Account').trim();

  return (
    <Sheet ref={sheetRef} enablePanDownToClose onDismiss={onClose}>
      <SheetBody className="gap-3 px-4 pb-2 pt-2">
        {/* The account row already carries the identity, so there is no separate
            header repeating the same name and avatar above it. */}
        <MenuGroup>
          <ListRow
            title={accountTitle}
            subtitle="Account settings"
            divider={false}
            left={<Avatar variant="custom" size={32} fallbackText={accountTitle} />}
            onPress={() => go(() => router.push(accountId ? `/accounts/${accountId}` : '/(settings)'))}
          />
        </MenuGroup>

        {/* Web parity with user-menu.tsx, minus Download apps (you're already on
            mobile) and Billing (deliberately web-only). Home is the projects
            dashboard, not the legacy sandbox home. */}
        <MenuGroup>
          <ListRow
            title="Home"
            left={<RowIcon as={Home} />}
            onPress={() => go(() => router.replace('/projects'))}
          />
          <ListRow
            title="Docs"
            left={<RowIcon as={BookOpen} />}
            right={ExternalHint}
            onPress={() => openExternal('/docs')}
          />
          <ListRow
            title="Support"
            left={<RowIcon as={LifeBuoy} />}
            right={ExternalHint}
            onPress={() => openExternal('/support')}
          />
          <ListRow
            title="User settings"
            left={<RowIcon as={Settings} />}
            divider={false}
            onPress={() => go(() => router.push('/(settings)'))}
          />
        </MenuGroup>

        <MenuGroup>
          <ListRow
            title="Appearance"
            divider={false}
            right={
              <ToggleGroup
                type="single"
                value={preference}
                className="border-border overflow-hidden rounded-md border"
                onValueChange={(next) => {
                  if (!next) return;
                  haptics.selection();
                  void setPreference(next as ThemePreference);
                }}>
                {THEME_OPTIONS.map((opt, i) => (
                  <ToggleGroupItem
                    key={opt.value}
                    value={opt.value}
                    size="sm"
                    aria-label={opt.label}
                    isFirst={i === 0}
                    isLast={i === THEME_OPTIONS.length - 1}>
                    <ToggleGroupIcon as={opt.icon} />
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            }
          />
        </MenuGroup>

        {/* Its own card: a destructive tap should never be a near-miss of the row above. */}
        <MenuGroup>
          <ListRow
            title={isSigningOut ? 'Signing out…' : 'Log out'}
            variant="destructive"
            divider={false}
            disabled={isSigningOut}
            left={<RowIcon as={LogOut} destructive />}
            right={isSigningOut ? <ActivityIndicator size="small" /> : null}
            onPress={() => {
              haptics.medium();
              onSignOut();
            }}
          />
        </MenuGroup>

        {/* Clear the home indicator. */}
        <View style={{ height: insets.bottom }} />
      </SheetBody>
    </Sheet>
  );
}
