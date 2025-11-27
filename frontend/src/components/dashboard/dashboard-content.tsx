'use client';

import React, { useState, Suspense, lazy } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { accountStateKeys } from '@/hooks/billing';
import {
  ChatInput,
  ChatInputHandles,
} from '@/components/thread/chat-input/chat-input';
import { 
  AgentRunLimitError, 
  ProjectLimitError, 
  BillingError,
  ThreadLimitError,
  AgentCountLimitError,
  TriggerLimitError,
  CustomWorkerLimitError,
  ModelAccessDeniedError
} from '@/lib/api/errors';
import { useIsMobile } from '@/hooks/utils';
import { useAuth } from '@/components/AuthProvider';
import { config, isLocalMode, isStagingMode } from '@/lib/config';
import { useInitiateAgentWithInvalidation } from '@/hooks/dashboard/use-initiate-agent';
import { useAccountState, accountStateSelectors, invalidateAccountState } from '@/hooks/billing';
import { getPlanName } from '@/components/billing/plan-utils';
import { useAgents } from '@/hooks/agents/use-agents';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { useAgentSelection } from '@/stores/agent-selection-store';
import { useThreadQuery } from '@/hooks/threads/use-threads';
import { normalizeFilenameToNFC } from '@/lib/utils/unicode';
import { toast } from 'sonner';
import { useSunaModePersistence } from '@/stores/suna-modes-store';
import { Button } from '../ui/button';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { NotificationDropdown } from '../notifications/notification-dropdown';
import { UsageLimitsPopover } from './usage-limits-popover';
import { useSidebar } from '@/components/ui/sidebar';

// Lazy load heavy components that aren't immediately visible
const PlanSelectionModal = lazy(() => 
  import('@/components/billing/pricing').then(mod => ({ default: mod.PlanSelectionModal }))
);
const UpgradeCelebration = lazy(() => 
  import('@/components/billing/upgrade-celebration').then(mod => ({ default: mod.UpgradeCelebration }))
);
const SunaModesPanel = lazy(() => 
  import('./suna-modes-panel').then(mod => ({ default: mod.SunaModesPanel }))
);
const AgentRunLimitDialog = lazy(() => 
  import('@/components/thread/agent-run-limit-dialog').then(mod => ({ default: mod.AgentRunLimitDialog }))
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

const PENDING_PROMPT_KEY = 'pendingAgentPrompt';


export function DashboardContent() {
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const tBilling = useTranslations('billing');
  const [inputValue, setInputValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [configAgentId, setConfigAgentId] = useState<string | null>(null);
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(false);
  
  // Use centralized Suna modes persistence hook
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
  const [showAgentLimitDialog, setShowAgentLimitDialog] = useState(false);
  const [agentLimitData, setAgentLimitData] = useState<{
    runningCount: number;
    runningThreadIds: string[];
  } | null>(null);
  const [showUpgradeCelebration, setShowUpgradeCelebration] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const { user } = useAuth();
  const { setOpen: setSidebarOpen } = useSidebar();
  const chatInputRef = React.useRef<ChatInputHandles>(null);
  const initiateAgentMutation = useInitiateAgentWithInvalidation();
  const pricingModalStore = usePricingModalStore();

  const { data: agentsResponse, isLoading: isLoadingAgents } = useAgents({
    limit: 50, // Changed from 100 to 50 to match other components
    sort_by: 'name',
    sort_order: 'asc'
  });

  const agents = agentsResponse?.agents || [];
  const selectedAgent = selectedAgentId
    ? agents.find(agent => agent.agent_id === selectedAgentId)
    : null;
  const sunaAgent = agents.find(agent => agent.metadata?.is_suna_default === true);
  const displayName = selectedAgent?.name || 'Suna';
  const agentAvatar = undefined;
  // Show Suna modes while loading (assume Suna is default) or when Suna agent is selected
  const isSunaAgent = isLoadingAgents 
    ? true // Show Suna modes while loading
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
  }, [searchParams, queryClient, router, setSidebarOpen]);

  const handleSubmit = async (
    message: string,
    options?: {
      model_name?: string;
      enable_context_manager?: boolean;
    },
  ) => {
    if (
      (!message.trim() && !chatInputRef.current?.getPendingFiles().length) ||
      isSubmitting ||
      isRedirecting
    )
      return;

    setIsSubmitting(true);

    try {
      const files = chatInputRef.current?.getPendingFiles() || [];
      localStorage.removeItem(PENDING_PROMPT_KEY);

      const formData = new FormData();
      
      // Always append prompt - it's required for new threads
      // The message should never be empty due to validation above, but ensure we always send it
      const trimmedMessage = message.trim();
      if (!trimmedMessage && files.length === 0) {
        setIsSubmitting(false);
        throw new Error('Prompt is required when starting a new agent');
      }
      // Always append prompt (even if empty, backend will validate)
      formData.append('prompt', trimmedMessage || message);

      // Add selected agent if one is chosen
      if (selectedAgentId) {
        formData.append('agent_id', selectedAgentId);
      }

      files.forEach((file, index) => {
        const normalizedName = normalizeFilenameToNFC(file.name);
        formData.append('files', file, normalizedName);
      });

      if (options?.model_name && options.model_name.trim()) {
        formData.append('model_name', options.model_name.trim());
      }
      formData.append('stream', 'true'); // Always stream for better UX
      formData.append('enable_context_manager', String(options?.enable_context_manager ?? false));

      // Debug logging
      console.log('[Dashboard] Starting agent with:', {
        prompt: message.substring(0, 100),
        promptLength: message.length,
        model_name: options?.model_name,
        agent_id: selectedAgentId,
        filesCount: files.length,
      });

      const result = await initiateAgentMutation.mutateAsync(formData);

      if (result.thread_id) {
        setInitiatedThreadId(result.thread_id);
      } else {
        throw new Error('Agent initiation did not return a thread_id.');
      }
      chatInputRef.current?.clearPendingFiles();
    } catch (error: any) {
      console.error('Error during submission process:', error);
      if (error instanceof ProjectLimitError) {
        pricingModalStore.openPricingModal({ 
          isAlert: true,
          alertTitle: `${tBilling('reachedLimit')} ${tBilling('projectLimit', { current: error.detail.current_count, limit: error.detail.limit })}` 
        });
      } else if (error instanceof ThreadLimitError) {
        pricingModalStore.openPricingModal({ 
          isAlert: true,
          alertTitle: `${tBilling('reachedLimit')} ${tBilling('threadLimit', { current: error.detail.current_count, limit: error.detail.limit })}` 
        });
      } else if (error instanceof BillingError) {
        const message = error.detail?.message?.toLowerCase() || '';
        const isCreditsExhausted = 
          message.includes('credit') ||
          message.includes('balance') ||
          message.includes('insufficient') ||
          message.includes('out of credits') ||
          message.includes('no credits');
        
        pricingModalStore.openPricingModal({ 
          isAlert: true,
          alertTitle: isCreditsExhausted ? 'You ran out of credits. Upgrade now.' : 'Pick the plan that works for you.'
        });
      } else if (error instanceof AgentRunLimitError) {
        const { running_thread_ids, running_count } = error.detail;
        setAgentLimitData({
          runningCount: running_count,
          runningThreadIds: running_thread_ids,
        });
        setShowAgentLimitDialog(true);
      } else {
        const errorMessage = error instanceof Error ? error.message : 'Operation failed';
        toast.error(errorMessage);
      }
      setInputValue('');
      chatInputRef.current?.clearPendingFiles();
      setIsSubmitting(false);
      setIsRedirecting(false);
    }
  };

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
    if (autoSubmit && inputValue && !isSubmitting && !isRedirecting) {
      const timer = setTimeout(() => {
        handleSubmit(inputValue);
        setAutoSubmit(false);
      }, 500);

      return () => clearTimeout(timer);
    }
    return undefined;
  }, [autoSubmit, inputValue, isSubmitting, isRedirecting, handleSubmit]);

  return (
    <>
      <Suspense fallback={null}>
        <PlanSelectionModal />
      </Suspense>

      <div className="flex flex-col h-screen w-full overflow-hidden relative">
        <div className="absolute flex items-center gap-2 top-4 right-4">
        <NotificationDropdown />
          <Suspense fallback={<div className="h-8 w-20 bg-muted/30 rounded animate-pulse" />}>
            <CreditsDisplay />
          </Suspense>
          <UsageLimitsPopover />
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
                    Kortix Super Worker
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
            

            <div className="flex-1 flex items-start justify-center pt-[30vh]">
              {viewMode === 'super-worker' && (
                <div className="w-full animate-in fade-in-0 duration-300">
                  <div className="px-4 py-8">
                    <div className="w-full max-w-3xl mx-auto flex flex-col items-center space-y-6 md:space-y-8">
                      <div className="flex flex-col items-center text-center w-full">
                        <p
                          className="tracking-tight text-2xl md:text-3xl font-normal text-foreground/90"
                        >
                          {t('whatWouldYouLike')}
                        </p>
                      </div>

                      <div className="w-full flex flex-col items-center">
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
                            className='w-full h-16 p-2 px-4 dark:bg-amber-500/5 bg-amber-500/10 dark:border-amber-500/10 border-amber-700/10 border text-white rounded-b-3xl flex items-center justify-between overflow-hidden'
                            style={{
                              marginTop: '-40px',
                              transition: 'margin-top 300ms ease-in-out, opacity 300ms ease-in-out',
                            }}
                          >
                            <span className='-mb-3.5 dark:text-amber-500 text-amber-700 text-sm'>
                              {t('limitsExceeded', { 
                                current: accountState?.limits?.threads?.current ?? 0, 
                                limit: accountState?.limits?.threads?.max ?? 0 
                              })}
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
                      </div>
                    </div>
                  </div>

                  {/* Modes Panel - Below chat input, doesn't affect its position */}
                  {isSunaAgent && (
                    <div className="px-4 pb-8">
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
          <AgentRunLimitDialog
            open={showAgentLimitDialog}
            onOpenChange={setShowAgentLimitDialog}
            runningCount={agentLimitData.runningCount}
            runningThreadIds={agentLimitData.runningThreadIds}
            projectId={undefined}
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
