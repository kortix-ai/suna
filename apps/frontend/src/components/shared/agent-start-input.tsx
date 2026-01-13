'use client';

import React, { Suspense, lazy } from 'react';
import { ChatInput } from '@/components/thread/chat-input/chat-input';
import { useAgentStartInput, UseAgentStartInputOptions } from '@/hooks/dashboard';
import { useTranslations } from 'next-intl';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import { useAccountState, accountStateSelectors } from '@/hooks/billing';
import { useAuth } from '@/components/AuthProvider';
import { Button } from '@/components/ui/button';
import { ChevronRight } from 'lucide-react';
import { DynamicGreeting } from '@/components/ui/dynamic-greeting';

// Lazy load heavy components
const SunaModesPanel = lazy(() => 
  import('@/components/dashboard/suna-modes-panel').then(mod => ({ default: mod.SunaModesPanel }))
);
const AgentRunLimitBanner = lazy(() => 
  import('@/components/thread/agent-run-limit-banner').then(mod => ({ default: mod.AgentRunLimitBanner }))
);

export interface AgentStartInputProps {
  /** Variant determines layout and styling */
  variant?: 'hero' | 'dashboard';
  /** Custom placeholder text */
  placeholder?: string;
  /** Whether this component is for logged-in users only */
  requireAuth?: boolean;
  /** Callback when auth is required but user is not logged in */
  onAuthRequired?: (pendingMessage: string) => void;
  /** Path to redirect on error */
  redirectOnError?: string;
  /** Whether to show greeting */
  showGreeting?: boolean;
  /** Custom greeting className */
  greetingClassName?: string;
  /** Whether to enable advanced config in chat input */
  enableAdvancedConfig?: boolean;
  /** Callback when agent configuration is requested */
  onConfigureAgent?: (agentId: string) => void;
  /** Whether to animate placeholder */
  animatePlaceholder?: boolean;
  /** Whether to hide attachments */
  hideAttachments?: boolean;
  /** Whether to auto-focus input */
  autoFocus?: boolean;
  /** Whether to show modes panel */
  showModesPanel?: boolean;
  /** Whether to show alert banners (credit/thread limit) */
  showAlertBanners?: boolean;
  /** Is mobile flag (optional, can be computed internally) */
  isMobile?: boolean;
  /** Whether to show the isLoggedIn indicator on chat input */
  showLoginStatus?: boolean;
  /** Custom wrapper className for the input section */
  inputWrapperClassName?: string;
  /** Custom wrapper className for the modes panel */
  modesPanelWrapperClassName?: string;
}

export function AgentStartInput({
  variant = 'dashboard',
  placeholder,
  requireAuth = true,
  onAuthRequired,
  redirectOnError,
  showGreeting = true,
  greetingClassName,
  enableAdvancedConfig = false,
  onConfigureAgent,
  animatePlaceholder = false,
  hideAttachments = false,
  autoFocus = false,
  showModesPanel = true,
  showAlertBanners = true,
  isMobile = false,
  showLoginStatus = false,
  inputWrapperClassName,
  modesPanelWrapperClassName,
}: AgentStartInputProps) {
  const t = useTranslations('dashboard');
  const tSuna = useTranslations('suna');
  const tCommon = useTranslations('common');
  const tBilling = useTranslations('billing');
  
  const { user } = useAuth();
  const pricingModalStore = usePricingModalStore();
  const { data: accountState, isLoading: isAccountStateLoading } = useAccountState({ enabled: !!user });
  
  const isFreeTier = accountState?.subscription && (
    accountState.subscription.tier_key === 'free' ||
    accountState.subscription.tier_key === 'none' ||
    !accountState.subscription.tier_key
  );
  
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
  
  const {
    inputValue,
    setInputValue,
    isSubmitting,
    isRedirecting,
    chatInputRef,
    selectedAgentId,
    setSelectedAgent,
    isSunaAgent,
    selectedMode,
    selectedCharts,
    selectedOutputFormat,
    selectedTemplate,
    setSelectedMode,
    setSelectedCharts,
    setSelectedOutputFormat,
    setSelectedTemplate,
    agentLimitData,
    showAgentLimitBanner,
    setShowAgentLimitBanner,
    clearAgentLimitData,
    handleSubmit,
  } = useAgentStartInput({
    redirectOnError: redirectOnError || (variant === 'hero' ? '/' : '/dashboard'),
    requireAuth,
    onAuthRequired,
    enableAutoSubmit: variant === 'dashboard',
    logPrefix: variant === 'hero' ? '[HeroSection]' : '[Dashboard]',
  });
  
  const resolvedPlaceholder = placeholder || (variant === 'hero' ? tSuna('describeTask') : t('describeWhatYouNeed'));
  
  const defaultGreetingClass = variant === 'hero'
    ? "text-2xl sm:text-3xl md:text-3xl lg:text-4xl font-medium text-balance text-center px-4 sm:px-2"
    : "text-2xl sm:text-2xl md:text-3xl font-normal text-foreground/90";
  
  return (
    <>
      {/* Greeting */}
      {showGreeting && (
        <div className="flex flex-col items-center text-center w-full animate-in fade-in-0 slide-in-from-bottom-4 duration-500 fill-mode-both">
          <DynamicGreeting className={greetingClassName || defaultGreetingClass} />
        </div>
      )}
      
      {/* Chat Input Section */}
      <div className={inputWrapperClassName || "w-full flex flex-col items-center animate-in fade-in-0 slide-in-from-bottom-4 duration-500 delay-100 fill-mode-both"}>
        <ChatInput
          ref={chatInputRef}
          onSubmit={handleSubmit}
          placeholder={resolvedPlaceholder}
          loading={isSubmitting || isRedirecting}
          disabled={isSubmitting}
          value={inputValue}
          onChange={setInputValue}
          isLoggedIn={showLoginStatus ? !!user : undefined}
          selectedAgentId={selectedAgentId}
          onAgentSelect={setSelectedAgent}
          autoFocus={autoFocus}
          enableAdvancedConfig={enableAdvancedConfig}
          onConfigureAgent={onConfigureAgent}
          selectedMode={selectedMode}
          onModeDeselect={() => setSelectedMode(null)}
          animatePlaceholder={animatePlaceholder}
          hideAttachments={hideAttachments}
          selectedCharts={selectedCharts}
          selectedOutputFormat={selectedOutputFormat}
          selectedTemplate={selectedTemplate}
        />
        
        {/* Alert Banners */}
        {showAlertBanners && alertType === 'daily_refresh' && (
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

        {showAlertBanners && alertType === 'thread_limit' && (
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
      
      {/* Suna Modes Panel */}
      {showModesPanel && isSunaAgent && (
        <div className={modesPanelWrapperClassName || "w-full animate-in fade-in-0 slide-in-from-bottom-4 duration-500 delay-200 fill-mode-both"}>
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
      )}
      
      {/* Agent Run Limit Banner */}
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
    </>
  );
}

