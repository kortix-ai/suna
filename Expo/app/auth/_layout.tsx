import { Stack } from 'expo-router';
import { useColorScheme } from 'nativewind';

/**
 * Auth Layout
 * 
 * Stack navigation for authentication screens
 */
export default function AuthLayout() {
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
      <Stack.Screen name="callback" />
    </Stack>
  );
}

