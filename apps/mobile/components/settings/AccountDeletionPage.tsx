import * as React from 'react';
import { Pressable, View, Alert, ScrollView, TextInput, Platform, StyleSheet, TouchableOpacity } from 'react-native';
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
import { NativeHeader } from './NativeHeader';
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
    if (confirmText !== t('accountDeletion.deletePlaceholder')) {
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      await requestDeletion.mutateAsync('User requested deletion from mobile');
      
      setConfirmText('');
      
      Alert.alert(
        t('accountDeletion.deletionScheduled'),
        t('accountDeletion.deletionScheduledSuccess'),
        [{ 
          text: t('common.ok'),
          onPress: handleClose
        }]
      );
    } catch (error: any) {
      Alert.alert(t('common.error'), error.message || t('accountDeletion.failedToRequest'));
    }
  };

  const handleCancelDeletion = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    Alert.alert(
      t('accountDeletion.cancelDeletionTitle'),
      t('accountDeletion.cancelDeletionDescription'),
      [
        {
          text: t('accountDeletion.back'),
          style: 'cancel',
        },
        {
          text: t('accountDeletion.cancelDeletion'),
          onPress: async () => {
            try {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              await cancelDeletion.mutateAsync();
              
              Alert.alert(
                t('accountDeletion.deletionCancelled'),
                t('accountDeletion.deletionCancelledSuccess'),
                [{ text: t('common.ok') }]
              );
            } catch (error: any) {
              Alert.alert(t('common.error'), error.message || t('accountDeletion.failedToCancel'));
            }
          },
        },
      ]
    );
  };

  if (!visible) return null;

  const hasPendingDeletion = deletionStatus?.has_pending_deletion;
  const isLoading = requestDeletion.isPending || cancelDeletion.isPending || isCheckingStatus;
  
  const backgroundColor = Platform.OS === 'ios'
    ? (colorScheme === 'dark' ? '#1C1C1E' : '#FFFFFF')
    : (colorScheme === 'dark' ? '#121212' : '#F5F5F5');

  return (
    <View style={{ flex: 1, backgroundColor }}>
      <NativeHeader
        title={t('accountDeletion.title')}
        onBack={handleClose}
      />
      
      <ScrollView 
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16 }}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews={true}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: 16 }}>
            {hasPendingDeletion ? (
              <>
                <View className="mb-8 items-center pt-4">
                  <View className="mb-3 h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
                    <Icon as={Calendar} size={28} className="text-destructive" strokeWidth={2} />
                  </View>
                  <Text className="mb-1 text-2xl font-roobert-semibold text-foreground tracking-tight">
                    {t('accountDeletion.deletionScheduled')}
                  </Text>
                  <Text className="text-sm font-roobert text-muted-foreground text-center">
                    {t('accountDeletion.accountWillBeDeleted')}
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
                          {t('accountDeletion.scheduledFor')}
                        </Text>
                        <Text className="text-sm font-roobert-semibold text-foreground">
                          {formatDate(deletionStatus?.deletion_scheduled_for)}
                        </Text>
                      </View>
                    </View>
                    
                    <View className="pt-3 border-t border-destructive/20">
                      <Text className="text-sm font-roobert text-muted-foreground leading-5">
                        {t('accountDeletion.cancelRequestDescription')}
                      </Text>
                    </View>
                  </View>
                </View>

                <ActionButton
                  onPress={handleCancelDeletion}
                  disabled={isLoading}
                  isLoading={cancelDeletion.isPending}
                  icon={CheckCircle}
                  label={t('accountDeletion.cancelDeletion')}
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
                    {t('accountDeletion.deleteYourAccount')}
                  </Text>
                  <Text className="text-sm font-roobert text-muted-foreground text-center">
                    {t('accountDeletion.actionCannotBeUndone')}
                  </Text>
                </View>

                <View className="mb-6">
                  <Text className="mb-3 text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                    {t('accountDeletion.whatWillBeDeleted')}
                  </Text>
                  
                  <View className="bg-card border border-border/40 rounded-2xl p-5">
                    <View className="gap-3">
                      <DataItem text={t('accountDeletion.allAgents')} />
                      <DataItem text={t('accountDeletion.allThreads')} />
                      <DataItem text={t('accountDeletion.allCredentials')} />
                      <DataItem text={t('accountDeletion.subscriptionData')} />
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
                        {t('accountDeletion.gracePeriod')}
                      </Text>
                      <Text className="text-sm font-roobert text-muted-foreground leading-5">
                        {t('accountDeletion.gracePeriodDescription')}
                      </Text>
                    </View>
                  </View>
                </View>

                <View className="mb-6">
                  <Text className="mb-3 text-sm font-roobert-medium text-foreground">
                    {t('accountDeletion.typeDeleteToConfirm', { text: t('accountDeletion.deletePlaceholder') })}
                  </Text>
                  <TextInput
                    value={confirmText}
                    onChangeText={(text) => setConfirmText(text.toUpperCase())}
                    placeholder={t('accountDeletion.deletePlaceholder')}
                    placeholderTextColor={colorScheme === 'dark' ? '#71717A' : '#A1A1AA'}
                    className="bg-card border border-border/40 rounded-2xl p-4 text-foreground font-roobert-semibold text-base tracking-wide"
                    autoCapitalize="characters"
                    autoCorrect={false}
                    returnKeyType="done"
                  />
                </View>

                <ActionButton
                  onPress={handleRequestDeletion}
                  disabled={isLoading || confirmText !== t('accountDeletion.deletePlaceholder')}
                  isLoading={requestDeletion.isPending}
                  icon={Trash2}
                  label={t('accountDeletion.deleteAccount')}
                  variant="destructive"
                />
              </>
            )}
        </View>

        <View style={{ height: 80 }} />
      </ScrollView>
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
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();

  const backgroundColor = disabled
    ? (colorScheme === 'dark' ? '#2C2C2E' : '#E8E8ED')
    : variant === 'destructive'
      ? '#FF3B30'
      : (colorScheme === 'dark' ? '#0A84FF' : '#007AFF');

  const textColor = disabled
    ? (colorScheme === 'dark' ? '#8E8E93' : '#6E6E73')
    : '#FFFFFF';

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.7}
      style={{
        backgroundColor,
        borderRadius: 12,
        paddingVertical: 14,
        paddingHorizontal: 20,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {isLoading ? (
        <>
          <KortixLoader 
            size="small" 
            customSize={16}
          />
          <Text style={{ color: textColor, fontSize: 17, fontWeight: '600' }}>
            {t('accountDeletion.processing')}
          </Text>
        </>
      ) : (
        <>
          <Icon 
            as={IconComponent} 
            size={18} 
            color={textColor}
            strokeWidth={2.5} 
          />
          <Text style={{ color: textColor, fontSize: 17, fontWeight: '600' }}>
            {label}
          </Text>
        </>
      )}
    </TouchableOpacity>
  );
}
