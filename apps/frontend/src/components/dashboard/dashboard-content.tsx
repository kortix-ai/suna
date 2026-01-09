'use client';

import React, { useState, useEffect, Suspense, lazy } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { accountStateKeys } from '@/hooks/billing';
import {
  ChatInput,
  ChatInputHandles,
} from '@/components/thread/chat-input/chat-input';
import { useIsMobile, useLeadingDebouncedCallback } from '@/hooks/utils';
import { useAuth } from '@/components/AuthProvider';
import { config, isLocalMode, isStagingMode } from '@/lib/config';
import { useOptimisticAgentStart } from '@/hooks/threads';
import { useAccountState, accountStateSelectors, invalidateAccountState } from '@/hooks/billing';
import { getPlanName } from '@/components/billing/plan-utils';
import { useAgents } from '@/hooks/agents/use-agents';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { useAgentSelection } from '@/stores/agent-selection-store';
import { useThreadQuery } from '@/hooks/threads/use-threads';
import { toast } from '@/lib/toast';
import { useSunaModePersistence } from '@/stores/suna-modes-store';
import { Button } from '../ui/button';
import { X, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { NotificationDropdown } from '../notifications/notification-dropdown';
import { useSidebar } from '@/components/ui/sidebar';
import { useWelcomeBannerStore } from '@/stores/welcome-banner-store';
import { cn } from '@/lib/utils';
import { DynamicGreeting } from '@/components/ui/dynamic-greeting';
import { trackPurchase, getStoredCheckoutData, clearCheckoutData } from '@/lib/analytics/gtm';
import { getCheckoutSession } from '@/lib/api/billing';

// Lazy load heavy components that aren't immediately visible
// Note: PlanSelectionModal is rendered globally in layout.tsx
const UpgradeCelebration = lazy(() => 
  import('@/components/billing/upgrade-celebration').then(mod => ({ default: mod.UpgradeCelebration }))
);
const SunaModesPanel = lazy(() => 
  import('./suna-modes-panel').then(mod => ({ default: mod.SunaModesPanel }))
);
const AgentRunLimitBanner = lazy(() => 
  import('@/components/thread/agent-run-limit-banner').then(mod => ({ default: mod.AgentRunLimitBanner }))
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

const PENDING_PROMPT_KEY = 'pendingAgentPrompt';

export function DashboardContent() {
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const tBilling = useTranslations('billing');
  const tAuth = useTranslations('auth');
  const [inputValue, setInputValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [configAgentId, setConfigAgentId] = useState<string | null>(null);
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(false);
  
  const {
    selectedMode,
    selectedCharts,
    selectedOutputFormat,
    selectedTemplate,
    setSelectedMode,
    setSelectedCharts,
    setSelectedOutputFormat,
    setSelectedTemplate,
  } = useSunaModePersistence();
  
  const [viewMode, setViewMode] = useState<'super-worker' | 'worker-templates'>('super-worker');
  
  const {
    selectedAgentId,
    setSelectedAgent,
    initializeFromAgents,
    getCurrentAgent
  } = useAgentSelection();
  const [initiatedThreadId, setInitiatedThreadId] = useState<string | null>(null);
  
  // Use centralized optimistic agent start hook
  const {
    startAgent,
    isStarting: isOptimisticStarting,
    agentLimitData,
    showAgentLimitBanner,
    setShowAgentLimitBanner,
    clearAgentLimitData,
  } = useOptimisticAgentStart('/dashboard');
  const [showUpgradeCelebration, setShowUpgradeCelebration] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const { user } = useAuth();
  const { setOpen: setSidebarOpen } = useSidebar();
  const { isVisible: isWelcomeBannerVisible } = useWelcomeBannerStore();
  const chatInputRef = React.useRef<ChatInputHandles>(null);
  const pricingModalStore = usePricingModalStore();
  
  const prefetchedRouteRef = React.useRef<string | null>(null);
  const prefetchTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);

  const { data: agentsResponse, isLoading: isLoadingAgents } = useAgents({
    limit: 50, // Changed from 100 to 50 to match other components
    sort_by: 'name',
    sort_order: 'asc'
  });

  const agents = Array.isArray(agentsResponse?.agents) ? agentsResponse.agents : [];
  const selectedAgent = selectedAgentId
    ? agents.find(agent => agent.agent_id === selectedAgentId)
    : null;
  const sunaAgent = agents.find(agent => agent.metadata?.is_suna_default === true);
  const displayName = selectedAgent?.name || 'Kortix';
  const agentAvatar = undefined;
  // Show Kortix modes while loading (assume Kortix is default) or when Kortix agent is selected
  const isSunaAgent = isLoadingAgents 
    ? true // Show Kortix modes while loading
    : (selectedAgent?.metadata?.is_suna_default || (!selectedAgentId && sunaAgent !== undefined) || false);

  const threadQuery = useThreadQuery(initiatedThreadId || '');
  const { data: accountState, isLoading: isAccountStateLoading } = useAccountState({ enabled: !!user });
  const isLocal = isLocalMode();
  const planName = accountStateSelectors.planName(accountState);
  const canCreateThread = accountState?.limits?.threads?.can_create || false;
  
  const isDismissed = typeof window !== 'undefined' && sessionStorage.getItem('threadLimitAlertDismissed') === 'true';
  const threadLimitExceeded = !isAccountStateLoading && !canCreateThread && !isDismissed;
  
  const dailyCreditsInfo = accountState?.credits.daily_refresh;
  const hasLowCredits = accountStateSelectors.totalCredits(accountState) <= 10;
  const hasDailyRefresh = dailyCreditsInfo?.enabled && dailyCreditsInfo?.seconds_until_refresh;
  
  const isFreeTier = accountState?.subscription && (
    accountState.subscription.tier_key === 'free' ||
    accountState.subscription.tier_key === 'none' ||
    !accountState.subscription.tier_key
  );
  
  const alertType = hasLowCredits && hasDailyRefresh 
    ? 'daily_refresh' 
    : threadLimitExceeded 
    ? 'thread_limit' 
    : null;
  
  const formatTimeUntilRefresh = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  React.useEffect(() => {
    if (agents.length > 0) {
      initializeFromAgents(agents, undefined, setSelectedAgent);
    }
  }, [agents, initializeFromAgents, setSelectedAgent]);

  React.useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab === 'worker-templates') {
      setViewMode('worker-templates');
    } else {
      setViewMode('super-worker');
    }
  }, [searchParams]);

  React.useEffect(() => {
    const agentIdFromUrl = searchParams.get('agent_id');
    if (agentIdFromUrl && agentIdFromUrl !== selectedAgentId) {
      setSelectedAgent(agentIdFromUrl);
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('agent_id');
      router.replace(newUrl.pathname + newUrl.search, { scroll: false });
    }
  }, [searchParams, selectedAgentId, router, setSelectedAgent]);

  React.useEffect(() => {
    if (threadQuery.data && initiatedThreadId) {
      const thread = threadQuery.data;
      setIsRedirecting(true);
      if (thread.project_id) {
        router.push(`/projects/${thread.project_id}/thread/${initiatedThreadId}`);
      } else {
        router.push(`/agents/${initiatedThreadId}`);
      }
      setInitiatedThreadId(null);
    }
  }, [threadQuery.data, initiatedThreadId, router]);

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

  const handleSubmit = useLeadingDebouncedCallback(async (
    message: string,
    options?: {
      model_name?: string;
      enable_context_manager?: boolean;
    },
  ) => {
    if (
      (!message.trim() && !chatInputRef.current?.getPendingFiles().length) ||
      isSubmitting ||
      isRedirecting ||
      isOptimisticStarting
    )
      return;

    setIsSubmitting(true);
    localStorage.removeItem(PENDING_PROMPT_KEY);

    const fileIds = chatInputRef.current?.getUploadedFileIds() || [];
    const pendingFiles = chatInputRef.current?.getPendingFiles() || [];

    console.log('[Dashboard] Starting agent with:', {
      prompt: message.substring(0, 100),
      promptLength: message.length,
      model_name: options?.model_name,
      agent_id: selectedAgentId,
      fileIds: fileIds.length,
      pendingFiles: pendingFiles.length,
    });

    setIsRedirecting(true);

    const result = await startAgent({
      message,
      files: pendingFiles,
      fileIds: fileIds.length > 0 ? fileIds : undefined,
      modelName: options?.model_name,
      agentId: selectedAgentId || undefined,
    });

    if (!result) {
      // Error was handled by the hook, reset state
      chatInputRef.current?.clearPendingFiles();
      setIsSubmitting(false);
      setIsRedirecting(false);
    }
  }, 1200);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      const pendingPrompt = localStorage.getItem(PENDING_PROMPT_KEY);

      if (pendingPrompt) {
        setInputValue(pendingPrompt);
        setAutoSubmit(true);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, []);

  React.useEffect(() => {
    const dummyProjectId = 'prefetch-project';
    const dummyThreadId = 'prefetch-thread';
    const routeToPrefetch = `/projects/${dummyProjectId}/thread/${dummyThreadId}`;
    router.prefetch(routeToPrefetch);
    prefetchedRouteRef.current = routeToPrefetch;
  }, [router]);

  React.useEffect(() => {
    if (autoSubmit && inputValue && !isSubmitting && !isRedirecting) {
      const timer = setTimeout(() => {
        handleSubmit(inputValue);
        setAutoSubmit(false);
      }, 500);

      return () => clearTimeout(timer);
    }
    return undefined;
  }, [autoSubmit, inputValue, isSubmitting, isRedirecting, handleSubmit]);

  React.useEffect(() => {
    if (inputValue.trim() && !isSubmitting && !isRedirecting) {
      if (prefetchTimeoutRef.current) {
        clearTimeout(prefetchTimeoutRef.current);
      }

      prefetchTimeoutRef.current = setTimeout(() => {
        const dummyProjectId = 'prefetch-project';
        const dummyThreadId = 'prefetch-thread';
        const routeToPrefetch = `/projects/${dummyProjectId}/thread/${dummyThreadId}`;
        
        if (prefetchedRouteRef.current !== routeToPrefetch) {
          router.prefetch(routeToPrefetch);
          prefetchedRouteRef.current = routeToPrefetch;
        }
      }, 300);
    }

    return () => {
      if (prefetchTimeoutRef.current) {
        clearTimeout(prefetchTimeoutRef.current);
      }
    };
  }, [inputValue, isSubmitting, isRedirecting, router]);

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
            {/* Tabs at the top */}
            {/* {(isStagingMode() || isLocalMode()) && (
              <div className="px-4 pt-4 pb-4">
                <div className="flex items-center justify-center gap-2 p-1 bg-muted/50 rounded-xl w-fit mx-auto">
                  <button
                    onClick={() => {
                      setViewMode('super-worker');
                      setSelectedMode(null);
                      router.push('/dashboard');
                    }}
                    className={cn(
                      "px-4 py-2 text-sm font-medium rounded-lg transition-all duration-200",
                      viewMode === 'super-worker'
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    Kortix
                  </button>
                  <button
                    onClick={() => {
                      setViewMode('worker-templates');
                      setSelectedMode(null);
                      router.push('/dashboard?tab=worker-templates');
                    }}
                    className={cn(
                      "px-4 py-2 text-sm font-medium rounded-lg transition-all duration-200",
                      viewMode === 'worker-templates'
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    AI Worker Templates
                  </button>
                </div>
              </div>
            )} */}
            

            <div className="flex-1 flex items-start justify-center pt-[25vh] sm:pt-[30vh]">
              {viewMode === 'super-worker' && (
                <div className="w-full">
                  <div className="px-4 py-6 sm:py-8">
                    <div className="w-full max-w-3xl mx-auto flex flex-col items-center space-y-5 sm:space-y-6 md:space-y-8">
                      <div className="flex flex-col items-center text-center w-full animate-in fade-in-0 slide-in-from-bottom-4 duration-500 fill-mode-both">
                        <DynamicGreeting className="text-2xl sm:text-2xl md:text-3xl font-normal text-foreground/90" />
                      </div>

                      <div className="w-full flex flex-col items-center animate-in fade-in-0 slide-in-from-bottom-4 duration-500 delay-100 fill-mode-both">
                        <ChatInput
                          ref={chatInputRef}
                          onSubmit={handleSubmit}
                          loading={isSubmitting || isRedirecting}
                          placeholder={t('describeWhatYouNeed')}
                          value={inputValue}
                          onChange={setInputValue}
                          hideAttachments={false}
                          selectedAgentId={selectedAgentId}
                          onAgentSelect={setSelectedAgent}
                          enableAdvancedConfig={false}
                          onConfigureAgent={(agentId) => {
                            setConfigAgentId(agentId);
                            setShowConfigDialog(true);
                          }}
                          selectedMode={selectedMode}
                          onModeDeselect={() => setSelectedMode(null)}
                          animatePlaceholder={true}
                          selectedCharts={selectedCharts}
                          selectedOutputFormat={selectedOutputFormat}
                          selectedTemplate={selectedTemplate}
                        />

                        {alertType === 'daily_refresh' && (
                          <div 
                            className='w-full h-16 p-2 px-4 dark:bg-blue-500/5 bg-blue-500/10 dark:border-blue-500/10 border-blue-700/10 border rounded-b-3xl flex items-center justify-between overflow-hidden'
                            style={{
                              marginTop: '-40px',
                              transition: 'margin-top 300ms ease-in-out, opacity 300ms ease-in-out',
                            }}
                          >
                            <span className='-mb-3.5 dark:text-blue-400 text-blue-700 text-sm'>
                              {tBilling('creditsExhausted', { time: formatTimeUntilRefresh(dailyCreditsInfo!.seconds_until_refresh!) })}
                            </span>
                            <div className='flex items-center -mb-3.5'>
                              <Button 
                                size='sm' 
                                className='h-6 text-xs'
                                onClick={() => pricingModalStore.openPricingModal()}
                              >
                              {tCommon('upgrade')}
                              </Button>
                            </div>
                          </div>
                        )}

                        {alertType === 'thread_limit' && (
                          <div 
                            className='w-full h-16 p-2 px-4 dark:bg-amber-500/5 bg-amber-500/10 dark:border-amber-500/10 border-amber-700/10 border text-white rounded-b-3xl flex items-center justify-center overflow-hidden cursor-pointer hover:bg-amber-500/15 transition-colors'
                            style={{
                              marginTop: '-40px',
                              transition: 'margin-top 300ms ease-in-out, opacity 300ms ease-in-out',
                            }}
                            onClick={() => pricingModalStore.openPricingModal()}
                          >
                            <span className='-mb-3.5 dark:text-amber-500 text-amber-700 text-sm flex items-center gap-1'>
                              {t('limitsExceeded')}
                              <ChevronRight className='h-4 w-4' />
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Modes Panel - Below chat input, doesn't affect its position */}
                  {isSunaAgent && (
                    <div className="px-4 pb-6 sm:pb-8 animate-in fade-in-0 slide-in-from-bottom-4 duration-500 delay-200 fill-mode-both">
                      <div className="max-w-3xl mx-auto">
                        <Suspense fallback={<div className="h-24 bg-muted/10 rounded-lg animate-pulse" />}>
                          <SunaModesPanel
                            selectedMode={selectedMode}
                            onModeSelect={setSelectedMode}
                            onSelectPrompt={setInputValue}
                            isMobile={isMobile}
                            selectedCharts={selectedCharts}
                            onChartsChange={setSelectedCharts}
                            selectedOutputFormat={selectedOutputFormat}
                            onOutputFormatChange={setSelectedOutputFormat}
                            selectedTemplate={selectedTemplate}
                            onTemplateChange={setSelectedTemplate}
                            isFreeTier={isFreeTier || false}
                            onUpgradeClick={() => pricingModalStore.openPricingModal()}
                          />
                        </Suspense>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {(viewMode === 'worker-templates') && (
                <div className="w-full animate-in fade-in-0 duration-300">
                  {(isStagingMode() || isLocalMode()) && (
                    <div className="w-full px-4 pb-8">
                      <div className="max-w-5xl mx-auto">
                        <Suspense fallback={<div className="h-64 bg-muted/10 rounded-lg animate-pulse" />}>
                          <CustomAgentsSection
                            onAgentSelect={setSelectedAgent}
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

      {agentLimitData && (
        <Suspense fallback={null}>
          <AgentRunLimitBanner
            open={showAgentLimitBanner && !!agentLimitData}
            onOpenChange={(open) => {
              setShowAgentLimitBanner(open);
              if (!open) {
                clearAgentLimitData();
              }
            }}
            runningCount={agentLimitData.runningCount}
            runningThreadIds={agentLimitData.runningThreadIds}
          />
        </Suspense>
      )}

      {configAgentId && (
        <Suspense fallback={null}>
          <AgentConfigurationDialog
            open={showConfigDialog}
            onOpenChange={setShowConfigDialog}
            agentId={configAgentId}
            onAgentChange={(newAgentId) => {
              setConfigAgentId(newAgentId);
              setSelectedAgent(newAgentId);
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
