import React, { useState, useEffect } from 'react';
import { View, ScrollView, ActivityIndicator, Pressable, Switch } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { mobileNotificationService } from '@/lib/notifications/novu-service';
import { Bell, Mail, Smartphone, MessageSquare, CreditCard, Star } from 'lucide-react-native';
import { SettingsHeader } from '../settings/SettingsHeader';
import * as Haptics from 'expo-haptics';
import { useLanguage } from '@/contexts';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface NotificationSettings {
  email_enabled: boolean;
  push_enabled: boolean;
  in_app_enabled: boolean;
  task_notifications: boolean;
  billing_notifications: boolean;
  promotional_notifications: boolean;
  system_notifications: boolean;
}

interface NotificationSettingsPageProps {
  visible: boolean;
  onClose: () => void;
}

export function NotificationSettingsPage({ visible, onClose }: NotificationSettingsPageProps) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { t } = useLanguage();

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const data = await mobileNotificationService.getNotificationSettings();
      setSettings(data);
    } catch (error) {
      console.error('Failed to load notification settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const updateSetting = async (key: keyof NotificationSettings, value: boolean) => {
    if (!settings) return;

    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);

    try {
      setSaving(true);
      await mobileNotificationService.updateNotificationSettings({ [key]: value });
    } catch (error) {
      console.error('Failed to update settings:', error);
      setSettings(settings);
    } finally {
      setSaving(false);
    }
  };

  const requestPushPermission = async () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const granted = await mobileNotificationService.requestPermission();
      if (granted) {
        await mobileNotificationService.registerDeviceToken();
        await updateSetting('push_enabled', true);
      }
    } catch (error) {
      console.error('Failed to request push permission:', error);
    }
  };

  const handleClose = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  }, [onClose]);

  if (!visible) return null;

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
        >
          <SettingsHeader
            title="Notifications"
            onClose={handleClose}
          />

          {loading ? (
            <View className="flex-1 items-center justify-center p-8">
              <ActivityIndicator size="large" />
              <Text className="mt-4 text-sm text-muted-foreground">Loading settings...</Text>
            </View>
          ) : !settings ? (
            <View className="flex-1 items-center justify-center p-8">
              <Text className="text-sm text-destructive mb-4">Failed to load settings</Text>
              <Pressable 
                onPress={loadSettings}
                className="bg-primary px-4 py-2 rounded-lg"
              >
                <Text className="text-primary-foreground font-medium">Retry</Text>
              </Pressable>
            </View>
          ) : (
            <View className="px-6 pb-8">
              <View className="mb-6">
                <Text className="mb-3 text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                  Channels
                </Text>
                <View className="bg-card rounded-2xl overflow-hidden">
                  <SettingToggle
                    icon={Mail}
                    label="Email Notifications"
                    description="Receive notifications via email"
                    value={settings.email_enabled}
                    onValueChange={(value) => updateSetting('email_enabled', value)}
                    disabled={saving}
                  />
                  <View className="h-px bg-border mx-4" />
                  <SettingToggle
                    icon={Smartphone}
                    label="Push Notifications"
                    description="Receive push notifications on this device"
                    value={settings.push_enabled}
                    onValueChange={(value) => 
                      value ? requestPushPermission() : updateSetting('push_enabled', false)
                    }
                    disabled={saving}
                  />
                </View>
              </View>

              <View className="mb-6">
                <Text className="mb-3 text-xs font-roobert-medium text-muted-foreground uppercase tracking-wider">
                  Notification Types
                </Text>
                <View className="bg-card rounded-2xl overflow-hidden">
                  <SettingToggle
                    icon={MessageSquare}
                    label="Task Notifications"
                    description="Task completions and updates"
                    value={settings.task_notifications}
                    onValueChange={(value) => updateSetting('task_notifications', value)}
                    disabled={saving}
                  />
                  <View className="h-px bg-border mx-4" />
                  <SettingToggle
                    icon={CreditCard}
                    label="Billing Notifications"
                    description="Payments and subscriptions"
                    value={settings.billing_notifications}
                    onValueChange={(value) => updateSetting('billing_notifications', value)}
                    disabled={saving}
                  />
                  <View className="h-px bg-border mx-4" />
                  <SettingToggle
                    icon={Star}
                    label="Promotional"
                    description="New features and offers"
                    value={settings.promotional_notifications}
                    onValueChange={(value) => updateSetting('promotional_notifications', value)}
                    disabled={saving}
                  />
                </View>
              </View>
            </View>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

interface SettingToggleProps {
  icon: any;
  label: string;
  description: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}

function SettingToggle({ 
  icon: IconComponent, 
  label, 
  description, 
  value, 
  onValueChange,
  disabled 
}: SettingToggleProps) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }]
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.98);
  };

  const handlePressOut = () => {
    scale.value = withSpring(1);
  };

  return (
    <AnimatedPressable
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={() => {
        if (!disabled) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onValueChange(!value);
        }
      }}
      style={animatedStyle}
      className="flex-row items-center px-4 py-4"
      disabled={disabled}
    >
      <View className="flex-row items-center flex-1 gap-3">
        <Icon as={IconComponent} size={20} className="text-muted-foreground" />
        <View className="flex-1">
          <Text className="text-base font-roobert-medium text-foreground mb-0.5">
            {label}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {description}
          </Text>
        </View>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: '#767577', true: '#10b981' }}
        thumbColor={value ? '#ffffff' : '#f4f3f4'}
      />
    </AnimatedPressable>
  );
}

