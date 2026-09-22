import * as React from 'react';
import { View, Alert, Keyboard, ScrollView } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useAuthContext, useLanguage } from '@/contexts';
import { useRouter } from 'expo-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { FloppyDiskIcon as Save, EnvelopeIcon as Mail, WarningIcon as AlertTriangle } from '@/lib/icons';
import { supabase } from '@/api/supabase';
import { haptics } from '@/lib/haptics';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { ProfilePicture } from '@/components/settings/ProfilePicture';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { log } from '@/lib/logger';

export default function NameEditScreen() {
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
      haptics.warning();
      return;
    }

    if (trimmedName === currentName) {
      router.back();
      return;
    }

    setIsLoading(true);
    setError(null);
    haptics.tap();

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

      haptics.success();
      Keyboard.dismiss();
      router.back();

      setTimeout(() => {
        Alert.alert(t('common.success'), t('nameEdit.nameUpdated'));
      }, 300);
    } catch (err: any) {
      log.error('❌ Failed to update name:', err);
      const errorMessage = err.message || t('nameEdit.failedToUpdate');
      setError(errorMessage);
      haptics.warning();

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
      <View className="px-4 pb-8">
        <View className="mb-6 items-center pt-3">
          <ProfilePicture
            imageUrl={user?.user_metadata?.avatar_url}
            size={16}
            fallbackText={name || user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User'}
          />
          <View className="mt-4 w-full">
            <Input
              value={name}
              onChangeText={(text) => {
                setName(text);
                setError(null);
              }}
              placeholder={t('nameEdit.yourNamePlaceholder')}
              className="h-auto bg-transparent px-0 py-0 text-center text-[34px] font-roobert-semibold tracking-tight"
              editable={!isLoading}
              maxLength={100}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={handleSave}
            />
            <Text className="text-xs font-roobert text-muted-foreground text-center mt-1.5">
              {t('nameEdit.displayName')}
            </Text>
          </View>
        </View>

        {error && (
          <View className="bg-destructive/10 border border-destructive/20 rounded-2xl p-4 mb-6">
            <View className="flex-row items-start gap-2">
              <Icon as={AlertTriangle} size={16} className="text-destructive mt-0.5" />
              <Text className="text-sm font-roobert-medium text-destructive flex-1">{error}</Text>
            </View>
          </View>
        )}

        <View className="mb-6">
          <View className="bg-card/70 rounded-3xl border border-border/40 p-4">
            <View className="flex-row items-center gap-3">
              <Icon as={Mail} size={18} className="text-foreground/70" />
              <View className="flex-1">
                <Text className="text-xs font-roobert-medium text-muted-foreground mb-1">
                  {t('nameEdit.emailAddress')}
                </Text>
                <Text className="text-[15px] font-roobert-medium text-foreground">
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

  return (
    <Button size="lg" className="rounded-full" disabled={disabled} onPress={onPress}>
      {isLoading ? (
        <>
          <KortixLoader size="small" forceTheme={colorScheme === 'dark' ? 'dark' : 'light'} />
          <Text>{t('nameEdit.saving')}</Text>
        </>
      ) : (
        <>
          <Icon as={Save} size={16} className="text-primary-foreground" />
          <Text>{t('nameEdit.saveChanges')}</Text>
        </>
      )}
    </Button>
  );
}
