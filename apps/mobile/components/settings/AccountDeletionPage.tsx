import * as React from 'react';
import { Pressable, View, Alert, ScrollView, ActivityIndicator, TextInput } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Trash2, Calendar, XCircle } from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import * as Haptics from 'expo-haptics';
import { 
  useAccountDeletionStatus, 
  useRequestAccountDeletion, 
  useCancelAccountDeletion 
} from '@/hooks/useAccountDeletion';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface AccountDeletionPageProps {
  visible: boolean;
  onClose: () => void;
}

export function AccountDeletionPage({ visible, onClose }: AccountDeletionPageProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { data: deletionStatus, isLoading: isCheckingStatus } = useAccountDeletionStatus();
  const requestDeletion = useRequestAccountDeletion();
  const cancelDeletion = useCancelAccountDeletion();
  const [confirmText, setConfirmText] = React.useState('');

  React.useEffect(() => {
    if (visible) {
      setConfirmText('');
    }
  }, [visible]);

  const handleClose = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setConfirmText('');
    onClose();
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return '';
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const handleRequestDeletion = async () => {
    if (confirmText !== 'DELETE') {
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      await requestDeletion.mutateAsync('User requested deletion from mobile');
      
      setConfirmText('');
      
      Alert.alert(
        'Deletion Scheduled',
        'Your account will be deleted in 30 days. You can cancel this request anytime.',
        [{ 
          text: 'OK',
          onPress: handleClose
        }]
      );
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to request account deletion');
    }
  };

  const handleCancelDeletion = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    Alert.alert(
      'Cancel Account Deletion',
      'Do you want to cancel the deletion of your account? Your account and all data will be preserved.',
      [
        {
          text: 'Back',
          style: 'cancel',
        },
        {
          text: 'Cancel Deletion',
          onPress: async () => {
            try {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              await cancelDeletion.mutateAsync();
              
              Alert.alert(
                'Deletion Cancelled',
                'Your account is safe. The deletion has been cancelled.',
                [{ text: 'OK' }]
              );
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to cancel account deletion');
            }
          },
        },
      ]
    );
  };

  if (!visible) return null;

  const hasPendingDeletion = deletionStatus?.has_pending_deletion;
  const isLoading = requestDeletion.isPending || cancelDeletion.isPending || isCheckingStatus;

  return (
    <View className="absolute inset-0 z-50">
      <Pressable
        onPress={handleClose}
        className="absolute inset-0 bg-black/50"
      />

      <View className="absolute top-0 left-0 right-0 bottom-0 bg-background">
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
          <SettingsHeader
            title="Delete Account"
            onClose={handleClose}
            disabled={isLoading}
          />

          <View className="px-6 gap-6 pb-6">
            {hasPendingDeletion ? (
              <>
                <View className="mt-2">
                  <View className="bg-secondary/50 rounded-2xl p-5">
                    <View className="flex-row items-center gap-3 mb-4">
                      <Icon as={Calendar} size={20} className="text-foreground/60" strokeWidth={2} />
                      <Text className="text-lg font-roobert-semibold text-foreground">
                        Deletion Scheduled
                      </Text>
                    </View>
                    
                    <Text className="text-sm font-roobert text-muted-foreground mb-3">
                      Your account and all data will be permanently deleted on:
                    </Text>
                    
                    <Text className="text-base font-roobert-semibold text-foreground mb-4">
                      {formatDate(deletionStatus?.deletion_scheduled_for)}
                    </Text>
                    
                    <Text className="text-sm font-roobert text-muted-foreground">
                      You can cancel this request anytime before the deletion date.
                    </Text>
                  </View>
                </View>

                <ActionButton
                  onPress={handleCancelDeletion}
                  disabled={isLoading}
                  isLoading={cancelDeletion.isPending}
                  icon={XCircle}
                  label="Cancel Deletion"
                />
              </>
            ) : (
              <>
                <View className="mt-2">
                  <Text className="text-base font-roobert text-foreground mb-6 leading-6">
                    Permanently delete your account and all associated data. This action cannot be undone.
                  </Text>
                  
                  <View className="bg-secondary/50 rounded-2xl p-5 mb-6">
                    <Text className="text-sm font-roobert-medium text-foreground mb-3">
                      What will be deleted:
                    </Text>
                    
                    <View className="gap-2.5">
                      <BulletPoint text="All your agents and agent versions" />
                      <BulletPoint text="All your threads and conversations" />
                      <BulletPoint text="All your credentials and integrations" />
                      <BulletPoint text="Your subscription and billing data" />
                    </View>
                    
                    <View className="mt-4 pt-4 border-t border-foreground/10">
                      <Text className="text-xs font-roobert text-muted-foreground leading-5">
                        Your account will be scheduled for deletion in 30 days. You can cancel this request anytime during the grace period.
                      </Text>
                    </View>
                  </View>
                </View>

                <View>
                  <Text className="text-sm font-roobert-medium text-foreground mb-3">
                    Type <Text className="font-roobert-semibold">DELETE</Text> to confirm
                  </Text>
                  <TextInput
                    value={confirmText}
                    onChangeText={(text) => setConfirmText(text.toUpperCase())}
                    placeholder="DELETE"
                    placeholderTextColor={colorScheme === 'dark' ? '#71717A' : '#A1A1AA'}
                    className="h-14 px-4 bg-secondary rounded-2xl text-foreground font-roobert-medium text-base tracking-wide"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    returnKeyType="done"
                  />
                </View>

                <ActionButton
                  onPress={handleRequestDeletion}
                  disabled={isLoading || confirmText !== 'DELETE'}
                  isLoading={requestDeletion.isPending}
                  icon={Trash2}
                  label="Delete Account"
                />
              </>
            )}
          </View>

          <View className="h-40" />
        </ScrollView>
      </View>
    </View>
  );
}

function BulletPoint({ text }: { text: string }) {
  return (
    <View className="flex-row items-start gap-3">
      <View className="w-1.5 h-1.5 rounded-full bg-foreground/40 mt-2" />
      <Text className="text-sm font-roobert text-foreground/70 flex-1 leading-5">
        {text}
      </Text>
    </View>
  );
}

interface ActionButtonProps {
  onPress: () => void;
  disabled: boolean;
  isLoading: boolean;
  icon: any;
  label: string;
}

function ActionButton({ onPress, disabled, isLoading, icon, label }: ActionButtonProps) {
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
    : 'bg-primary';

  const textColor = disabled
    ? 'text-muted-foreground'
    : 'text-primary-foreground';

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
          color={colorScheme === 'dark' ? '#FFFFFF' : '#121215'} 
        />
      ) : (
        <Icon 
          as={icon} 
          size={20} 
          className={textColor} 
          strokeWidth={2} 
        />
      )}
      <Text className={`${textColor} text-base font-roobert-medium`}>
        {isLoading ? 'Processing...' : label}
      </Text>
    </AnimatedPressable>
  );
}

