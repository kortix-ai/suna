import * as React from 'react';
import { Pressable, View, TextInput, Alert, Keyboard, ScrollView } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { useAuthContext, useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Save, Mail, AlertTriangle } from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import { supabase } from '@/api/supabase';
import * as Haptics from 'expo-haptics';
import { KortixLoader } from '@/components/ui';
import { ProfilePicture } from './ProfilePicture';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
export const placeholderImageUrl = 'https://i.ibb.co/ksprrY46/Screenshot-2025-11-12-at-2-28-27-AM.png';
  
interface NameEditPageProps {
  visible: boolean;
  currentName: string;
  onClose: () => void;
  onNameUpdated?: (newName: string) => void;
}

export function NameEditPage({ 
  visible, 
  currentName, 
  onClose,
  onNameUpdated 
}: NameEditPageProps) {
  const { colorScheme } = useColorScheme();
  const { user } = useAuthContext();
  const { t } = useLanguage();
  
  const [name, setName] = React.useState(currentName);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<TextInput>(null);
  

  React.useEffect(() => {
    if (visible) {
      setName(currentName);
      setError(null);
    }
  }, [visible, currentName]);
  
  const handleClose = () => {
    console.log('🎯 Name edit page closing');
    Keyboard.dismiss();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };
  
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
    console.log('🎯 Save name pressed');
    
    const trimmedName = name.trim();
    const validationError = validateName(trimmedName);
    
    if (validationError) {
      setError(validationError);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    
    // Check if name changed
    if (trimmedName === currentName) {
      handleClose();
      return;
    }
    
    setIsLoading(true);
    setError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    try {
      console.log('📝 Updating user name');
      console.log('User ID:', user?.id);
      console.log('New name:', trimmedName);
      
      // Update user metadata using Supabase Auth
      const { data: updatedUser, error: updateError } = await supabase.auth.updateUser({
        data: {
          full_name: trimmedName,
        }
      });
      
      if (updateError) {
        throw updateError;
      }
      
      console.log('✅ Name updated successfully:', updatedUser);
      
      // Try to update the account table via RPC if it exists
      try {
        await supabase.rpc('update_account', {
          name: trimmedName,
          account_id: user?.id
        });
        console.log('✅ Account table also updated');
      } catch (rpcError) {
        console.warn('⚠️ RPC update failed (may not exist):', rpcError);
        // Ignore RPC errors - not all setups have this function
      }
      
      // Notify parent component
      onNameUpdated?.(trimmedName);
      
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      
      // Close page first
      handleClose();
      
      // Show success message after a short delay
      setTimeout(() => {
        Alert.alert(
          t('common.success'),
          t('nameEdit.nameUpdated')
        );
      }, 300);
    } catch (err: any) {
      console.error('❌ Failed to update name:', err);
      const errorMessage = err.message || t('nameEdit.failedToUpdate');
      setError(errorMessage);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      
      Alert.alert(
        t('common.error'),
        errorMessage
      );
    } finally {
      setIsLoading(false);
    }
  };
  
  if (!visible) return null;

  const hasChanges = name.trim() !== currentName && name.trim().length > 0;
  
  return (
    <View className="absolute inset-0 z-50">
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <ScrollView 
          className="flex-1"
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
          keyboardShouldPersistTaps="handled"
        >
          <SettingsHeader
            title={t('nameEdit.title')}
            onClose={handleClose}
            disabled={isLoading}
          />
          
          <View className="px-6 pb-8">
            <View className="mb-8 items-center pt-8">
              <ProfilePicture imageUrl={placeholderImageUrl} size={24} />
              <View className="mt-6 w-full">
                <TextInput
                  ref={inputRef}
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
                  <Text className="text-sm font-roobert-medium text-destructive flex-1">
                    {error}
                  </Text>
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

            <SaveButton
              onPress={handleSave}
              disabled={!hasChanges || isLoading}
              isLoading={isLoading}
              hasChanges={hasChanges}
            />
          </View>

          <View className="h-20" />
        </ScrollView>
      </View>
    </View>
  );
}

interface SaveButtonProps {
  onPress: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  hasChanges?: boolean;
}

function SaveButton({ onPress, disabled, isLoading, hasChanges }: SaveButtonProps) {
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
  
  if (!hasChanges && !isLoading) {
    return null;
  }
  
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
          <KortixLoader 
            size="small" 
            forceTheme={colorScheme === 'dark' ? 'dark' : 'light'}
          />
          <Text className="text-primary-foreground text-sm font-roobert-medium">
            {t('nameEdit.saving')}
          </Text>
        </>
      ) : (
        <>
          <Icon 
            as={Save} 
            size={16} 
            className="text-primary-foreground" 
            strokeWidth={2.5} 
          />
          <Text className="text-primary-foreground text-sm font-roobert-medium">
            {t('nameEdit.saveChanges')}
          </Text>
        </>
      )}
    </AnimatedPressable>
  );
}
