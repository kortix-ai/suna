import * as React from 'react';
import { View, Text } from 'react-native';
import { Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { StatusBar as RNStatusBar } from 'react-native';
import { useAuthContext } from '@/contexts';

/**
 * Main Home Screen
 *
 * Protected by root layout AuthProtection - requires authentication
 *
 * This is a boilerplate home screen - customize it for your app needs
 */
export default function HomeScreen() {
  const { colorScheme } = useColorScheme();
  const { isAuthenticated, user } = useAuthContext();

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <RNStatusBar barStyle={colorScheme === 'dark' ? 'light-content' : 'dark-content'} />

      <View className="flex-1 bg-background items-center justify-center p-4">
        <Text className="text-foreground text-2xl font-bold mb-2">
          Welcome to Your App!
        </Text>
        <Text className="text-muted-foreground text-center">
          {isAuthenticated ? `Logged in as: ${user?.email || 'User'}` : 'Please log in'}
        </Text>
        <Text className="text-muted-foreground text-sm mt-4 text-center">
          This is a boilerplate screen. Customize it for your needs.
        </Text>
      </View>
    </>
  );
}
