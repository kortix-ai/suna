'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { Suspense, lazy } from 'react';
import { useAccounts } from '@/hooks/account';
import { useAuth } from '@/components/AuthProvider';
import { useSystemStatusQuery } from '@/hooks/edge-flags';
import { useRouter } from 'next/navigation';
import { useApiHealth } from '@/hooks/usage/use-health';
import { useAdminRole } from '@/hooks/admin';
import { usePresence } from '@/hooks/use-presence';
import { featureFlags } from '@/lib/feature-flags';
import { usePrefetchComposioIcons } from '@/hooks/composio/use-composio';

import { useProjects } from '@/hooks/sidebar/use-sidebar';
import { useIsMobile } from '@/hooks/utils';
import { AppProviders } from '@/components/layout/app-providers';
import { backendApi } from '@/lib/api-client';
import { AnnouncementDialog } from '../announcements/announcement-dialog';
import { NovuInboxProvider } from '../notifications/novu-inbox-provider';

// Lazy load heavy components that aren't needed for initial render
const FloatingMobileMenuButton = lazy(() => 
  import('@/components/sidebar/sidebar-left').then(mod => ({ default: mod.FloatingMobileMenuButton }))
);
const MaintenancePage = lazy(() => 
  import('@/components/maintenance/maintenance-page').then(mod => ({ default: mod.MaintenancePage }))
);
const StatusOverlay = lazy(() => 
  import('@/components/ui/status-overlay').then(mod => ({ default: mod.StatusOverlay }))
);
const PresentationViewerWrapper = lazy(() => 
  import('@/stores/presentation-viewer-store').then(mod => ({ default: mod.PresentationViewerWrapper }))
);

const OnboardingProvider = lazy(() => 
  import('@/components/onboarding/onboarding-provider').then(mod => ({ default: mod.OnboardingProvider }))
);
const DashboardPromoBanner = lazy(() => 
  import('@/components/home/dashboard-promo-banner').then(mod => ({ default: mod.DashboardPromoBanner }))
);

const PresenceDebug = lazy(() => 
  import('@/components/debug/presence-debug').then(mod => ({ default: mod.PresenceDebug }))
);

const KortixAppBanners = lazy(() => 
  import('@/components/announcements/kortix-app-banners').then(mod => ({ default: mod.KortixAppBanners }))
);

const MobileAppInterstitial = lazy(() => 
  import('@/components/announcements/mobile-app-interstitial').then(mod => ({ default: mod.MobileAppInterstitial }))
);

const TechnicalIssueBanner = lazy(() => 
  import('@/components/announcements/technical-issue-banner').then(mod => ({ default: mod.TechnicalIssueBanner }))
);

const MaintenanceCountdownBanner = lazy(() => 
  import('@/components/announcements/maintenance-countdown-banner').then(mod => ({ default: mod.MaintenanceCountdownBanner }))
);

// Skeleton shell that renders immediately for FCP
function DashboardSkeleton() {
  return (
    <div className="flex h-screen w-full bg-background">
      {/* Sidebar skeleton */}
      <div className="hidden md:flex w-[280px] flex-col border-r border-border bg-sidebar">
        <div className="p-4 space-y-4">
          <div className="h-8 w-32 bg-muted/40 rounded animate-pulse" />
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 bg-muted/30 rounded animate-pulse" />
            ))}
          </div>
        </div>
      </div>
      {/* Main content skeleton */}
      <div className="flex-1 flex flex-col">
        <div className="flex-1 flex items-center justify-center">
          <div className="w-full max-w-3xl px-4 space-y-6">
            <div className="h-10 w-64 mx-auto bg-muted/30 rounded animate-pulse" />
            <div className="h-24 bg-muted/20 rounded-xl animate-pulse" />
          </div>
        </div>
      </div>
    </div>
  );
}

interface DashboardLayoutContentProps {
  children: React.ReactNode;
}

export default function DashboardLayoutContent({
  children,
}: DashboardLayoutContentProps) {
  const { user, isLoading } = useAuth();
  const params = useParams();
  const threadId = params?.threadId as string | undefined;
  
  usePresence(threadId);
  
  const { data: accounts } = useAccounts({ enabled: !!user });
  const personalAccount = accounts?.find((account) => account.personal_account);
  const router = useRouter();
  const isMobile = useIsMobile();
  const { data: systemStatus, isLoading: systemStatusLoading } = useSystemStatusQuery();
  const maintenanceNotice = systemStatus?.maintenanceNotice;
  const technicalIssue = systemStatus?.technicalIssue;
  const statusUpdatedAt = systemStatus?.updatedAt;
  const {
    data: healthData,
    isLoading: isCheckingHealth,
    error: healthError,
  } = useApiHealth();

  const { data: projects } = useProjects();
  const { data: adminRoleData, isLoading: isCheckingAdminRole } = useAdminRole();
  const isAdmin = adminRoleData?.isAdmin ?? false;
  
  // Prefetch popular Composio icons for faster UI
  const { prefetchPopularIcons } = usePrefetchComposioIcons();

  useEffect(() => {
    if (user) {
      backendApi.post('/prewarm', undefined, { showErrors: false });
    }
  }, [user])
  
  useEffect(() => {
    if (user) {
      prefetchPopularIcons();
    }
  }, [user, prefetchPopularIcons]);

  // Log data prefetching for debugging
  useEffect(() => {
    if (isMobile) {
      console.log('📱 Mobile Layout - Prefetched data:', {
        projects: projects?.length || 0,
        accounts: accounts?.length || 0,
        user: !!user
      });
    }
  }, [isMobile, projects, accounts, user]);

  // API health is now managed by useApiHealth hook
  const isApiHealthy = healthData?.status === 'ok' && !healthError;

  // Check authentication status
  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/auth');
    }
  }, [user, isLoading, router]);

  const isMaintenanceActive = (() => {
    if (!maintenanceNotice?.enabled || !maintenanceNotice.startTime || !maintenanceNotice.endTime) {
      return false;
    }
    const now = new Date();
    const start = new Date(maintenanceNotice.startTime);
    const end = new Date(maintenanceNotice.endTime);
    return now >= start && now <= end;
  })();

  const isMaintenanceScheduled = (() => {
    if (!maintenanceNotice?.enabled || !maintenanceNotice.startTime || !maintenanceNotice.endTime) {
      return false;
    }
    const now = new Date();
    const start = new Date(maintenanceNotice.startTime);
    const end = new Date(maintenanceNotice.endTime);
    return now < start && now < end;
  })();

  if (isLoading) {
    return <DashboardSkeleton />;
  }

  if (!user) {
    return <DashboardSkeleton />;
  }

  if (isMaintenanceActive && !systemStatusLoading && !isCheckingAdminRole && !isAdmin) {
    return (
      <Suspense fallback={<DashboardSkeleton />}>
        <MaintenancePage />
      </Suspense>
    );
  }

  // Show maintenance page if API is not healthy
  if (!isCheckingHealth && !isCheckingAdminRole && (!isApiHealthy || healthError) && !isAdmin) {
    return (
      <Suspense fallback={<DashboardSkeleton />}>
        <MaintenancePage />
      </Suspense>
    );
  }

  return (
    <NovuInboxProvider>
    <AppProviders 
      showSidebar={true}
      sidebarSiblings={
        <Suspense fallback={null}>
          {/* Status overlay for deletion operations */}
          <StatusOverlay />
          {/* Floating mobile menu button */}
          <FloatingMobileMenuButton />
        </Suspense>
      }
    >
      <div className="relative h-full">
        {technicalIssue?.enabled && technicalIssue.message && (
          <Suspense fallback={null}>
            <TechnicalIssueBanner 
              message={technicalIssue.message}
              statusUrl={technicalIssue.statusUrl}
              updatedAt={statusUpdatedAt}
            />
          </Suspense>
        )}
        
        {isMaintenanceScheduled && maintenanceNotice?.startTime && maintenanceNotice?.endTime && (
          <Suspense fallback={null}>
            <MaintenanceCountdownBanner 
              startTime={maintenanceNotice.startTime}
              endTime={maintenanceNotice.endTime}
              updatedAt={statusUpdatedAt}
            />
          </Suspense>
        )}
        
        {/* Site-wide promo banner for free tier users */}
        <Suspense fallback={null}>
          <DashboardPromoBanner />
        </Suspense>
        <Suspense fallback={null}>
          <AnnouncementDialog />
        </Suspense>
        
        <Suspense fallback={null}>
          <OnboardingProvider>
            <div className="bg-background">{children}</div>
          </OnboardingProvider>
        </Suspense>
        <Suspense fallback={null}>
          <PresentationViewerWrapper />
        </Suspense>
        {/* Kortix App announcement banners */}
        <Suspense fallback={null}>
          <KortixAppBanners disableMobileAdvertising={featureFlags.disableMobileAdvertising} />
        </Suspense>
        {/* Mobile app install interstitial - shown on actual mobile devices */}
        {!featureFlags.disableMobileAdvertising ? (
          <Suspense fallback={null}>
            <MobileAppInterstitial />
          </Suspense>
        ) : null}
      </div>
    </AppProviders>
    </NovuInboxProvider>
  );
}
