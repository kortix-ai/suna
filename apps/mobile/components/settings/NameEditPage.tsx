import * as React from 'react';
import { Pressable, View, TextInput, Alert, Keyboard, ScrollView, Platform } from 'react-native';
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
import { supabase } from '@/api/supabase';
import * as Haptics from 'expo-haptics';
import { KortixLoader } from '@/components/ui';
import { ProfilePicture } from './ProfilePicture';
import { log } from '@/lib/logger';
import { getDrawerBackgroundColor, getPadding } from '@agentpress/shared';
import { isLiquidGlassAvailable, GlassView } from 'expo-glass-effect';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
  
interface NameEditPageProps {
  visible: boolean;
  currentName: string;
  onClose: () => void;
  onNameUpdated?: (newName: string) => void;
  isDrawer?: boolean;
}

export function NameEditPage({ 
  visible, 
  currentName, 
  onClose,
  onNameUpdated,
  isDrawer = false,
}: NameEditPageProps) {
  const { colorScheme } = useColorScheme();
  const { user } = useAuthContext();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  
  const [name, setName] = React.useState(currentName);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<TextInput>(null);
  
  const hasChanges = name.trim() !== currentName && name.trim().length > 0;

  React.useEffect(() => {
    if (visible) {
      setName(currentName);
      setError(null);
    }
  }, [visible, currentName]);
  
  const handleClose = () => {
    log.log('🎯 Name edit page closing');
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
    log.log('🎯 Save name pressed');
    
    const trimmedName = name.trim();
    const validationError = validateName(trimmedName);
    
    if (validationError) {
      setError(validationError);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    
    if (trimmedName === currentName) {
      handleClose();
      return;
    }
    
    setIsLoading(true);
    setError(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    try {
      log.log('📝 Updating user name');
      log.log('User ID:', user?.id);
      log.log('New name:', trimmedName);
      
      // Update user metadata using Supabase Auth
      const { data: updatedUser, error: updateError } = await supabase.auth.updateUser({
        data: {
          full_name: trimmedName,
        }
      });
      
      if (updateError) {
        throw updateError;
      }
      
      log.log('✅ Name updated successfully:', updatedUser);
      
      // Try to update the account table via RPC if it exists
      try {
        await supabase.rpc('update_account', {
          name: trimmedName,
          account_id: user?.id
        });
        log.log('✅ Account table also updated');
      } catch (rpcError) {
        log.warn('⚠️ RPC update failed (may not exist):', rpcError);
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
      log.error('❌ Failed to update name:', err);
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

  return (
    <View style={{ flex: 1, backgroundColor: getDrawerBackgroundColor(Platform.OS, colorScheme) }}>
      <ScrollView 
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews={true}
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
          </View>
          <View style={{ height: 80 }} />
          {hasChanges && (
          <View
            style={{
              position: 'absolute',
              bottom: insets.bottom + 24,
              left: 0,
              right: 0,
              alignItems: 'center',
              paddingHorizontal: getPadding(Platform.OS, 'lg'),
              pointerEvents: 'box-none',
            }}
          >
            <Pressable
              onPress={handleSave}
              disabled={isLoading}
            >
              {isLiquidGlassAvailable() && Platform.OS === 'ios' ? (
                <GlassView
                  glassEffectStyle="regular"
                  tintColor="rgba(0, 122, 255, 0.9)"
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 28,
                    paddingHorizontal: 24,
                    paddingVertical: 14,
                    minWidth: '100%',
                    gap: 8,
                  }}
                >
                  <Icon as={Save} size={20} className='text-white' strokeWidth={2.5} style={{ zIndex: 2000 }} />
                  <Text
                    style={{
                      fontSize: 17,
                      fontWeight: '600',
                      color: 'white',
                      zIndex: 2000,
                    }}
                  >
                    {t('common.save', 'Save')}
                  </Text>
                </GlassView>
              ) : (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: '#007AFF',
                    borderRadius: 28,
                    paddingHorizontal: 24,
                    paddingVertical: 14,
                    minWidth: 120,
                    gap: 8,
                    shadowColor: '#007AFF',
                    shadowOffset: { width: 0, height: 4 },
                    shadowOpacity: 0.3,
                    shadowRadius: 8,
                    elevation: 8,
                  }}
                >
                  <Icon as={Save} size={20} color="#FFFFFF" strokeWidth={2.5} />
                  <Text
                    style={{
                      fontSize: 17,
                      fontWeight: '600',
                      color: '#FFFFFF',
                    }}
                  >
                    {t('common.save', 'Save')}
                  </Text>
                </View>
              )}
            </Pressable>
          </View>
        )}
        </ScrollView>
    </View>
  );
}