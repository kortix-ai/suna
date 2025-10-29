import * as React from 'react';
import { Pressable, View, TextInput, ActivityIndicator, Alert, Keyboard } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { useAuthContext, useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Save } from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import { supabase } from '@/api/supabase';
import * as Haptics from 'expo-haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface NameEditPageProps {
  visible: boolean;
  currentName: string;
  onClose: () => void;
  onNameUpdated?: (newName: string) => void;
}

/**
 * NameEditPage Component
 * 
 * Clean, elegant page for editing user name.
 * 
 * Features:
 * - Full-screen overlay with backdrop
 * - Text input with current name pre-filled
 * - Save/Cancel buttons
 * - Input validation (non-empty, max length)
 * - Loading state during save
 * - Error handling with user feedback
 * - Uses Supabase RPC call to update account name
 */
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
  
  // Reset name when page opens
  React.useEffect(() => {
    if (visible) {
      setName(currentName);
      setError(null);
      // Focus input after a short delay
      setTimeout(() => {
        inputRef.current?.focus();
      }, 300);
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
      return t('settings.nameRequired') || 'Name is required';
    }
    if (name.length > 100) {
      return 'Name is too long (max 100 characters)';
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
          t('common.success') || 'Success',
          t('settings.nameUpdated') || 'Your name has been updated successfully'
        );
      }, 300);
    } catch (err: any) {
      console.error('❌ Failed to update name:', err);
      const errorMessage = err.message || 'Failed to update name. Please try again.';
      setError(errorMessage);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      
      Alert.alert(
        t('common.error') || 'Error',
        errorMessage
      );
    } finally {
      setIsLoading(false);
    }
  };
  
  if (!visible) return null;
  
  return (
    <View className="absolute inset-0 z-50">
      {/* Backdrop */}
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />
      
      {/* Page */}
      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <View className="flex-1">
          {/* Header */}
          <SettingsHeader
            title={t('settings.editName') || 'Edit Name'}
            onClose={handleClose}
            disabled={isLoading}
          />
          
          {/* Form */}
          <View className="px-6 gap-6">
            {/* Label */}
            <View>
              <Text className="text-sm font-roobert-medium text-muted-foreground mb-2">
                {t('settings.enterName') || 'Enter your name'}
              </Text>
              
              {/* Input */}
              <TextInput
                ref={inputRef}
                value={name}
                onChangeText={(text) => {
                  setName(text);
                  setError(null);
                }}
                placeholder={t('settings.namePlaceholder') || 'Your name'}
                placeholderTextColor={colorScheme === 'dark' ? '#71717A' : '#A1A1AA'}
                className="h-12 px-4 bg-secondary rounded-2xl text-foreground font-roobert text-base"
                editable={!isLoading}
                maxLength={100}
                autoCapitalize="words"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={handleSave}
              />
              
              {/* Error Message */}
              {error && (
                <Text className="text-destructive text-sm font-roobert mt-2">
                  {error}
                </Text>
              )}
            </View>
            
            {/* Save Button */}
            <SaveButton
              onPress={handleSave}
              disabled={isLoading || !name.trim()}
              isLoading={isLoading}
            />
          </View>
          
        </View>
      </View>
    </View>
  );
}

/**
 * SaveButton Component
 */
interface SaveButtonProps {
  onPress: () => void;
  disabled: boolean;
  isLoading: boolean;
}

function SaveButton({ onPress, disabled, isLoading }: SaveButtonProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  
  const handlePressIn = () => {
    if (!disabled) {
      scale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
    }
  };
  
  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };
  
  const bgColor = disabled 
    ? 'bg-muted' 
    : colorScheme === 'dark' ? 'bg-primary' : 'bg-primary';
  
  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      disabled={disabled}
      className={`h-12 rounded-2xl items-center justify-center flex-row gap-2 ${bgColor}`}
    >
      {isLoading ? (
        <ActivityIndicator 
          size="small" 
          color={colorScheme === 'dark' ? '#121215' : '#FFFFFF'} 
        />
      ) : (
        <Icon 
          as={Save} 
          size={20} 
          className="text-primary-foreground" 
          strokeWidth={2} 
        />
      )}
      <Text className="text-primary-foreground text-base font-roobert-medium">
        {isLoading 
          ? (t('common.saving') || 'Saving...') 
          : (t('common.save') || 'Save')
        }
      </Text>
    </AnimatedPressable>
  );
}

