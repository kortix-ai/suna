import * as React from 'react';
import { Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { useLanguage } from '@/contexts';
import { Bell, BookOpen, LifeBuoy, Palette, User, Volume2 } from 'lucide-react-native';
import {
  AppearanceRow,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
} from '@/components/kortix/settings-list';
import { getFrontendUrl } from '@/api/config';
import { haptics } from '@/lib/haptics';

/**
 * User settings — Preferences and Help. Account deletion and sign out live in
 * the Account tab's Advanced group, not here.
 */
export default function SettingsScreen() {
  const { t } = useLanguage();
  const router = useRouter();

  const go = React.useCallback(
    (path: string) => {
      haptics.tap();
      router.push(path as any);
    },
    [router]
  );

  // Docs and Support open kortix.com in the browser (web user-menu parity).
  const openWebPage = React.useCallback((path: string) => {
    haptics.tap();
    const frontend = getFrontendUrl().replace(/\/$/, '');
    void Linking.openURL(`${frontend}${path}`).catch(() => {});
  }, []);

  return (
    <SettingsPage>
      <SettingsGroup title="Preferences">
        <SettingsRow icon={User} label="General" onPress={() => go('/(settings)/general')} />
        {/* Inline control — the color mode changes right here, no subpage. */}
        <AppearanceRow />
        <SettingsRow icon={Volume2} label="Sounds" onPress={() => go('/(settings)/sounds')} />
        <SettingsRow
          icon={Bell}
          label={t('notifications.title', 'Notifications')}
          onPress={() => go('/(settings)/notifications')}
        />
      </SettingsGroup>

      {/* Billing rows (Plan / Billing / Transactions) are hidden on mobile —
          billing lives on the web. */}

      <SettingsGroup title="Help">
        <SettingsRow icon={BookOpen} label="Docs" external onPress={() => openWebPage('/docs')} />
        <SettingsRow icon={LifeBuoy} label="Support" external onPress={() => openWebPage('/support')} />
      </SettingsGroup>
    </SettingsPage>
  );
}
