import * as React from 'react';
import { Pressable, View, Alert, ScrollView, TextInput } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Trash2, Calendar, AlertTriangle, CheckCircle, Zap, Clock, Info } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { KortixLoader } from '@/components/ui';
import {
  useAccountDeletionStatus,
  useRequestAccountDeletion,
  useCancelAccountDeletion,
  useDeleteAccountImmediately,
} from '@/hooks/useAccountDeletion';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type DeletionType = 'grace-period' | 'immediate';

export default function AccountDeletionScreen() {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data: deletionStatus, isLoading: isCheckingStatus } = useAccountDeletionStatus();
  const requestDeletion = useRequestAccountDeletion();
  const cancelDeletion = useCancelAccountDeletion();
  const deleteImmediately = useDeleteAccountImmediately();
  const [confirmText, setConfirmText] = React.useState('');
  const [deletionType, setDeletionType] = React.useState<DeletionType>('grace-period');

  const accountDeletionSupported = deletionStatus?.supported ?? !isCheckingStatus;

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
      if (deletionType === 'immediate') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        await deleteImmediately.mutateAsync();

        setConfirmText('');

        // Immediate deletion succeeded → account gone. Navigate to root (auth screen).
        Alert.alert(
          t('accountDeletion.accountDeleted') || 'Account deleted',
          t('accountDeletion.accountDeletedSuccess') || 'Your account has been permanently deleted.',
          [
            {
              text: t('common.ok'),
              onPress: () => {
                router.replace('/');
              },
            },
          ],
        );
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        await requestDeletion.mutateAsync('User requested deletion from mobile');

        setConfirmText('');

        Alert.alert(
          t('accountDeletion.deletionScheduled'),
          t('accountDeletion.deletionScheduledSuccess'),
          [
            {
              text: t('common.ok'),
              onPress: () => router.back(),
            },
          ],
        );
      }
    } catch (error: any) {
      Alert.alert(t('common.error'), error?.message || t('accountDeletion.failedToRequest'));
    }
  };

  const handleCancelDeletion = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    Alert.alert(t('accountDeletion.cancelDeletionTitle'), t('accountDeletion.cancelDeletionDescription'), [
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
            Alert.alert(t('common.error'), error?.message || t('accountDeletion.failedToCancel'));
          }
        },
      },
    ]);
  };

  const hasPendingDeletion = deletionStatus?.has_pending_deletion;
  const isLoading =
    requestDeletion.isPending ||
    cancelDeletion.isPending ||
    deleteImmediately.isPending ||
    isCheckingStatus;

  // ── Unsupported environment state ──
  if (!isCheckingStatus && !accountDeletionSupported) {
    return (
      <ScrollView
        className="flex-1 bg-background"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
      >
        <View className="px-6 pt-4 pb-8">
          <View className="mb-8 items-center pt-4">
            <View className="mb-3 h-16 w-16 items-center justify-center rounded-full bg-muted">
              <Icon as={Info} size={28} className="text-muted-foreground" strokeWidth={2} />
            </View>
            <Text className="mb-1 text-2xl font-roobert-semibold text-foreground tracking-tight">
              {t('accountDeletion.notAvailableTitle') || 'Not available'}
            </Text>
            <Text className="text-sm font-roobert text-muted-foreground text-center leading-5">
              {t('accountDeletion.notAvailableDescription') ||
                'Account deletion is not available in this environment.'}
            </Text>
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}
      keyboardShouldPersistTaps="handled"
    >
      <View className="px-6 pt-4 pb-8">
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
                      {formatDate(deletionStatus?.deletion_scheduled_for ?? null)}
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

            {/* Deletion type selector — grace period vs immediate (matches web) */}
            <View className="mb-6">
              <Text className="mb-3 text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                {t('accountDeletion.deletionType') || 'When to delete'}
              </Text>

              <View className="gap-2">
                <DeletionTypeOption
                  selected={deletionType === 'grace-period'}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setDeletionType('grace-period');
                  }}
                  icon={Clock}
                  title={t('accountDeletion.gracePeriodOption') || '30-day grace period'}
                  description={t('accountDeletion.gracePeriodOptionDescription') || 'Your account will be scheduled for deletion in 30 days. You can cancel anytime before then.'}
                  variant="primary"
                />
                <DeletionTypeOption
                  selected={deletionType === 'immediate'}
                  onPress={() => {
                    Haptics.selectionAsync();
                    setDeletionType('immediate');
                  }}
                  icon={Zap}
                  title={t('accountDeletion.immediateOption') || 'Delete immediately'}
                  description={t('accountDeletion.immediateOptionDescription') || 'Permanently delete your account right now. This cannot be undone.'}
                  variant="destructive"
                />
              </View>
            </View>

            {deletionType === 'grace-period' && (
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
            )}

            {deletionType === 'immediate' && (
              <View className="mb-6 bg-destructive/5 border border-destructive/20 rounded-2xl p-5">
                <View className="flex-row items-start gap-3">
                  <View className="h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
                    <Icon as={AlertTriangle} size={18} className="text-destructive" strokeWidth={2.5} />
                  </View>
                  <View className="flex-1">
                    <Text className="text-sm font-roobert-semibold text-destructive mb-1">
                      {t('accountDeletion.immediateWarning') || 'This is permanent'}
                    </Text>
                    <Text className="text-sm font-roobert text-muted-foreground leading-5">
                      {t('accountDeletion.immediateWarningDescription') ||
                        'Your account and all associated data will be deleted instantly. There is no grace period and no way to recover.'}
                    </Text>
                  </View>
                </View>
              </View>
            )}

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
              isLoading={requestDeletion.isPending || deleteImmediately.isPending}
              icon={deletionType === 'immediate' ? Zap : Trash2}
              label={
                deletionType === 'immediate'
                  ? t('accountDeletion.deleteAccountNow') || 'Delete account now'
                  : t('accountDeletion.deleteAccount')
              }
              variant="destructive"
            />
          </>
        )}
      </View>
    </ScrollView>
  );
}

function DataItem({ text }: { text: string }) {
  return (
    <View className="flex-row items-start gap-3">
      <View className="w-1.5 h-1.5 rounded-full bg-muted-foreground mt-2" />
      <Text className="text-sm font-roobert text-foreground flex-1 leading-5">{text}</Text>
    </View>
  );
}

interface DeletionTypeOptionProps {
  selected: boolean;
  onPress: () => void;
  icon: any;
  title: string;
  description: string;
  variant: 'primary' | 'destructive';
}

function DeletionTypeOption({ selected, onPress, icon: IconComponent, title, description, variant }: DeletionTypeOptionProps) {
  const iconBg = variant === 'destructive' ? 'bg-destructive/10' : 'bg-primary/10';
  const iconColor = variant === 'destructive' ? 'text-destructive' : 'text-primary';
  const borderClass = selected
    ? variant === 'destructive'
      ? 'border-destructive'
      : 'border-primary'
    : 'border-border/40';
  const bgClass = selected
    ? variant === 'destructive'
      ? 'bg-destructive/5'
      : 'bg-primary/5'
    : 'bg-card';

  return (
    <Pressable
      onPress={onPress}
      className={`rounded-2xl border-2 p-4 ${bgClass} ${borderClass}`}
    >
      <View className="flex-row items-start gap-3">
        <View className={`h-10 w-10 items-center justify-center rounded-full ${iconBg}`}>
          <Icon as={IconComponent} size={18} className={iconColor} strokeWidth={2.5} />
        </View>
        <View className="flex-1">
          <View className="flex-row items-center justify-between mb-1">
            <Text className="text-sm font-roobert-semibold text-foreground">{title}</Text>
            <View
              className={`h-5 w-5 rounded-full border-2 items-center justify-center ${
                selected
                  ? variant === 'destructive'
                    ? 'border-destructive bg-destructive'
                    : 'border-primary bg-primary'
                  : 'border-muted-foreground/30'
              }`}
            >
              {selected && (
                <View className="h-2 w-2 rounded-full bg-background" />
              )}
            </View>
          </View>
          <Text className="text-xs font-roobert text-muted-foreground leading-4">
            {description}
          </Text>
        </View>
      </View>
    </Pressable>
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

function ActionButton({
  onPress,
  disabled,
  isLoading,
  icon: IconComponent,
  label,
  variant,
}: ActionButtonProps) {
  const { t } = useLanguage();
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

  const bgClass = disabled ? 'bg-muted/50' : variant === 'destructive' ? 'bg-destructive' : 'bg-primary';

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
          <KortixLoader size="small" forceTheme={colorScheme === 'dark' ? 'dark' : 'light'} />
          <Text className={`${textColor} text-sm font-roobert-medium`}>
            {t('accountDeletion.processing')}
          </Text>
        </>
      ) : (
        <>
          <Icon as={IconComponent} size={16} className={textColor} strokeWidth={2.5} />
          <Text className={`${textColor} text-sm font-roobert-medium`}>{label}</Text>
        </>
      )}
    </AnimatedPressable>
  );
}
