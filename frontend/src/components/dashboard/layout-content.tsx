'use client';

import { useEffect } from 'react';
import { SidebarLeft, FloatingMobileMenuButton } from '@/components/sidebar/sidebar-left';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { useAccounts } from '@/hooks/use-accounts';
import { useAuth } from '@/components/AuthProvider';
import { useMaintenanceNoticeQuery } from '@/hooks/react-query/edge-flags';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useApiHealth } from '@/hooks/react-query';
import { MaintenancePage } from '@/components/maintenance/maintenance-page';
import { DeleteOperationProvider } from '@/contexts/DeleteOperationContext';
import { StatusOverlay } from '@/components/ui/status-overlay';

import { useProjects, useThreads } from '@/hooks/react-query/sidebar/use-sidebar';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAgents } from '@/hooks/react-query/agents/use-agents';
import { SubscriptionProvider } from '@/contexts/SubscriptionContext';
import { MaintenanceAlert } from '../maintenance-alert';
import { OnboardingProvider } from '@/components/onboarding/onboarding-provider';

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

  useEffect(() => {
    if (maintenanceNotice?.enabled) {
      // setShowMaintenanceAlert(true); // This line was removed
    } else {
      // setShowMaintenanceAlert(false); // This line was removed
    }
  }, [maintenanceNotice]);

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

  // Show loading state while checking auth, health, or maintenance status
  if (isLoading || isCheckingHealth || maintenanceLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Don't render anything if not authenticated
  if (!user) {
    return null;
  }

  // Show maintenance page if maintenance mode is enabled
  if (maintenanceNotice?.enabled) {
    return <MaintenanceAlert open={true} onOpenChange={() => {}} closeable={false} />;
  }

  // Show maintenance page if API is not healthy (but not during initial loading)
  if (!isCheckingHealth && !isApiHealthy) {
    return <MaintenancePage />;
  }

  return (
    <DeleteOperationProvider>
      <SubscriptionProvider>
        <OnboardingProvider>
          <SidebarProvider>
            <SidebarLeft />
            <SidebarInset>
              {mantenanceBanner}
              <div className="bg-background">{children}</div>
            </SidebarInset>

            {/* <PricingAlert 
            open={showPricingAlert} 
            onOpenChange={setShowPricingAlert}
            closeable={false}
            accountId={personalAccount?.account_id}
            /> */}

            {/* <MaintenanceAlert
              open={showMaintenanceAlert}
              onOpenChange={setShowMaintenanceAlert}
              closeable={true}
            /> */}

            {/* Status overlay for deletion operations */}
            <StatusOverlay />
            
            {/* Floating mobile menu button */}
            <FloatingMobileMenuButton />
          </SidebarProvider>
        </OnboardingProvider>
      </SubscriptionProvider>
    </DeleteOperationProvider>
  );
}
