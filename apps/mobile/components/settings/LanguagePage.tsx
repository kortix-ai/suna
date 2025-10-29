import * as React from 'react';
import { Pressable, View, ScrollView } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Check, Globe } from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import * as Haptics from 'expo-haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface LanguagePageProps {
  visible: boolean;
  onClose: () => void;
}

/**
 * LanguagePage Component
 * 
 * Clean language selector page matching Settings style.
 * 
 * Features:
 * - List of all available languages
 * - Shows native language names
 * - Visual indicator for selected language
 * - Smooth animations
 * - Haptic feedback
 */
export function LanguagePage({ visible, onClose }: LanguagePageProps) {
  const { currentLanguage, availableLanguages, setLanguage, t } = useLanguage();
  
  const handleLanguageSelect = async (languageCode: string) => {
    console.log('🌍 Language selected:', languageCode);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    
    await setLanguage(languageCode);
    
    // Close page after a short delay
    setTimeout(() => {
      onClose();
    }, 300);
  };
  
  const handleClose = () => {
    console.log('🎯 Language page closing');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };
  
  if (!visible) return null;
  
  return (
    <View className="absolute inset-0 z-50">
      {/* Simple Backdrop */}
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      
      {/* Page */}
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
          {/* Header */}
          <SettingsHeader
            title={t('languages.title')}
            onClose={handleClose}
          />
          
          {/* Language List */}
          <View className="px-6">
            {availableLanguages.map((language) => (
              <LanguageItem
                key={language.code}
                language={language}
                isSelected={currentLanguage === language.code}
                onPress={() => handleLanguageSelect(language.code)}
              />
            ))}
          </View>
          
          <View className="h-20" />
        </ScrollView>
      </View>
    </View>
  );
}

/**
 * LanguageItem Component
 * 
 * Clean language list item with native name and selection indicator.
 */
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
      className="flex-row items-center justify-between py-4"
    >
      <View className="flex-row items-center gap-3">
        <View className={`w-10 h-10 rounded-full items-center justify-center ${
          isSelected ? 'bg-primary/10' : 'bg-secondary/50'
        }`}>
          <Icon 
            as={Globe} 
            size={20} 
            className={isSelected ? 'text-primary' : 'text-foreground/40'} 
            strokeWidth={2} 
          />
        </View>
        <View>
          <Text className="text-base font-roobert-medium text-foreground">
            {language.nativeName}
          </Text>
          <Text className="text-sm font-roobert text-muted-foreground">
            {language.name}
          </Text>
        </View>
      </View>
      
      {isSelected && (
        <Icon as={Check} size={20} className="text-primary" strokeWidth={2.5} />
      )}
    </AnimatedPressable>
  );
}

