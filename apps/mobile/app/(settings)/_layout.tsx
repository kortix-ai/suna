import { Stack, useRouter } from 'expo-router';
import { Platform, Pressable, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/icon';
import { ArrowLeft } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useLanguage } from '@/contexts';
import * as Haptics from 'expo-haptics';

function SettingsIndexHeader({ title }: { title: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const topPadding = Math.max(insets.top, 16) + 32;

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  return (
    <View
      className="px-6 pb-6 flex-row items-center gap-3 bg-background"
      style={{ paddingTop: topPadding }}
    >
      <Pressable
        onPress={handlePress}
        className="w-8 h-8 items-center justify-center"
        hitSlop={8}
      >
        <Icon
          as={ArrowLeft}
          size={24}
          className="text-foreground"
          strokeWidth={2}
        />
      </Pressable>
      <Text className="text-xl font-roobert-medium text-foreground tracking-tight">
        {title}
      </Text>
    </View>
  );
}

function SubpageHeader({ title }: { title: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const topPadding = Math.max(insets.top, 16) + 32;

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  return (
    <View
      className="px-6 pb-6 flex-row items-center gap-3 bg-background"
      style={{ paddingTop: topPadding }}
    >
      <Pressable
        onPress={handlePress}
        className="w-8 h-8 items-center justify-center"
        hitSlop={8}
      >
        <Icon
          as={ArrowLeft}
          size={24}
          className="text-foreground"
          strokeWidth={2}
        />
      </Pressable>
      <Text className="text-xl font-roobert-medium text-foreground tracking-tight">
        {title}
      </Text>
    </View>
  );
}

export default function SettingsLayout() {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();

  // Match the theme background colors from global.css
  // Light: #F6F6F6, Dark: #121215
  const backgroundColor = colorScheme === 'dark' ? '#121215' : '#F6F6F6';

  return (
    <Stack
      screenOptions={{
        headerShown: false, // We use custom headers
        animation: Platform.OS === 'ios' ? 'default' : 'slide_from_right',
        presentation: 'card',
        contentStyle: {
          backgroundColor,
        },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          header: () => <SettingsIndexHeader title={t('settings.title')} />,
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="name"
        options={{
          header: () => <SubpageHeader title={t('nameEdit.title')} />,
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="language"
        options={{
          header: () => <SubpageHeader title={t('language.title')} />,
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="theme"
        options={{
          header: () => <SubpageHeader title={t('theme.title')} />,
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="beta"
        options={{
          header: () => <SubpageHeader title={t('beta.title')} />,
          headerShown: true,
        }}
      />
      <Stack.Screen
        name="account-deletion"
        options={{
          header: () => <SubpageHeader title={t('accountDeletion.title')} />,
          headerShown: true,
        }}
      />
    </Stack>
  );
}
