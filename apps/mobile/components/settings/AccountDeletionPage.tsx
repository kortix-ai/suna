import * as React from 'react';
import { View, Alert, ScrollView, TextInput, Platform, StyleSheet, TouchableOpacity, ViewStyle } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Trash2, Calendar, AlertTriangle, CheckCircle } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { KortixLoader } from '@/components/ui';
import { 
  useAccountDeletionStatus, 
  useRequestAccountDeletion, 
  useCancelAccountDeletion 
} from '@/hooks/useAccountDeletion';
import { getDrawerBackgroundColor } from '@agentpress/shared';

interface AccountDeletionPageProps {
  visible: boolean;
  onClose: () => void;
  isDrawer?: boolean;
}

export function AccountDeletionPage({ visible, onClose, isDrawer = false }: AccountDeletionPageProps) {
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
  
  const backgroundColor = getDrawerBackgroundColor(Platform.OS, colorScheme);
  const isIOS = Platform.OS === 'ios';
  
  const groupedBackgroundStyle = isIOS 
    ? { borderRadius: 20, overflow: 'hidden' }
    : { 
        backgroundColor: colorScheme === 'dark' ? '#1E1E1E' : '#FFFFFF',
        borderRadius: 12,
        elevation: 2,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
      };

  return (
    <View style={{ flex: 1, backgroundColor, width: '100%', overflow: 'hidden' }}>
      <ScrollView 
        style={{ flex: 1, width: '100%' }}
        contentContainerStyle={{ padding: 16, width: '100%' }}
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

                <View 
                  style={[
                    groupedBackgroundStyle as ViewStyle,
                    { marginBottom: isIOS ? 20 : 16 }
                  ]}
                  className={isIOS ? 'bg-muted-foreground/10 rounded-2xl' : ''}
                >
                  <View style={{ padding: 16 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                      <View style={{
                        height: 44,
                        width: 44,
                        borderRadius: 22,
                        backgroundColor: colorScheme === 'dark' ? 'rgba(255, 59, 48, 0.15)' : 'rgba(255, 59, 48, 0.1)',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}>
                        <Icon as={Calendar} size={20} color="#FF3B30" strokeWidth={2.5} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text 
                          style={{ 
                            fontSize: 13,
                            marginBottom: 4,
                          }}
                          className="text-muted-foreground"
                        >
                          {t('accountDeletion.scheduledFor')}
                        </Text>
                        <Text 
                          style={{ 
                            fontSize: 17,
                            fontWeight: '600',
                          }}
                          className="text-foreground"
                        >
                          {formatDate(deletionStatus?.deletion_scheduled_for)}
                        </Text>
                      </View>
                    </View>
                    
                    <View style={{
                      paddingTop: 16,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colorScheme === 'dark' ? '#38383A' : '#C6C6C8',
                    }}>
                      <Text 
                        style={{ 
                          fontSize: 15,
                          lineHeight: 20,
                        }}
                        className="text-muted-foreground"
                      >
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

                <View style={{
                  backgroundColor: colorScheme === 'dark' ? 'rgba(0, 122, 255, 0.1)' : 'rgba(0, 122, 255, 0.05)',
                  borderRadius: isIOS ? 20 : 12,
                  padding: 16,
                  marginBottom: isIOS ? 20 : 16,
                  ...(isIOS ? {} : {
                    elevation: 1,
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: 0.05,
                    shadowRadius: 2,
                  }),
                }}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
                    <View style={{
                      height: 40,
                      width: 40,
                      borderRadius: 20,
                      backgroundColor: colorScheme === 'dark' ? 'rgba(0, 122, 255, 0.2)' : 'rgba(0, 122, 255, 0.1)',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}>
                      <Icon as={AlertTriangle} size={18} color={colorScheme === 'dark' ? '#0A84FF' : '#007AFF'} strokeWidth={2.5} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text 
                        style={{ 
                          fontSize: 15,
                          fontWeight: '600',
                          marginBottom: 4,
                        }}
                        className="text-foreground"
                      >
                        {t('accountDeletion.gracePeriod')}
                      </Text>
                      <Text 
                        style={{ 
                          fontSize: 15,
                          lineHeight: 20,
                        }}
                        className="text-muted-foreground"
                      >
                        {t('accountDeletion.gracePeriodDescription')}
                      </Text>
                    </View>
                  </View>
                </View>

                <View style={{ marginBottom: isIOS ? 20 : 16 }}>
                  <Text 
                    style={{ 
                      fontSize: isIOS ? 17 : 16,
                      fontWeight: isIOS ? '400' : '500',
                      marginBottom: 12,
                    }}
                    className="text-foreground"
                  >
                    {t('accountDeletion.typeDeleteToConfirm', { text: t('accountDeletion.deletePlaceholder') })}
                  </Text>
                  <View
                    style={[
                      groupedBackgroundStyle as ViewStyle,
                      { padding: 0 }
                    ]}
                    className={isIOS ? 'bg-muted-foreground/10 rounded-2xl' : ''}
                  >
                    <TextInput
                      value={confirmText}
                      onChangeText={(text) => setConfirmText(text.toUpperCase())}
                      placeholder={t('accountDeletion.deletePlaceholder')}
                      placeholderTextColor={colorScheme === 'dark' ? '#71717A' : '#A1A1AA'}
                      style={{
                        padding: 16,
                        fontSize: isIOS ? 17 : 16,
                        fontWeight: '600',
                        letterSpacing: 1,
                        color: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
                      }}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      returnKeyType="done"
                    />
                  </View>
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
  const { colorScheme } = useColorScheme();
  
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
      <View style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: colorScheme === 'dark' ? '#8E8E93' : '#6E6E73',
        marginTop: 7,
      }} />
      <Text 
        style={{ 
          fontSize: 15,
          lineHeight: 20,
          flex: 1,
        }}
        className="text-foreground"
      >
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
  const isIOS = Platform.OS === 'ios';

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
          <Text style={{ 
            color: textColor, 
            fontSize: isIOS ? 17 : 16, 
            fontWeight: '600' 
          }}>
            {t('accountDeletion.processing')}
          </Text>
        </>
      ) : (
        <>
          <Icon 
            as={IconComponent} 
            size={isIOS ? 18 : 20} 
            color={textColor}
            strokeWidth={2.5} 
          />
          <Text style={{ 
            color: textColor, 
            fontSize: isIOS ? 17 : 16, 
            fontWeight: '600' 
          }}>
            {label}
          </Text>
        </>
      )}
    </TouchableOpacity>
  );
}
