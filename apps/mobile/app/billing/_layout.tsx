/**
 * Billing Layout
 * 
 * Navigation stack for billing-related screens
 */

import { Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';

export default function BillingLayout() {
  const { colorScheme } = useColorScheme();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: {
          backgroundColor: colorScheme === 'dark' ? '#09090B' : '#FFFFFF',
        },
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="trial" />
      <Stack.Screen name="subscription" />
      <Stack.Screen name="credits" />
      <Stack.Screen name="success" />
      <Stack.Screen name="cancel" />
    </Stack>
  );
}

