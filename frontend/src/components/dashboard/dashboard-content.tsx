'use client';

import React, { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { billingKeys } from '@/hooks/billing/use-subscription';
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
import { useInitiateAgentWithInvalidation, useThreadLimit } from '@/hooks/dashboard/use-initiate-agent';

import { useAgents } from '@/hooks/agents/use-agents';
import { PlanSelectionModal } from '@/components/billing/pricing';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { useAgentSelection } from '@/stores/agent-selection-store';
import { SunaModesPanel } from './suna-modes-panel';
import { useThreadQuery } from '@/hooks/threads/use-threads';
import { normalizeFilenameToNFC } from '@/lib/utils/unicode';
import { AgentRunLimitDialog } from '@/components/thread/agent-run-limit-dialog';
import { CustomAgentsSection } from './custom-agents-section';
import { toast } from 'sonner';
import { AgentConfigurationDialog } from '@/components/agents/agent-configuration-dialog';
import { useSunaModePersistence } from '@/stores/suna-modes-store';
import { CreditsDisplay } from '@/components/billing/credits-display';
import { Button } from '../ui/button';
import { Info, X } from 'lucide-react';
import { useLimits } from '@/hooks/dashboard/use-limits';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Progress } from '../ui/progress';
import { useTranslations } from 'next-intl';

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
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const { user } = useAuth();
  const chatInputRef = React.useRef<ChatInputHandles>(null);
  const initiateAgentMutation = useInitiateAgentWithInvalidation();
  const pricingModalStore = usePricingModalStore();

  const { data: agentsResponse } = useAgents({
    limit: 100,
    sort_by: 'name',
    sort_order: 'asc'
  });

  const agents = agentsResponse?.agents || [];
  const selectedAgent = selectedAgentId
    ? agents.find(agent => agent.agent_id === selectedAgentId)
    : null;
  const displayName = selectedAgent?.name || 'Suna';
  const agentAvatar = undefined;
  const isSunaAgent = selectedAgent?.metadata?.is_suna_default || false;

  const threadQuery = useThreadQuery(initiatedThreadId || '');
  const { data: threadLimit, isLoading: isThreadLimitLoading } = useThreadLimit();
  const { data: limits } = useLimits();
  const canCreateThread = threadLimit?.can_create || false;
  
  const isDismissed = typeof window !== 'undefined' && sessionStorage.getItem('threadLimitAlertDismissed') === 'true';
  // Only show alert after loading is complete and limit is actually exceeded
  const showAlert = !isThreadLimitLoading && !canCreateThread && !isDismissed;

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
  React.useEffect(() => {
    const checkoutSuccess = searchParams.get('checkout');
    const sessionId = searchParams.get('session_id');
    const clientSecret = searchParams.get('client_secret');
    
    // If we have checkout success indicators, invalidate billing queries
    if (checkoutSuccess === 'success' || sessionId || clientSecret) {
      console.log('🔄 Checkout success detected, invalidating billing queries...');
      queryClient.invalidateQueries({ queryKey: billingKeys.all });
      
      // Clean up URL params
      const url = new URL(window.location.href);
      url.searchParams.delete('checkout');
      url.searchParams.delete('session_id');
      url.searchParams.delete('client_secret');
      router.replace(url.pathname + url.search, { scroll: false });
    }
  }, [searchParams, queryClient, router]);

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
  }, [autoSubmit, inputValue, isSubmitting, isRedirecting]);

  return (
    <>
      <PlanSelectionModal />

      <div className="flex flex-col h-screen w-full overflow-hidden relative">
        {/* Credits Display - Top right corner */}
        <div className="absolute flex items-center gap-2 top-4 right-4 z-10">
          <CreditsDisplay />
          <Popover>
            <PopoverTrigger asChild>
              <Button size='icon' variant='outline'>
                <Info className='h-4 w-4'/>
              </Button>
            </PopoverTrigger>
            <PopoverContent align='end' className="w-70">
              <div>
                <h2 className="text-md font-medium mb-4">{t('usageLimits')}</h2>
                <div className="space-y-2">
                  <div className='space-y-2'>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">{t('threads')}</span>
                      <span className="font-medium">{limits?.thread_count?.current_count || 0} / {limits?.thread_count?.limit || 0}</span>
                    </div>
                    <Progress 
                      className='h-1'
                      value={((limits?.thread_count?.current_count || 0) / (limits?.thread_count?.limit || 1)) * 100} 
                    />
                  </div>
                  <div className='space-y-2'>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Custom Workers</span>
                      <span className="font-medium">{limits?.agent_count?.current_count || 0} / {limits?.agent_count?.limit || 0}</span>
                    </div>
                    <Progress 
                      className='h-1'
                      value={((limits?.agent_count?.current_count || 0) / (limits?.agent_count?.limit || 1)) * 100} 
                    />
                  </div>
                  <div className='space-y-2'>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">{t('scheduledTriggers')}</span>
                      <span className="font-medium">{limits?.trigger_count?.scheduled?.current_count || 0} / {limits?.trigger_count?.scheduled?.limit || 0}</span>
                    </div>
                    <Progress 
                      className='h-1'
                      value={((limits?.trigger_count?.scheduled?.current_count || 0) / (limits?.trigger_count?.scheduled?.limit || 1)) * 100} 
                    />
                  </div>
                  <div className='space-y-2'>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">{t('appTriggers')}</span>
                      <span className="font-medium">{limits?.trigger_count?.app?.current_count || 0} / {limits?.trigger_count?.app?.limit || 0}</span>
                    </div>
                    <Progress 
                      className='h-1'
                      value={((limits?.trigger_count?.app?.current_count || 0) / (limits?.trigger_count?.app?.limit || 1)) * 100} 
                    />
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>
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

                        {showAlert && (
                          <div 
                            className='w-full h-16 p-2 px-4 dark:bg-amber-500/5 bg-amber-500/10 dark:border-amber-500/10 border-amber-700/10 border text-white rounded-b-3xl flex items-center justify-between overflow-hidden'
                            style={{
                              marginTop: '-32px',
                              transition: 'margin-top 300ms ease-in-out, opacity 300ms ease-in-out',
                            }}
                          >
                            <span className='-mb-3.5 dark:text-amber-500 text-amber-700 text-sm'>{t('limitsExceeded')}</span>
                            <div className='flex items-center -mb-3.5'>
                              <Button 
                                size='sm' 
                                className='h-6 text-xs'
                                onClick={() => pricingModalStore.openPricingModal()}
                              >
                                {tCommon('upgrade')}
                                </Button>
                              {/* <Button 
                                size='icon' 
                                variant='ghost' 
                                className='h-6 text-muted-foreground'
                                onClick={() => {
                                  sessionStorage.setItem('threadLimitAlertDismissed', 'true');
                                  window.dispatchEvent(new Event('storage'));
                                }}
                              >
                                <X/>
                              </Button> */}
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
                        <CustomAgentsSection
                          onAgentSelect={setSelectedAgent}
                        />
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
        <AgentRunLimitDialog
          open={showAgentLimitDialog}
          onOpenChange={setShowAgentLimitDialog}
          runningCount={agentLimitData.runningCount}
          runningThreadIds={agentLimitData.runningThreadIds}
          projectId={undefined}
        />
      )}

      {configAgentId && (
        <AgentConfigurationDialog
          open={showConfigDialog}
          onOpenChange={setShowConfigDialog}
          agentId={configAgentId}
          onAgentChange={(newAgentId) => {
            setConfigAgentId(newAgentId);
            setSelectedAgent(newAgentId);
          }}
        />
      )}
    </>
  );
}
