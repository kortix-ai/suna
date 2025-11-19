'use client';

import { useEffect } from 'react';
import { FloatingMobileMenuButton } from '@/components/sidebar/sidebar-left';
import { useAccounts } from '@/hooks/account';
import { useAuth } from '@/components/AuthProvider';
import { useMaintenanceNoticeQuery } from '@/hooks/edge-flags';
import { useRouter } from 'next/navigation';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useApiHealth } from '@/hooks/usage/use-health';
import { MaintenancePage } from '@/components/maintenance/maintenance-page';
import { StatusOverlay } from '@/components/ui/status-overlay';
import { useAdminRole } from '@/hooks/admin';

import { useProjects, useThreads } from '@/hooks/sidebar/use-sidebar';
import { useIsMobile } from '@/hooks/utils';
import { useAgents } from '@/hooks/agents/use-agents';
import { PresentationViewerWrapper } from '@/stores/presentation-viewer-store';
import { OnboardingProvider } from '@/components/onboarding/onboarding-provider';
import { AppProviders } from '@/components/layout/app-providers';

interface DashboardLayoutContentProps {
  children: React.ReactNode;
}

export default function DashboardLayoutContent({
  children,
}: DashboardLayoutContentProps) {
  const { user, isLoading } = useAuth();
  const { data: accounts } = useAccounts({ enabled: !!user });
  const personalAccount = accounts?.find((account) => account.personal_account);
  const router = useRouter();
  const isMobile = useIsMobile();
  const { data: maintenanceNotice, isLoading: maintenanceLoading } = useMaintenanceNoticeQuery();
  const {
    data: healthData,
    isLoading: isCheckingHealth,
    error: healthError,
  } = useApiHealth();

  const { data: projects } = useProjects();
  const { data: threads } = useThreads();
  const { data: agentsResponse } = useAgents({
    limit: 100,
    sort_by: 'name',
    sort_order: 'asc'
  });

  const { data: adminRoleData, isLoading: isCheckingAdminRole } = useAdminRole();
  const isAdmin = adminRoleData?.isAdmin ?? false;

  // Log data prefetching for debugging
  useEffect(() => {
    if (isMobile) {
      console.log('📱 Mobile Layout - Prefetched data:', {
        projects: projects?.length || 0,
        threads: threads?.length || 0,
        agents: agentsResponse?.agents?.length || 0,
        accounts: accounts?.length || 0,
        user: !!user
      });
    }
  }, [isMobile, projects, threads, agentsResponse, accounts, user]);

  // API health is now managed by useApiHealth hook
  const isApiHealthy = healthData?.status === 'ok' && !healthError;

  // Check authentication status
  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/auth');
    }
  }, [user, isLoading, router]);

  const mantenanceBanner: React.ReactNode | null = null;

  // Show loading state only while checking auth (not maintenance status)
  // Maintenance check now has placeholder data to prevent flash
  // Health check errors should show the maintenance page, not infinite loading
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <KortixLoader size="large" />
      </div>
    );
  }

  // Don't render anything if not authenticated
  if (!user) {
    return null;
  }

  // Show maintenance page if maintenance mode is enabled
  // Only show if we have actual data (not placeholder) or if explicitly enabled
  // Bypass maintenance for admins after role check completes
  if (maintenanceNotice?.enabled && !maintenanceLoading && !isCheckingAdminRole && !isAdmin) {
    return <MaintenancePage/>
  }

  // Show maintenance page if API is not healthy OR if health check failed
  // But only after initial check completes (not during loading with placeholder data)
  // This prevents flash during navigation when placeholder data is being used
  // Bypass for admins after role check completes
  if (!isCheckingHealth && !isCheckingAdminRole && (!isApiHealthy || healthError) && !isAdmin) {
    return <MaintenancePage />;
  }

  return (
    <AppProviders 
      showSidebar={true}
      sidebarSiblings={
        <>
            {/* Status overlay for deletion operations */}
            <StatusOverlay />
            {/* Floating mobile menu button */}
            <FloatingMobileMenuButton />
        </>
      }
    >
      <OnboardingProvider>
        {mantenanceBanner}
        <div className="bg-background">{children}</div>
        </OnboardingProvider>
        <PresentationViewerWrapper />
    </AppProviders>
  );
}
