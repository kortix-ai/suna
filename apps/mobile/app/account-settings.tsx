import { Stack } from 'expo-router';

import { AccountPage } from '@/components/settings/AccountPage';

/**
 * The Account page pushed over a project, opened from the project sidebar's
 * avatar. Same page as the Account tab, with a Go back header, so Sign out,
 * Billing and Accounts are reachable without leaving the project.
 */
export default function AccountSettingsScreen() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <AccountPage presentation="stack" />
    </>
  );
}
