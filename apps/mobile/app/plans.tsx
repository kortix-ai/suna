import { Stack } from 'expo-router';

import { PlanPage } from '@/components/settings/PlanPage';

/**
 * Plans screen (components/settings/PlanPage). Checkout happens on
 * kortix.com; the native RevenueCat paywall is disabled, so there is no
 * paywall branch here.
 */
export default function PlansScreen() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <PlanPage />
    </>
  );
}
