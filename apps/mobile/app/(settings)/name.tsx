import * as React from 'react';
import { View, TextInput, Alert, Keyboard, ScrollView } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { Pressable } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useAuthContext, useLanguage } from '@/contexts';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Save, Mail, AlertTriangle } from 'lucide-react-native';
import { supabase } from '@/api/supabase';
import * as Haptics from 'expo-haptics';
import { KortixLoader } from '@/components/ui';
import { ProfilePicture } from '@/components/settings/ProfilePicture';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { log } from '@/lib/logger';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function NameEditScreen() {
  const { colorScheme } = useColorScheme();
  const { user } = useAuthContext();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const currentName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || '';
  const [name, setName] = React.useState(currentName);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const validateName = (name: string): string | null => {
    if (!name.trim()) {
      return t('nameEdit.nameRequired');
    }
    if (name.length > 100) {
      return t('nameEdit.nameTooLong');
    }
    return null;
  };

  const handleSave = async () => {
    log.log('🎯 Save name pressed');

    const trimmedName = name.trim();
    const validationError = validateName(trimmedName);

    if (validationError) {
      setError(validationError);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    if (trimmedName === currentName) {
      router.back();
      return;
    }

    setIsLoading(true);
    setError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      log.log('📝 Updating user name');

      const { data: updatedUser, error: updateError } = await supabase.auth.updateUser({
        data: {
          full_name: trimmedName,
        },
      });

      if (updateError) {
        throw updateError;
      }

      log.log('✅ Name updated successfully:', updatedUser);

      try {
        await supabase.rpc('update_account', {
          name: trimmedName,
          account_id: user?.id,
        });
        log.log('✅ Account table also updated');
      } catch (rpcError) {
        log.warn('⚠️ RPC update failed (may not exist):', rpcError);
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Keyboard.dismiss();
      router.back();

      setTimeout(() => {
        Alert.alert(t('common.success'), t('nameEdit.nameUpdated'));
      }, 300);
    } catch (err: any) {
      log.error('❌ Failed to update name:', err);
      const errorMessage = err.message || t('nameEdit.failedToUpdate');
      setError(errorMessage);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);

      Alert.alert(t('common.error'), errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const hasChanges = name.trim() !== currentName && name.trim().length > 0;

  return (
    <ScrollView
      className="flex-1 bg-background"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
      keyboardShouldPersistTaps="handled"
    >
      <View className="px-6 pb-8">
        <View className="mb-8 items-center pt-8">
          <ProfilePicture
            imageUrl={user?.user_metadata?.avatar_url}
            size={24}
            fallbackText={name || user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User'}
          />
          <View className="mt-6 w-full">
            <TextInput
              value={name}
              onChangeText={(text) => {
                setName(text);
                setError(null);
              }}
              placeholder={t('nameEdit.yourNamePlaceholder')}
              placeholderTextColor={colorScheme === 'dark' ? '#71717A' : '#A1A1AA'}
              className="text-3xl font-roobert-semibold text-foreground text-center tracking-tight"
              editable={!isLoading}
              maxLength={100}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleSave}
            />
            <Text className="text-sm font-roobert text-muted-foreground text-center mt-2">
              {t('nameEdit.displayName')}
            </Text>
          </View>
        </View>

        {error && (
          <View className="bg-destructive/10 border border-destructive/20 rounded-2xl p-4 mb-6">
            <View className="flex-row items-start gap-2">
              <Icon as={AlertTriangle} size={16} className="text-destructive mt-0.5" strokeWidth={2} />
              <Text className="text-sm font-roobert-medium text-destructive flex-1">{error}</Text>
            </View>
          </View>
        )}

        <View className="mb-6">
          <View className="bg-primary/5 rounded-3xl p-5">
            <View className="flex-row items-center gap-3">
              <View className="h-11 w-11 rounded-full bg-primary/10 items-center justify-center">
                <Icon as={Mail} size={20} className="text-primary" strokeWidth={2.5} />
              </View>
              <View className="flex-1">
                <Text className="text-xs font-roobert-medium text-muted-foreground mb-1">
                  {t('nameEdit.emailAddress')}
                </Text>
                <Text className="text-sm font-roobert-semibold text-foreground">
                  {user?.email || t('nameEdit.notAvailable')}
                </Text>
              </View>
            </View>
          </View>
        </View>

        {(hasChanges || isLoading) && (
          <SaveButton
            onPress={handleSave}
            disabled={!hasChanges || isLoading}
            isLoading={isLoading}
          />
        )}
      </View>
    </ScrollView>
  );
}

interface SaveButtonProps {
  onPress: () => void;
  disabled?: boolean;
  isLoading?: boolean;
}

function SaveButton({ onPress, disabled, isLoading }: SaveButtonProps) {
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    if (!disabled) {
      scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
    }
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
      disabled={disabled}
      className={`rounded-full items-center justify-center flex-row gap-2 px-6 py-4 ${
        disabled ? 'bg-muted/50' : 'bg-primary'
      }`}
    >
      {isLoading ? (
        <>
          <KortixLoader size="small" forceTheme={colorScheme === 'dark' ? 'dark' : 'light'} />
          <Text className="text-primary-foreground text-sm font-roobert-medium">
            {t('nameEdit.saving')}
          </Text>
        </>
      ) : (
        <>
          <Icon as={Save} size={16} className="text-primary-foreground" strokeWidth={2.5} />
          <Text className="text-primary-foreground text-sm font-roobert-medium">
            {t('nameEdit.saveChanges')}
          </Text>
        </>
      )}
    </AnimatedPressable>
  );
}
