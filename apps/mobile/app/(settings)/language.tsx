import * as React from 'react';
import { Pressable, View, ScrollView } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Check } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { log } from '@/lib/logger';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const LANGUAGE_FLAGS: Record<string, string> = {
  en: '🇺🇸',
  es: '🇪🇸',
  fr: '🇫🇷',
  de: '🇩🇪',
  it: '🇮🇹',
  pt: '🇧🇷',
  zh: '🇨🇳',
  ja: '🇯🇵',
};

export default function LanguageScreen() {
  const { currentLanguage, availableLanguages, setLanguage, t } = useLanguage();
  const insets = useSafeAreaInsets();

  const handleLanguageSelect = async (languageCode: string) => {
    log.log('🌍 Language selected:', languageCode);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await setLanguage(languageCode);
  };

  return (
    <ScrollView
      className="flex-1 bg-background"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
    >
      <View className="px-6 pt-4 pb-8">
        <View className="mb-3">
          <Text className="text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
            {t('language.selectLanguage')}
          </Text>
        </View>

        <View className="gap-3">
          {availableLanguages.map((language) => (
            <LanguageItem
              key={language.code}
              language={language}
              isSelected={currentLanguage === language.code}
              onPress={() => handleLanguageSelect(language.code)}
            />
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

interface LanguageItemProps {
  language: {
    code: string;
    name: string;
    nativeName: string;
  };
  isSelected: boolean;
  onPress: () => void;
}

function LanguageItem({ language, isSelected, onPress }: LanguageItemProps) {
  const scale = useSharedValue(1);
  const flag = LANGUAGE_FLAGS[language.code] || '🌐';

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className="bg-primary/5 rounded-3xl p-4 active:opacity-80"
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-3 flex-1">
          <View className="h-10 w-10 rounded-full items-center justify-center">
            <Text className="text-2xl">{flag}</Text>
          </View>
          <View className="flex-1">
            <Text className="text-sm font-roobert-semibold text-foreground mb-0.5">
              {language.nativeName}
            </Text>
            <Text className="text-xs font-roobert text-muted-foreground">{language.name}</Text>
          </View>
        </View>

        {isSelected && (
          <View className="ml-2 h-5 w-5 items-center justify-center rounded-full bg-primary">
            <Icon as={Check} size={12} className="text-primary-foreground" strokeWidth={3} />
          </View>
        )}
      </View>
    </AnimatedPressable>
  );
}
