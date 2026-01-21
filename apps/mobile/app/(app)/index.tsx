import { HomePage } from '@/components/pages';
import type { HomePageRef } from '@/components/pages/HomePage';
import { useChat } from '@/hooks';
import { useSystemStatus } from '@/hooks/useSystemStatus';
import { useAuthContext } from '@/contexts';
import { Stack, useRouter } from 'expo-router';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { StatusBar as RNStatusBar, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FeedbackDrawer } from '@/components/chat/tool-views/complete-tool/FeedbackDrawer';
import { useFeedbackDrawerStore } from '@/stores/feedback-drawer-store';
import { MaintenanceBanner, TechnicalIssueBanner, MaintenancePage } from '@/components/status';
import { log } from '@/lib/logger';

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const { isAuthenticated } = useAuthContext();
  const router = useRouter();
  const chat = useChat();
  const { isOpen: isFeedbackDrawerOpen } = useFeedbackDrawerStore();
  const homePageRef = React.useRef<HomePageRef>(null);
  const { data: systemStatus, refetch: refetchSystemStatus, isLoading: isSystemStatusLoading } = useSystemStatus();

  const handleOpenWorkerConfig = React.useCallback(
    (workerId: string, view?: 'instructions' | 'tools' | 'integrations' | 'triggers') => {
      router.push({
        pathname: '/worker-config',
        params: { workerId, ...(view && { view }) },
      });
    },
    [router]
  );

  const isMaintenanceActive = React.useMemo(() => {
    const notice = systemStatus?.maintenanceNotice;
    if (!notice?.enabled || !notice.startTime || !notice.endTime) {
      return false;
    }
    const now = new Date();
    const start = new Date(notice.startTime);
    const end = new Date(notice.endTime);
    return now >= start && now <= end;
  }, [systemStatus?.maintenanceNotice]);

  const isMaintenanceScheduled = React.useMemo(() => {
    const notice = systemStatus?.maintenanceNotice;
    if (!notice?.enabled || !notice.startTime || !notice.endTime) {
      return false;
    }
    const now = new Date();
    const start = new Date(notice.startTime);
    return now < start;
  }, [systemStatus?.maintenanceNotice]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <RNStatusBar barStyle={colorScheme === 'dark' ? 'light-content' : 'dark-content'} />

      <View className="flex-1 bg-background">
        {isMaintenanceActive ? (
          <MaintenancePage 
            onRefresh={() => refetchSystemStatus()}
            isRefreshing={isSystemStatusLoading}
          />
        ) : (
          <View className="flex-1">
            <HomePage
              ref={homePageRef}
              chat={chat}
              isAuthenticated={isAuthenticated}
              onOpenWorkerConfig={handleOpenWorkerConfig}
              showThreadListView={false}
            />
            {(isMaintenanceScheduled || (systemStatus?.technicalIssue?.enabled && systemStatus.technicalIssue.message)) && (
              <View style={{ position: 'absolute', top: insets.top + 60, left: 0, right: 0 }}>
                {isMaintenanceScheduled && systemStatus?.maintenanceNotice?.startTime && systemStatus.maintenanceNotice.endTime && (
                  <MaintenanceBanner
                    startTime={systemStatus.maintenanceNotice.startTime}
                    endTime={systemStatus.maintenanceNotice.endTime}
                    updatedAt={systemStatus.updatedAt}
                  />
                )}
                {systemStatus?.technicalIssue?.enabled && systemStatus.technicalIssue.message && (
                  <TechnicalIssueBanner
                    message={systemStatus.technicalIssue.message}
                    statusUrl={systemStatus.technicalIssue.statusUrl}
                    description={systemStatus.technicalIssue.description}
                    estimatedResolution={systemStatus.technicalIssue.estimatedResolution}
                    severity={systemStatus.technicalIssue.severity}
                    affectedServices={systemStatus.technicalIssue.affectedServices}
                    updatedAt={systemStatus.updatedAt}
                  />
                )}
              </View>
            )}
          </View>
        )}
      </View>
      {isFeedbackDrawerOpen && <FeedbackDrawer />}
    </>
  );
}
