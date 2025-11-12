import * as React from 'react';
import { Pressable, View, Alert, ScrollView, TextInput } from 'react-native';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring 
} from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Trash2, Calendar, XCircle, AlertTriangle, CheckCircle } from 'lucide-react-native';
import { SettingsHeader } from './SettingsHeader';
import * as Haptics from 'expo-haptics';
import { KortixLoader } from '@/components/ui';
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

  const handleClose = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setConfirmText('');
    onClose();
  }, [onClose]);

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
        <ScrollView 
          className="flex-1" 
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
          keyboardShouldPersistTaps="handled"
        >
          <SettingsHeader
            title="Delete Account"
            onClose={handleClose}
            disabled={isLoading}
          />

          <View className="px-6 pb-8">
            {hasPendingDeletion ? (
              <>
                <View className="mb-8 items-center pt-4">
                  <View className="mb-3 h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
                    <Icon as={Calendar} size={28} className="text-destructive" strokeWidth={2} />
                  </View>
                  <Text className="mb-1 text-2xl font-roobert-semibold text-foreground tracking-tight">
                    Deletion Scheduled
                  </Text>
                  <Text className="text-sm font-roobert text-muted-foreground text-center">
                    Your account will be permanently deleted
                  </Text>
                </View>

                <View className="mb-6">
                  <View className="bg-destructive/5 border border-destructive/20 rounded-3xl p-5">
                    <View className="flex-row items-center gap-3 mb-4">
                      <View className="h-11 w-11 rounded-full bg-destructive/10 items-center justify-center">
                        <Icon as={Calendar} size={20} className="text-destructive" strokeWidth={2.5} />
                      </View>
                      <View className="flex-1">
                        <Text className="text-xs font-roobert-medium text-muted-foreground mb-1">
                          Scheduled For
                        </Text>
                        <Text className="text-sm font-roobert-semibold text-foreground">
                          {formatDate(deletionStatus?.deletion_scheduled_for)}
                        </Text>
                      </View>
                    </View>
                    
                    <View className="pt-3 border-t border-destructive/20">
                      <Text className="text-sm font-roobert text-muted-foreground leading-5">
                        You can cancel this request anytime before the deletion date. All your data will be preserved if you cancel.
                      </Text>
                    </View>
                  </View>
                </View>

                <ActionButton
                  onPress={handleCancelDeletion}
                  disabled={isLoading}
                  isLoading={cancelDeletion.isPending}
                  icon={CheckCircle}
                  label="Cancel Deletion"
                  variant="primary"
                />
              </>
            ) : (
              <>
                <View className="mb-8 items-center pt-4">
                  <View className="mb-3 h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
                    <Icon as={Trash2} size={28} className="text-destructive" strokeWidth={2} />
                  </View>
                  <Text className="mb-1 text-2xl font-roobert-semibold text-foreground tracking-tight">
                    Delete Your Account
                  </Text>
                  <Text className="text-sm font-roobert text-muted-foreground text-center">
                    This action cannot be undone
                  </Text>
                </View>

                <View className="mb-6">
                  <Text className="mb-3 text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                    What Will Be Deleted
                  </Text>
                  
                  <View className="bg-card border border-border/40 rounded-2xl p-5">
                    <View className="gap-3">
                      <DataItem text="All your agents and agent versions" />
                      <DataItem text="All your threads and conversations" />
                      <DataItem text="All your credentials and integrations" />
                      <DataItem text="Your subscription and billing data" />
                    </View>
                  </View>
                </View>

                <View className="mb-6 bg-primary/5 rounded-2xl p-5">
                  <View className="flex-row items-start gap-3">
                    <View className="h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                      <Icon as={AlertTriangle} size={18} className="text-primary" strokeWidth={2.5} />
                    </View>
                    <View className="flex-1">
                      <Text className="text-sm font-roobert-semibold text-foreground mb-1">
                        30-Day Grace Period
                      </Text>
                      <Text className="text-sm font-roobert text-muted-foreground leading-5">
                        Your account will be scheduled for deletion in 30 days. You can cancel this request anytime during the grace period.
                      </Text>
                    </View>
                  </View>
                </View>

                <View className="mb-6">
                  <Text className="mb-3 text-sm font-roobert-medium text-foreground">
                    Type <Text className="font-roobert-semibold">DELETE</Text> to confirm
                  </Text>
                  <TextInput
                    value={confirmText}
                    onChangeText={(text) => setConfirmText(text.toUpperCase())}
                    placeholder="DELETE"
                    placeholderTextColor={colorScheme === 'dark' ? '#71717A' : '#A1A1AA'}
                    className="bg-card border border-border/40 rounded-2xl p-4 text-foreground font-roobert-semibold text-base tracking-wide"
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
                  variant="destructive"
                />
              </>
            )}
          </View>

          <View className="h-20" />
        </ScrollView>
      </View>
    </View>
  );
}

function DataItem({ text }: { text: string }) {
  return (
    <View className="flex-row items-start gap-3">
      <View className="w-1.5 h-1.5 rounded-full bg-muted-foreground mt-2" />
      <Text className="text-sm font-roobert text-foreground flex-1 leading-5">
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
  variant: 'primary' | 'destructive';
}

function ActionButton({ onPress, disabled, isLoading, icon: IconComponent, label, variant }: ActionButtonProps) {
  const { colorScheme } = useColorScheme();
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

  const bgClass = disabled
    ? 'bg-muted/50'
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
      className={`rounded-full items-center justify-center flex-row gap-2 px-6 py-4 ${bgClass}`}
    >
      {isLoading ? (
        <>
          <KortixLoader 
            size="small" 
            forceTheme={colorScheme === 'dark' ? 'dark' : 'light'}
          />
          <Text className={`${textColor} text-sm font-roobert-medium`}>
            Processing...
          </Text>
        </>
      ) : (
        <>
          <Icon 
            as={IconComponent} 
            size={16} 
            className={textColor} 
            strokeWidth={2.5} 
          />
          <Text className={`${textColor} text-sm font-roobert-medium`}>
            {label}
          </Text>
        </>
      )}
    </AnimatedPressable>
  );
}
