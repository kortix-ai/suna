import * as React from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Bell,
  Globe,
  LogOut,
  Palette,
  User,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react-native';
import { useAuthContext, useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Avatar } from '@/components/ui/Avatar';
import { ListRow } from '@/components/ui/list-row';
import { haptics } from '@/lib/haptics';

interface AccountRow {
  key: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  route: string;
}

const ROWS: AccountRow[] = [
  {
    key: 'general',
    icon: User,
    title: 'General',
    subtitle: 'Profile details and account controls',
    route: '/(settings)/general',
  },
  {
    key: 'appearance',
    icon: Palette,
    title: 'Appearance',
    subtitle: 'Color mode, wallpaper, and palette',
    route: '/(settings)/appearance',
  },
  {
    key: 'notifications',
    icon: Bell,
    title: 'Notifications',
    subtitle: 'Manage how you receive notifications',
    route: '/(settings)/notifications',
  },
  {
    key: 'language',
    icon: Globe,
    title: 'Language',
    subtitle: 'App display language',
    route: '/(settings)/language',
  },
  {
    key: 'billing',
    icon: Wallet,
    title: 'Billing',
    subtitle: 'Plans, usage, and payment methods',
    route: '/billing',
  },
  {
    key: 'accounts',
    icon: Users,
    title: 'Accounts',
    subtitle: 'Switch or manage workspaces',
    route: '/accounts',
  },
];

export default function AccountTab() {
  const { user, signOut, isSigningOut } = useAuthContext();
  const { t } = useLanguage();
  const router = useRouter();

  const displayName =
    user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User';
  const email = user?.email || '';

  const go = React.useCallback(
    (path: string) => {
      haptics.tap();
      router.push(path as any);
    },
    [router],
  );

  const handleSignOut = React.useCallback(() => {
    if (isSigningOut) return;
    haptics.warning();
    Alert.alert(
      t('settings.signOut'),
      t('auth.signOutConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.signOut'),
          style: 'destructive',
          onPress: async () => {
            haptics.medium();
            const result = await signOut();
            if (result?.success) {
              haptics.success();
              router.replace('/');
            } else {
              haptics.warning();
              Alert.alert(t('common.error'), 'Failed to sign out. Please try again.');
            }
          },
        },
      ],
      { cancelable: true },
    );
  }, [isSigningOut, router, signOut, t]);

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <View className="flex-row items-center border-b border-border bg-sidebar px-4 py-3.5">
        <Text className="font-roobert-semibold text-lg text-foreground">Account</Text>
      </View>

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        <View className="items-center px-5 pb-6 pt-8">
          <Avatar size={64} fallbackText={displayName} />
          <Text className="mt-3 font-roobert-semibold text-lg text-foreground">
            {displayName}
          </Text>
          {!!email && (
            <Text className="mt-0.5 text-sm text-muted-foreground">{email}</Text>
          )}
        </View>

        <View className="mx-4 overflow-hidden rounded-xl border border-border bg-card">
          {ROWS.map((row, idx) => (
            <ListRow
              key={row.key}
              title={row.title}
              subtitle={row.subtitle}
              left={
                <Icon
                  as={row.icon}
                  size={18}
                  className="text-foreground/80"
                  strokeWidth={2.2}
                />
              }
              onPress={() => go(row.route)}
              divider={idx !== ROWS.length - 1}
            />
          ))}
        </View>

        <View className="mx-4 mt-5 overflow-hidden rounded-xl border border-border bg-card">
          <ListRow
            title={t('settings.signOut')}
            left={
              <Icon as={LogOut} size={18} className="text-destructive" strokeWidth={2.2} />
            }
            right={<View />}
            onPress={isSigningOut ? undefined : handleSignOut}
            divider={false}
            className={isSigningOut ? 'opacity-50' : undefined}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
