import React from 'react';
import { View, ScrollView, Pressable, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Bell, CheckCircle2, Info, AlertCircle, XCircle, CheckCheck, ArrowLeft } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useNotifications, useMarkNotificationAsRead } from '@/hooks/useNotifications';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';

const typeIcons = {
  info: Info,
  success: CheckCircle2,
  warning: AlertCircle,
  error: XCircle,
  agent_complete: CheckCheck,
};

const typeColors = {
  info: 'text-blue-500',
  success: 'text-green-500',
  warning: 'text-yellow-500',
  error: 'text-red-500',
  agent_complete: 'text-purple-500',
};

export function NotificationScreen() {
  const router = useRouter();
  const { data, isLoading, refetch, isRefetching } = useNotifications({ page: 1, page_size: 50 });
  const markAsReadMutation = useMarkNotificationAsRead();

  const notifications = data?.notifications || [];
  const unreadCount = data?.unread_count || 0;

  const handleNotificationPress = (notification: any) => {
    if (!notification.is_read) {
      markAsReadMutation.mutate([notification.id], {
        onSuccess: () => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        },
      });
    }

    // Navigate to thread if available
    if (notification.thread_id) {
      router.push(`/home?threadId=${notification.thread_id}`);
    }
  };

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  };

  if (isLoading && !data) {
    return (
      <SafeAreaView className="flex-1 bg-white dark:bg-black">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-white dark:bg-black">
      <View className="flex-1">
        {/* Header */}
        <View className="flex-row items-center justify-between px-4 py-4 border-b border-gray-200 dark:border-gray-800">
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.back();
            }}
            className="flex-row items-center gap-3"
          >
            <Icon as={ArrowLeft} size={24} className="text-foreground mr-2" />
            <Bell className="h-6 w-6 text-gray-900 dark:text-gray-100" />
            <Text className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              Notifications
            </Text>
            {unreadCount > 0 && (
              <View className="bg-blue-500 rounded-full px-2 py-0.5 min-w-[24px] items-center justify-center">
                <Text className="text-xs font-medium text-white">{unreadCount}</Text>
              </View>
            )}
          </Pressable>
        </View>

        {/* Notifications List */}
        <ScrollView
          className="flex-1"
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} />
          }
        >
          {notifications.length === 0 ? (
            <View className="flex-1 items-center justify-center py-20 px-4">
              <Bell className="h-12 w-12 text-gray-400 dark:text-gray-600 mb-4" />
              <Text className="text-base font-medium text-gray-600 dark:text-gray-400 mb-2">
                No notifications
              </Text>
              <Text className="text-sm text-gray-500 dark:text-gray-500 text-center">
                You're all caught up!
              </Text>
            </View>
          ) : (
            <View className="divide-y divide-gray-200 dark:divide-gray-800">
              {notifications.map((notification) => {
                const IconComponent = typeIcons[notification.type] || Info;
                const iconColor = typeColors[notification.type] || typeColors.info;

                return (
                  <Pressable
                    key={notification.id}
                    onPress={() => handleNotificationPress(notification)}
                    className={`px-4 py-4 ${
                      !notification.is_read
                        ? 'bg-blue-50 dark:bg-blue-950/20'
                        : 'bg-white dark:bg-black'
                    }`}
                  >
                    <View className="flex-row items-start gap-3">
                      <View className={`mt-0.5 ${iconColor}`}>
                        <IconComponent size={20} />
                      </View>
                      <View className="flex-1 flex-shrink">
                        <View className="flex-row items-start justify-between gap-2 mb-1">
                          <Text
                            className={`text-base font-semibold ${
                              !notification.is_read
                                ? 'text-gray-900 dark:text-gray-100'
                                : 'text-gray-700 dark:text-gray-300'
                            }`}
                          >
                            {notification.title}
                          </Text>
                          {!notification.is_read && (
                            <View className="h-2 w-2 rounded-full bg-blue-500 mt-2" />
                          )}
                        </View>
                        <Text className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                          {notification.message}
                        </Text>
                        <Text className="text-xs text-gray-500 dark:text-gray-500">
                          {formatTimeAgo(notification.created_at)}
                        </Text>
                      </View>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
