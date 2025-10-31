import * as React from 'react';
import { Pressable, View, Alert, ScrollView, ActivityIndicator } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Trash2, AlertTriangle, Calendar, XCircle } from 'lucide-react-native';
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
  const { data: deletionStatus, isLoading: isCheckingStatus } = useAccountDeletionStatus();
  const requestDeletion = useRequestAccountDeletion();
  const cancelDeletion = useCancelAccountDeletion();

  const handleClose = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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

  const handleRequestDeletion = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    Alert.alert(
      'Delete Account',
      'Are you sure you want to delete your account? All your data will be permanently deleted after 30 days. You can cancel anytime within this period.',
      [
        {
          text: 'Keep Account',
          style: 'cancel',
        },
        {
          text: 'Delete Account',
          style: 'destructive',
          onPress: async () => {
            try {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              await requestDeletion.mutateAsync('User requested deletion from mobile');
              
              Alert.alert(
                'Deletion Scheduled',
                'Your account will be deleted in 30 days. You can cancel this request anytime.',
                [{ text: 'OK' }]
              );
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to request account deletion');
            }
          },
        },
      ]
    );
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

          <View className="px-6 gap-6">
            {hasPendingDeletion ? (
              <>
                <View className="bg-destructive/10 border border-destructive/20 rounded-2xl p-4">
                  <View className="flex-row items-center gap-3 mb-3">
                    <Icon as={AlertTriangle} size={24} className="text-destructive" strokeWidth={2} />
                    <Text className="text-lg font-roobert-semibold text-destructive">
                      Account Deletion Scheduled
                    </Text>
                  </View>
                  
                  <Text className="text-sm font-roobert text-foreground mb-2">
                    Your account and all data will be permanently deleted on:
                  </Text>
                  
                  <View className="flex-row items-center gap-2 mb-3">
                    <Icon as={Calendar} size={16} className="text-foreground/60" strokeWidth={2} />
                    <Text className="text-base font-roobert-semibold text-foreground">
                      {formatDate(deletionStatus?.deletion_scheduled_for)}
                    </Text>
                  </View>
                  
                  <Text className="text-sm font-roobert text-muted-foreground">
                    You can cancel this request anytime before the deletion date.
                  </Text>
                </View>

                <ActionButton
                  onPress={handleCancelDeletion}
                  disabled={isLoading}
                  isLoading={cancelDeletion.isPending}
                  variant="default"
                  icon={XCircle}
                  label="Cancel Deletion"
                />
              </>
            ) : (
              <>
                <View className="bg-destructive/10 border border-destructive/20 rounded-2xl p-4">
                  <View className="flex-row items-center gap-3 mb-3">
                    <Icon as={AlertTriangle} size={24} className="text-destructive" strokeWidth={2} />
                    <Text className="text-lg font-roobert-semibold text-destructive">
                      Danger Zone
                    </Text>
                  </View>
                  
                  <Text className="text-sm font-roobert text-foreground mb-3">
                    Permanently delete your account and all associated data.
                  </Text>
                  
                  <Text className="text-sm font-roobert-medium text-foreground mb-2">
                    When you delete your account:
                  </Text>
                  
                  <View className="gap-2">
                    <BulletPoint text="All your agents and agent versions will be deleted" />
                    <BulletPoint text="All your threads and conversations will be deleted" />
                    <BulletPoint text="All your credentials and integrations will be removed" />
                    <BulletPoint text="Your subscription will be cancelled" />
                    <BulletPoint text="All billing data will be removed" />
                    <BulletPoint text="Your account will be scheduled for deletion in 30 days" />
                  </View>
                  
                  <View className="bg-background/50 rounded-xl p-3 mt-4">
                    <Text className="text-sm font-roobert text-muted-foreground">
                      You can cancel this request anytime within the 30-day grace period. After 30 days, all your data will be permanently deleted and cannot be recovered.
                    </Text>
                  </View>
                </View>

                <ActionButton
                  onPress={handleRequestDeletion}
                  disabled={isLoading}
                  isLoading={requestDeletion.isPending}
                  variant="destructive"
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
    <View className="flex-row items-start gap-2">
      <Text className="text-foreground/60 text-sm font-roobert mt-0.5">•</Text>
      <Text className="text-sm font-roobert text-foreground/80 flex-1">
        {text}
      </Text>
    </View>
  );
}

interface ActionButtonProps {
  onPress: () => void;
  disabled: boolean;
  isLoading: boolean;
  variant: 'destructive' | 'default';
  icon: any;
  label: string;
}

function ActionButton({ onPress, disabled, isLoading, variant, icon, label }: ActionButtonProps) {
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
    : variant === 'destructive'
    ? 'bg-destructive'
    : 'bg-primary';

  const textColor = disabled
    ? 'text-muted-foreground'
    : variant === 'destructive'
    ? 'text-destructive-foreground'
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
          color={colorScheme === 'dark' ? '#FFFFFF' : '#000000'} 
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

