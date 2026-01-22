import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import { useColorScheme } from 'nativewind';
import { getBackgroundColor } from '@agentpress/shared';
import * as React from 'react';

export default function AppLayout() {
  const { colorScheme } = useColorScheme();
  
  const backgroundColor = React.useMemo(
    () => getBackgroundColor(Platform.OS, colorScheme),
    [colorScheme]
  );

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
        gestureEnabled: true,
        gestureDirection: 'horizontal',
        fullScreenGestureEnabled: true,
        animationDuration: 300,
        contentStyle: {
          backgroundColor,
        },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          animation: 'fade',
          gestureEnabled: false,
        }}
      />
      <Stack.Screen
        name="menu"
        options={{
          gestureEnabled: false,
        }}
      />
      <Stack.Screen
        name="thread/[id]"
        options={{
          gestureEnabled: false,
          presentation: 'card',
        }}
      />
      <Stack.Screen name="plans" />
      <Stack.Screen name="usage" />
      <Stack.Screen name="worker-config" />
      <Stack.Screen name="trigger-detail" />
    </Stack>
  );
}
