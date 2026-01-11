'use client';

import React, { useState, Suspense, lazy } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useIsMobile } from '@/hooks/utils';
import { useAuth } from '@/components/AuthProvider';
import { isLocalMode, isStagingMode } from '@/lib/config';
import { useAccountState, accountStateSelectors, invalidateAccountState } from '@/hooks/billing';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { toast } from '@/lib/toast';
import { useSidebar } from '@/components/ui/sidebar';
import { useWelcomeBannerStore } from '@/stores/welcome-banner-store';
import { cn } from '@/lib/utils';
import { trackPurchase, getStoredCheckoutData, clearCheckoutData } from '@/lib/analytics/gtm';
import { getCheckoutSession } from '@/lib/api/billing';
import { useTranslations } from 'next-intl';
import { NotificationDropdown } from '../notifications/notification-dropdown';
import { AgentStartInput } from '@/components/shared/agent-start-input';

// Lazy load heavy components that aren't immediately visible
const UpgradeCelebration = lazy(() => 
  import('@/components/billing/upgrade-celebration').then(mod => ({ default: mod.UpgradeCelebration }))
);
const CustomAgentsSection = lazy(() => 
  import('./custom-agents-section').then(mod => ({ default: mod.CustomAgentsSection }))
);
const AgentConfigurationDialog = lazy(() => 
  import('@/components/agents/agent-configuration-dialog').then(mod => ({ default: mod.AgentConfigurationDialog }))
);
const CreditsDisplay = lazy(() => 
  import('@/components/billing/credits-display').then(mod => ({ default: mod.CreditsDisplay }))
);
const ModeIndicator = lazy(() => 
  import('@/components/thread/mode-indicator').then(mod => ({ default: mod.ModeIndicator }))
);

export function DashboardContent() {
  const t = useTranslations('dashboard');
  const tAuth = useTranslations('auth');
  
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [configAgentId, setConfigAgentId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'super-worker' | 'worker-templates'>('super-worker');
  const [showUpgradeCelebration, setShowUpgradeCelebration] = useState(false);
  
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const { user } = useAuth();
  const { setOpen: setSidebarOpen } = useSidebar();
  const { isVisible: isWelcomeBannerVisible } = useWelcomeBannerStore();
  
  const { data: accountState, isLoading: isAccountStateLoading } = useAccountState({ enabled: !!user });
  const planName = accountStateSelectors.planName(accountState);

  // Handle tab changes from URL
  React.useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab === 'worker-templates') {
      setViewMode('worker-templates');
    } else {
      setViewMode('super-worker');
    }
  }, [searchParams]);

  // Check for checkout success and invalidate billing queries
  // Handle subscription success - show celebration
  const celebrationTriggeredRef = React.useRef(false);
  
  React.useEffect(() => {
    // Prevent double-triggering
    if (celebrationTriggeredRef.current) return;
    
    const subscriptionSuccess = searchParams.get('subscription');
    const checkoutSuccess = searchParams.get('checkout');
    const sessionId = searchParams.get('session_id');
    const clientSecret = searchParams.get('client_secret');
    
    // If we have checkout/subscription success indicators
    if (subscriptionSuccess === 'success' || checkoutSuccess === 'success' || sessionId || clientSecret) {
      console.log('🎉 Subscription success detected! Showing celebration...');
      celebrationTriggeredRef.current = true;
      
      // Track purchase event for GTM/GA4
      // Fetch actual transaction amounts from Stripe for accurate tracking
      const trackPurchaseEvent = async () => {
        const checkoutData = getStoredCheckoutData();
        if (!checkoutData) return;
        
        // Default values from stored checkout data
        let transactionValue = checkoutData.value;
        let discountAmount = checkoutData.discount || 0;
        let taxAmount = 0;
        let couponId = checkoutData.coupon || '';
        let currency = checkoutData.currency;
        
        // Transaction ID for GA4 - prefer balance_transaction_id (txn_xxx), fallback to session_id
        let transactionId = sessionId || `txn_${Date.now()}`;
        
        // If we have a session_id, fetch actual amounts from Stripe
        // This also validates that the payment was actually successful
        if (sessionId) {
          try {
            const stripeSession = await getCheckoutSession(sessionId);
            if (stripeSession) {
              // IMPORTANT: Only track purchase if payment was actually successful
              // This prevents false positives from failed payments or manual URL navigation
              if (stripeSession.payment_status !== 'paid' && stripeSession.status !== 'complete') {
                console.warn('[GTM] Purchase NOT tracked - payment not confirmed:', {
                  payment_status: stripeSession.payment_status,
                  status: stripeSession.status
                });
                return; // Don't track purchase for failed/incomplete payments
              }
              
              // Use actual amounts from Stripe (convert from cents to dollars)
              transactionValue = stripeSession.amount_total / 100;
              discountAmount = stripeSession.amount_discount / 100;
              taxAmount = stripeSession.amount_tax / 100;
              
              // Use balance_transaction_id (txn_xxx) as transaction_id if available
              // Fallback to session_id if no charge was made (e.g., 100% discount)
              if (stripeSession.balance_transaction_id) {
                transactionId = stripeSession.balance_transaction_id;
              }
              // Prefer promotion_code (customer-facing like "HEHE2020") over coupon_id
              couponId = stripeSession.promotion_code || stripeSession.coupon_name || stripeSession.coupon_id || '';
              currency = stripeSession.currency.toUpperCase();
              console.log('[GTM] Using Stripe session data:', {
                amount_total: stripeSession.amount_total,
                amount_discount: stripeSession.amount_discount,
                amount_tax: stripeSession.amount_tax,
                promotion_code: stripeSession.promotion_code,
                coupon_name: stripeSession.coupon_name,
                coupon_id: stripeSession.coupon_id,
                payment_status: stripeSession.payment_status
              });
            } else {
              console.warn('[GTM] Stripe session returned null - purchase NOT tracked to avoid false positives');
              return; // Don't track without verified session
            }
          } catch (error) {
            console.warn('[GTM] Could not fetch Stripe session - purchase NOT tracked:', error);
            return; // Don't track without verified session
          }
        } else {
          console.warn('[GTM] No session_id available - purchase NOT tracked to avoid false positives');
          return; // Don't track without session_id
        }
        
        // Determine customer_type based on previous tier
        // 'new' = first time subscriber (was free/none)
        // 'returning' = upgrading/changing from a paid plan
        const previousTier = checkoutData.previous_tier || 'none';
        const isReturningCustomer = previousTier !== 'none' && previousTier !== 'free';
        const customerType = isReturningCustomer ? 'returning' : 'new';
        
        trackPurchase({
          transaction_id: transactionId, // txn_xxx from Stripe or session_id as fallback
          value: transactionValue, // Actual transaction value after discounts (from Stripe)
          tax: taxAmount, // Tax amount from Stripe
          currency: currency,
          coupon: couponId,
          customer_type: customerType,
          items: [{
            item_id: checkoutData.item_id,       // e.g., "pro_yearly" - matches add_to_cart
            item_name: checkoutData.item_name,   // e.g., "Pro Yearly" - matches add_to_cart
            coupon: couponId,
            discount: discountAmount,
            item_brand: 'Kortix AI',
            item_category: 'Plans',
            item_list_id: 'plans_listing',
            item_list_name: 'Plans Listing',
            price: checkoutData.price, // Product price (before discounts)
            quantity: 1,
          }],
          customer: {
            name: user?.user_metadata?.name || user?.user_metadata?.full_name || '',
            email: user?.email || '',
          },
        });
        clearCheckoutData();
      };
      
      // Execute purchase tracking
      trackPurchaseEvent();
      
      // Invalidate and force refetch billing queries to refresh data immediately
      // This ensures fresh data after checkout, bypassing staleTime
      // Use invalidateAccountState helper which includes debouncing
      invalidateAccountState(queryClient, true, true); // skipCache=true to bypass backend cache after checkout
      
      // Close sidebar for cleaner celebration view
      setSidebarOpen(false);
      
      // Show celebration immediately
      setShowUpgradeCelebration(true);
      
      // Clean up URL params after a short delay
      setTimeout(() => {
        const url = new URL(window.location.href);
        url.searchParams.delete('subscription');
        url.searchParams.delete('checkout');
        url.searchParams.delete('session_id');
        url.searchParams.delete('client_secret');
        router.replace(url.pathname + url.search, { scroll: false });
      }, 100);
    }
  }, [searchParams, queryClient, router, setSidebarOpen, user]);

  // Handle expired link notification for logged-in users
  React.useEffect(() => {
    const linkExpired = searchParams.get('linkExpired');
    if (linkExpired === 'true') {
      toast.info(tAuth('magicLinkExpired'), {
        description: tAuth('magicLinkExpiredDescription'),
        duration: 5000,
      });
      
      // Clean up URL param
      const url = new URL(window.location.href);
      url.searchParams.delete('linkExpired');
      router.replace(url.pathname + url.search, { scroll: false });
    }
  }, [searchParams, router, tAuth]);

  // Handle agent_id from URL
  const [selectedAgentIdFromUrl, setSelectedAgentIdFromUrl] = useState<string | null>(null);
  
  React.useEffect(() => {
    const agentIdFromUrl = searchParams.get('agent_id');
    if (agentIdFromUrl) {
      setSelectedAgentIdFromUrl(agentIdFromUrl);
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('agent_id');
      router.replace(newUrl.pathname + newUrl.search, { scroll: false });
    }
  }, [searchParams, router]);

  const handleConfigureAgent = (agentId: string) => {
    setConfigAgentId(agentId);
    setShowConfigDialog(true);
  };

  return (
    <>
      {/* PlanSelectionModal is rendered globally in layout.tsx - no duplicate needed here */}

      <div className="flex flex-col h-screen w-full overflow-hidden relative">
        {/* Left side - Mode Selector */}
        <div className={cn(
          "absolute flex items-center gap-2 left-4 transition-[top] duration-200",
          isWelcomeBannerVisible ? "top-14" : "top-4"
        )}>
          <Suspense fallback={<div className="h-9 w-32 bg-muted/30 rounded-lg animate-pulse" />}>
            <ModeIndicator />
          </Suspense>
        </div>

        {/* Right side - Notifications & Credits */}
        <div className={cn(
          "absolute flex items-center gap-2 right-4 transition-[top] duration-200",
          isWelcomeBannerVisible ? "top-14" : "top-4"
        )}>
          <NotificationDropdown />
          <Suspense fallback={<div className="h-8 w-20 bg-muted/30 rounded animate-pulse" />}>
            <CreditsDisplay />
          </Suspense>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="min-h-full flex flex-col">
            <div className="flex-1 flex items-start justify-center pt-[25vh] sm:pt-[30vh]">
              {viewMode === 'super-worker' && (
                <div className="w-full">
                  <div className="px-4 py-6 sm:py-8">
                    <div className="w-full max-w-3xl mx-auto flex flex-col items-center space-y-5 sm:space-y-6 md:space-y-8">
                      <AgentStartInput
                        variant="dashboard"
                        requireAuth={true}
                        redirectOnError="/dashboard"
                        showGreeting={true}
                        greetingClassName="text-2xl sm:text-2xl md:text-3xl font-normal text-foreground/90"
                        enableAdvancedConfig={false}
                        onConfigureAgent={handleConfigureAgent}
                        animatePlaceholder={true}
                        hideAttachments={false}
                        showAlertBanners={true}
                        showModesPanel={true}
                        isMobile={isMobile}
                        inputWrapperClassName="w-full flex flex-col items-center animate-in fade-in-0 slide-in-from-bottom-4 duration-500 delay-100 fill-mode-both"
                        modesPanelWrapperClassName="px-4 pb-6 sm:pb-8 animate-in fade-in-0 slide-in-from-bottom-4 duration-500 delay-200 fill-mode-both max-w-3xl mx-auto"
                      />
                    </div>
                  </div>
                </div>
              )}
              {(viewMode === 'worker-templates') && (
                <div className="w-full animate-in fade-in-0 duration-300">
                  {(isStagingMode() || isLocalMode()) && (
                    <div className="w-full px-4 pb-8">
                      <div className="max-w-5xl mx-auto">
                        <Suspense fallback={<div className="h-64 bg-muted/10 rounded-lg animate-pulse" />}>
                          <CustomAgentsSection
                            onAgentSelect={() => {}}
                          />
                        </Suspense>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {configAgentId && (
        <Suspense fallback={null}>
          <AgentConfigurationDialog
            open={showConfigDialog}
            onOpenChange={setShowConfigDialog}
            agentId={configAgentId}
            onAgentChange={(newAgentId) => {
              setConfigAgentId(newAgentId);
            }}
          />
        </Suspense>
      )}

      {/* Upgrade Celebration Modal */}
      <Suspense fallback={null}>
        <UpgradeCelebration
          isOpen={showUpgradeCelebration}
          onClose={() => setShowUpgradeCelebration(false)}
          planName={planName}
          isLoading={isAccountStateLoading}
        />
      </Suspense>
    </>
  );
}
