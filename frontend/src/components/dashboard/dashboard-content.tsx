'use client';

import React, { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { billingKeys } from '@/hooks/billing/use-subscription';
import {
  ChatInput,
  ChatInputHandles,
} from '@/components/thread/chat-input/chat-input';
import { AgentRunLimitError, ProjectLimitError, BillingError } from '@/lib/api/errors';
import { useIsMobile } from '@/hooks/utils';
import { useAuth } from '@/components/AuthProvider';
import { config, isLocalMode, isStagingMode } from '@/lib/config';
import { useInitiateAgentWithInvalidation } from '@/hooks/dashboard/use-initiate-agent';

import { useAgents } from '@/hooks/agents/use-agents';
import { PlanSelectionModal } from '@/components/billing/pricing';
import { useBillingModal } from '@/hooks/billing/use-billing-modal';
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

const PENDING_PROMPT_KEY = 'pendingAgentPrompt';


export function DashboardContent() {
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
  const {
    showModal: showBillingModal,
    creditsExhausted,
    openModal: openBillingModal,
    closeModal: closeBillingModal,
  } = useBillingModal();

  // Feature flag for custom agents section

  // Fetch agents to get the selected agent's name
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
        // Don't reset isSubmitting here - keep loading until redirect happens
      } else {
        throw new Error('Agent initiation did not return a thread_id.');
      }
      chatInputRef.current?.clearPendingFiles();
    } catch (error: any) {
      console.error('Error during submission process:', error);
      if (error instanceof BillingError) {
        openBillingModal(error);
      } else if (error instanceof AgentRunLimitError) {
        const { running_thread_ids, running_count } = error.detail;
        setAgentLimitData({
          runningCount: running_count,
          runningThreadIds: running_thread_ids,
        });
        setShowAgentLimitDialog(true);
      } else if (error instanceof ProjectLimitError) {
        openBillingModal(error);
      } else {
        const errorMessage = error instanceof Error ? error.message : 'Operation failed';
        toast.error(errorMessage);
      }
      // Only reset loading state if there was an error or no thread_id was returned
      setIsSubmitting(false);
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
      <PlanSelectionModal
        open={showBillingModal}
        onOpenChange={closeBillingModal}
        creditsExhausted={creditsExhausted}
      />

      <div className="flex flex-col h-screen w-full overflow-hidden relative">
        {/* Credits Display - Top right corner */}
        <div className="absolute top-4 right-4 z-10">
          <CreditsDisplay />
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
            

            {/* Centered content area */}
            <div className="flex-1 flex items-start justify-center pt-[30vh]">
              {/* Super Worker View - Suna only */}
              {viewMode === 'super-worker' && (
                <div className="w-full animate-in fade-in-0 duration-300">
                  {/* Title and chat input - Fixed position */}
                  <div className="px-4 py-8">
                    <div className="w-full max-w-3xl mx-auto flex flex-col items-center space-y-6 md:space-y-8">
                      <div className="flex flex-col items-center text-center w-full">
                        <p
                          className="tracking-tight text-2xl md:text-3xl font-normal text-foreground/90"
                        >
                          What do you want to get done?
                        </p>
                      </div>

                      <div className="w-full">
                        <ChatInput
                          ref={chatInputRef}
                          onSubmit={handleSubmit}
                          loading={isSubmitting || isRedirecting}
                          placeholder="Describe what you need help with..."
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
