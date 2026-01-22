import { Stack } from 'expo-router';
import { Platform, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import { Icon } from '@/components/ui/icon';
import { X, ChevronLeft } from 'lucide-react-native';
import { useLanguage } from '@/contexts';
import { getBackgroundColor, getDrawerBackgroundColor } from '@agentpress/shared';

function HeaderLeft() {
  const router = useRouter();

  return (
    <Icon 
      as={ChevronLeft} 
      size={22} 
      className="text-foreground" 
      strokeWidth={2} 
      onPress={() => router.back()}
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        display: 'flex',
        marginLeft: 6
      }}
    />
  );
}

function HeaderRight() {
  const router = useRouter();
  return (
    <Icon 
      as={X} 
      size={24} 
      className="text-foreground" 
      strokeWidth={2} 
      onPress={() => router.back()}
      style={{
        justifyContent: 'center',
        alignItems: 'center',
        display: 'flex',
        marginLeft: 6
      }}
    />
  );
}

export default function SettingsLayout() {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();

  return (
    <Stack
      screenOptions={{
        headerShown: true,
        animation: Platform.OS === 'ios' ? 'default' : 'slide_from_right',
        presentation: 'card',
        headerTitleAlign: 'center',
        headerShadowVisible: false,
        headerTitleStyle: {
          fontFamily: 'RoobertBold',
          fontSize: 18,
        },
        headerStyle: {
          backgroundColor: getDrawerBackgroundColor(Platform.OS, colorScheme),
        },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: t('settings.title', 'Settings'),
          headerLeft: () => null,
          headerRight: () => <HeaderRight/>,
        }}
      />
      <Stack.Screen
        name="name"
        options={{
          title: t('nameEdit.title'),
          headerLeft: () => <HeaderLeft/>,
          headerRight: () => null,
        }}
      />
      <Stack.Screen
        name="language"
        options={{
          title: t('language.title'),
          headerLeft: () => <HeaderLeft/>,
          headerRight: () => null,
        }}
      />
      <Stack.Screen
        name="theme"
        options={{
          title: t('theme.title'),
          headerLeft: () => <HeaderLeft/>,
          headerRight: () => null,
        }}
      />
      <Stack.Screen
        name="beta"
        options={{
          title: t('beta.title'),
          headerLeft: () => <HeaderLeft/>,
          headerRight: () => null,
        }}
      />
      <Stack.Screen
        name="account-deletion"
        options={{
          title: t('accountDeletion.title'),
          headerLeft: () => <HeaderLeft/>,
          headerRight: () => null,
        }}
      />
    </Stack>
  );
}

