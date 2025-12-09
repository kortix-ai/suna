'use client';

import React, {
  useState,
  useRef,
  useEffect,
  forwardRef,
  useImperativeHandle,
  useCallback,
  useMemo,
  memo,
} from 'react';
import { useAgents } from '@/hooks/agents/use-agents';
import { useAgentSelection } from '@/stores/agent-selection-store';

import { Card, CardContent } from '@/components/ui/card';
import { handleFiles, FileUploadHandler } from './file-upload-handler';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { X, Image as ImageIcon, Presentation, BarChart3, FileText, Search, Users, Code2, Sparkles, Brain as BrainIcon, MessageSquare, CornerDownLeft, Plug, Lock } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { VoiceRecorder } from './voice-recorder';
import { useTheme } from 'next-themes';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { UnifiedConfigMenu } from './unified-config-menu';
import { AttachmentGroup } from '../attachment-group';
import { cn } from '@/lib/utils';
import { useModelSelection } from '@/hooks/agents';
import { useFileDelete } from '@/hooks/files';
import { useQueryClient } from '@tanstack/react-query';
import { ToolCallInput } from './floating-tool-preview';
import { ChatSnack } from './chat-snack';
import { Brain, Zap, Database, ArrowDown, ArrowUp, Wrench, Clock, Send } from 'lucide-react';
import { useMessageQueueStore } from '@/stores/message-queue-store';
import { useComposioToolkitIcon } from '@/hooks/composio/use-composio';
import { Skeleton } from '@/components/ui/skeleton';

import { IntegrationsRegistry } from '@/components/agents/integrations-registry';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAccountState, accountStateSelectors } from '@/hooks/billing';
import { isStagingMode, isLocalMode } from '@/lib/config';
import { PlanSelectionModal } from '@/components/billing/pricing';
import { AgentConfigurationDialog } from '@/components/agents/agent-configuration-dialog';
import { SpotlightCard } from '@/components/ui/spotlight-card';

import posthog from 'posthog-js';

// ============================================================================
// ISOLATED TEXTAREA - Manages its own state to prevent parent re-renders
// ============================================================================

interface IsolatedTextareaProps {
  initialValue?: string;
  placeholder: string;
  disabled: boolean;
  isDraggingOver: boolean;
  onSubmit: () => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  hasFiles: boolean;
  loading: boolean;
  isAgentRunning: boolean;
  isUploading: boolean;
  valueRef: React.MutableRefObject<string>;
  onHasContentChange: (hasContent: boolean) => void;
}

const IsolatedTextarea = memo(forwardRef<HTMLTextAreaElement, IsolatedTextareaProps>(function IsolatedTextarea({
  initialValue = '',
  placeholder,
  disabled,
  isDraggingOver,
  onSubmit,
  onPaste,
  hasFiles,
  loading,
  isAgentRunning,
  isUploading,
  valueRef,
  onHasContentChange,
}, ref) {
  const [value, setValue] = useState(initialValue);
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const prevHasContent = useRef(false);
  
  // Use the forwarded ref or internal ref
  useImperativeHandle(ref, () => internalRef.current!, []);
  
  // Keep parent's valueRef in sync
  useEffect(() => {
    valueRef.current = value;
  }, [value, valueRef]);
  
  // Notify parent when hasContent changes (but not on every keystroke)
  useEffect(() => {
    const hasContent = value.trim().length > 0;
    if (hasContent !== prevHasContent.current) {
      prevHasContent.current = hasContent;
      onHasContentChange(hasContent);
    }
  }, [value, onHasContentChange]);

  // Auto-resize textarea
  const adjustHeight = useCallback(() => {
    const el = internalRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.maxHeight = '200px';
    el.style.overflowY = el.scrollHeight > 200 ? 'auto' : 'hidden';
    const newHeight = Math.min(el.scrollHeight, 200);
    el.style.height = `${newHeight}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  useEffect(() => {
    window.addEventListener('resize', adjustHeight);
    return () => window.removeEventListener('resize', adjustHeight);
  }, [adjustHeight]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
  }, []);

  // Detect if we're on a mobile device
  const isMobile = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || 
           (window.innerWidth <= 768 && 'ontouchstart' in window);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // On mobile, allow Enter to create a new line instead of submitting
    if (isMobile && e.key === 'Enter' && !e.shiftKey) {
      // Allow default behavior (new line) on mobile
      return;
    }
    
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const hasContent = value.trim().length > 0;
      if (
        (hasContent || hasFiles) &&
        !loading &&
        (!disabled || isAgentRunning) &&
        !isUploading
      ) {
        onSubmit();
      }
    }
  }, [value, hasFiles, loading, disabled, isAgentRunning, isUploading, onSubmit, isMobile]);

  // Expose methods to clear/set value from parent
  useEffect(() => {
    const textarea = internalRef.current;
    if (textarea) {
      (textarea as any).clearValue = () => setValue('');
      (textarea as any).appendValue = (text: string) => {
        setValue(prev => prev ? `${prev} ${text}` : text);
      };
    }
  }, []);

  return (
    <div className="flex flex-col gap-1 px-2">
      <Textarea
        ref={internalRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
        placeholder={placeholder}
        className={cn(
          'w-full bg-transparent dark:bg-transparent border-none shadow-none focus-visible:ring-0 px-0.5 pb-6 pt-4 min-h-[100px] sm:min-h-[72px] max-h-[200px] overflow-y-auto resize-none rounded-[24px]',
          // Use 16px on mobile to prevent zoom, 15px on desktop
          isMobile ? '!text-[16px]' : '!text-[15px]',
          isDraggingOver ? 'opacity-40' : '',
        )}
        disabled={disabled && !isAgentRunning}
        rows={1}
      />
    </div>
  );
}));

// ============================================================================
// MEMOIZED SUB-COMPONENTS (to prevent re-renders on typing)
// ============================================================================

// Integrations dropdown - isolated from typing state
interface IntegrationsDropdownProps {
  isLoggedIn: boolean;
  loading: boolean;
  disabled: boolean;
  isAgentRunning: boolean;
  isFreeTier: boolean;
  quickIntegrations: Array<{ id: string; name: string; slug: string }>;
  integrationIcons: Record<string, string | undefined>;
  onOpenRegistry: (slug: string | null) => void;
  onOpenPlanModal: () => void;
}

const IntegrationsDropdown = memo(function IntegrationsDropdown({
  isLoggedIn,
  loading,
  disabled,
  isAgentRunning,
  isFreeTier,
  quickIntegrations,
  integrationIcons,
  onOpenRegistry,
  onOpenPlanModal,
}: IntegrationsDropdownProps) {
  if (!isLoggedIn) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <div className="relative">
              <Button
                variant="outline"
                size="sm"
                className="h-10 w-10 p-0 bg-transparent border-[1.5px] border-border rounded-2xl text-muted-foreground hover:text-foreground hover:bg-accent/50 flex items-center justify-center cursor-pointer"
                disabled={loading || (disabled && !isAgentRunning)}
              >
                <Plug className="h-5 w-5" />
              </Button>
              {isFreeTier && !isLocalMode() && (
                <div className="absolute -top-1 -right-1 w-4 h-4 bg-primary rounded-full flex items-center justify-center z-10 pointer-events-none">
                  <Lock className="h-2.5 w-2.5 text-primary-foreground" strokeWidth={2.5} />
                </div>
              )}
            </div>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[320px] px-0 py-3 border-[1.5px] border-border rounded-2xl" sideOffset={6}>
            <div className="px-3 mb-3">
              <span className="text-xs font-medium text-muted-foreground pl-1">Integrations</span>
            </div>
            <div className="space-y-0.5 px-2 relative">
              {quickIntegrations.map((integration) => (
                <SpotlightCard 
                  key={integration.id} 
                  className={cn(
                    "transition-colors bg-transparent",
                    isFreeTier && !isLocalMode() ? "cursor-not-allowed" : "cursor-pointer"
                  )}
                >
                  <div
                    className={cn(
                      "flex items-center gap-3 text-sm px-1 py-1 relative",
                      isFreeTier && !isLocalMode() && "blur-[3px] opacity-70"
                    )}
                    onClick={() => {
                      if (!isFreeTier || isLocalMode()) {
                        onOpenRegistry(integration.slug);
                      }
                    }}
                  >
                    <div className="flex items-center justify-center w-8 h-8 bg-card border-[1.5px] border-border flex-shrink-0" style={{ borderRadius: '10.4px' }}>
                      {integrationIcons[integration.id] ? (
                        <img
                          src={integrationIcons[integration.id]}
                          alt={integration.name}
                          className="h-4 w-4"
                        />
                      ) : (
                        <div className="h-4 w-4 bg-muted rounded" />
                      )}
                    </div>
                    <span className="flex-1 truncate font-medium">{integration.name}</span>
                    <span className="text-xs text-muted-foreground">Connect</span>
                  </div>
                </SpotlightCard>
              ))}
              <SpotlightCard 
                className={cn(
                  "transition-colors bg-transparent",
                  isFreeTier && !isLocalMode() ? "cursor-not-allowed" : "cursor-pointer"
                )}
              >
                <div
                  className={cn(
                    "flex items-center gap-3 text-sm cursor-pointer px-1 py-1 min-h-[40px] relative",
                    isFreeTier && !isLocalMode() && "blur-[3px] opacity-70"
                  )}
                  onClick={() => {
                    if (!isFreeTier || isLocalMode()) {
                      onOpenRegistry(null);
                    }
                  }}
                >
                  <span className="text-muted-foreground font-medium">+ See all integrations</span>
                </div>
              </SpotlightCard>
              
              {isFreeTier && !isLocalMode() && (
                <div className="absolute inset-0 z-10 pointer-events-none">
                  <div className="absolute inset-0 bg-background/60 backdrop-blur-sm rounded-lg" />
                  <div className="relative h-full flex flex-col items-center justify-center px-6 py-5 gap-4">
                    <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/10 border border-primary/20">
                      <Lock className="h-5 w-5 text-primary" strokeWidth={2} />
                    </div>
                    <div className="text-center space-y-1">
                      <p className="text-sm font-semibold text-foreground">Unlock Integrations</p>
                      <p className="text-xs text-muted-foreground max-w-[200px]">
                        Connect Google Drive, Slack, Notion, and 100+ apps
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onOpenRegistry(null)}
                      className="h-8 px-4 text-xs font-medium shadow-md hover:shadow-lg transition-all pointer-events-auto"
                    >
                      Explore
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipTrigger>
      <TooltipContent side="top">
        <p>Connect integrations</p>
      </TooltipContent>
    </Tooltip>
  );
});

// Mode button - isolated from typing state
interface ModeButtonProps {
  selectedMode: string | null | undefined;
  isModeDismissing: boolean;
  onDeselect: () => void;
}

const ModeButton = memo(function ModeButton({
  selectedMode,
  isModeDismissing,
  onDeselect,
}: ModeButtonProps) {
  if (!selectedMode && !isModeDismissing) return null;

  const getModeIcon = (mode: string) => {
    const iconClass = "w-4 h-4";
    switch (mode) {
      case 'research':
        return <Search className={iconClass} />;
      case 'people':
        return <Users className={iconClass} />;
      case 'code':
        return <Code2 className={iconClass} />;
      case 'docs':
        return <FileText className={iconClass} />;
      case 'data':
        return <BarChart3 className={iconClass} />;
      case 'slides':
        return <Presentation className={iconClass} />;
      case 'image':
        return <ImageIcon className={iconClass} />;
      default:
        return null;
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isModeDismissing) {
          onDeselect();
        }
      }}
      className={cn(
        "h-8 px-2 sm:px-3 py-2 bg-transparent border border-border rounded-2xl text-muted-foreground hover:text-foreground hover:bg-accent/50 flex items-center gap-1 sm:gap-1.5 cursor-pointer transition-all duration-200 flex-shrink-0",
        !isModeDismissing && "animate-in fade-in-0 zoom-in-95",
        isModeDismissing && "animate-out fade-out-0 zoom-out-95"
      )}
    >
      {selectedMode && getModeIcon(selectedMode)}
      <span className="hidden sm:inline text-sm">{selectedMode?.charAt(0).toUpperCase()}{selectedMode?.slice(1)}</span>
      <X className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
    </Button>
  );
});

// Kortix agent modes switcher - isolated from typing state
interface SunaAgentModeSwitcherProps {
  enabled: boolean;
  isSunaAgent: boolean;
  sunaAgentModes: 'adaptive' | 'autonomous' | 'chat';
  onModeChange: (mode: 'adaptive' | 'autonomous' | 'chat') => void;
}

const SunaAgentModeSwitcher = memo(function SunaAgentModeSwitcher({
  enabled,
  isSunaAgent,
  sunaAgentModes,
  onModeChange,
}: SunaAgentModeSwitcherProps) {
  if (!enabled || !(isStagingMode() || isLocalMode()) || !isSunaAgent) return null;

  return (
    <div className="flex items-center gap-1 p-0.5 bg-muted/50 rounded-lg">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => onModeChange('adaptive')}
            className={cn(
              "p-1.5 rounded-md transition-all duration-200 cursor-pointer",
              sunaAgentModes === 'adaptive'
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-background/50"
            )}
          >
            <Sparkles className="w-4 h-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <div className="space-y-1">
            <p className="font-medium text-white">Adaptive</p>
            <p className="text-xs text-gray-200">Quick responses with smart context switching</p>
          </div>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => onModeChange('autonomous')}
            className={cn(
              "p-1.5 rounded-md transition-all duration-200 cursor-pointer",
              sunaAgentModes === 'autonomous'
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-background/50"
            )}
          >
            <BrainIcon className="w-4 h-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <div className="space-y-1">
            <p className="font-medium text-white">Autonomous</p>
            <p className="text-xs text-gray-200">Deep work mode for multi-step problem solving</p>
          </div>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => onModeChange('chat')}
            className={cn(
              "p-1.5 rounded-md transition-all duration-200 cursor-pointer",
              sunaAgentModes === 'chat'
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-background/50"
            )}
          >
            <MessageSquare className="w-4 h-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <div className="space-y-1">
            <p className="font-medium text-white">Chat</p>
            <p className="text-xs text-gray-200">Simple back-and-forth conversation</p>
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
});

// Memoized submit button to prevent re-rendering entire controls on every keystroke
interface SubmitButtonProps {
  hasContent: boolean;
  hasFiles: boolean;
  isAgentRunning: boolean;
  loading: boolean;
  disabled: boolean;
  isUploading: boolean;
  onStopAgent?: () => void;
  onSubmit: (e: React.FormEvent) => void;
  buttonLoaderVariant: 'black' | 'white';
  pendingFilesCount: number;
}

const SubmitButton = memo(function SubmitButton({
  hasContent,
  hasFiles,
  isAgentRunning,
  loading,
  disabled,
  isUploading,
  onStopAgent,
  onSubmit,
  buttonLoaderVariant,
  pendingFilesCount,
}: SubmitButtonProps) {
  const isDisabled = 
    (!hasContent && !hasFiles && !isAgentRunning) ||
    loading ||
    (disabled && !isAgentRunning) ||
    isUploading;

  // Message queue feature flag
  const ENABLE_MESSAGE_QUEUE = false;
  // When agent is running and user has typed something, show queue button
  const showAddToQueue = ENABLE_MESSAGE_QUEUE && isAgentRunning && (hasContent || hasFiles);
  const buttonAction = showAddToQueue ? onSubmit : (isAgentRunning && onStopAgent ? onStopAgent : onSubmit);

  return (
    <div className="relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="submit"
            onClick={buttonAction}
            size="sm"
            className={cn(
              "flex-shrink-0 self-end border-[1.5px] border-border rounded-2xl relative z-10 transition-all duration-200",
              showAddToQueue ? "h-10 px-3" : "w-10 h-10",
              (loading || isUploading) && "opacity-100 [&[disabled]]:opacity-100"
            )}
            disabled={isDisabled}
          >
            {((loading || isUploading) && !isAgentRunning) ? (
              <KortixLoader size="small" customSize={20} variant={buttonLoaderVariant} />
            ) : showAddToQueue ? (
              <MessageSquare className="h-4 w-4" />
            ) : isAgentRunning ? (
              <div className="min-h-[14px] min-w-[14px] w-[14px] h-[14px] rounded-sm bg-current" />
            ) : (
              <CornerDownLeft className="h-5 w-5" />
            )}
          </Button>
        </TooltipTrigger>
        {isUploading ? (
          <TooltipContent side="top">
            <p>Uploading {pendingFilesCount} file{pendingFilesCount !== 1 ? 's' : ''}...</p>
          </TooltipContent>
        ) : showAddToQueue ? (
          <TooltipContent side="top">
            <p>Add to queue</p>
          </TooltipContent>
        ) : isAgentRunning ? (
          <TooltipContent side="top">
            <p>Stop agent</p>
          </TooltipContent>
        ) : null}
      </Tooltip>
    </div>
  );
});

export type SubscriptionStatus = 'no_subscription' | 'active';

export interface ChatInputHandles {
  getPendingFiles: () => File[];
  clearPendingFiles: () => void;
  setValue: (value: string) => void;
  getValue: () => string;
}

export interface ChatInputProps {
  onSubmit: (
    message: string,
    options?: {
      model_name?: string;
      agent_id?: string;
    },
  ) => void;
  placeholder?: string;
  loading?: boolean;
  disabled?: boolean;
  isAgentRunning?: boolean;
  onStopAgent?: () => void;
  autoFocus?: boolean;
  value?: string;
  onChange?: (value: string) => void;
  onFileBrowse?: () => void;
  sandboxId?: string;
  hideAttachments?: boolean;
  selectedAgentId?: string;
  onAgentSelect?: (agentId: string | undefined) => void;
  agentName?: string;
  messages?: any[];
  bgColor?: string;
  toolCalls?: ToolCallInput[];
  toolCallIndex?: number;
  showToolPreview?: boolean;
  onExpandToolPreview?: () => void;
  isLoggedIn?: boolean;
  enableAdvancedConfig?: boolean;
  onConfigureAgent?: (agentId: string) => void;
  hideAgentSelection?: boolean;
  defaultShowSnackbar?: 'tokens' | 'upgrade' | false;
  showToLowCreditUsers?: boolean;
  showScrollToBottomIndicator?: boolean;
  onScrollToBottom?: () => void;
  selectedMode?: string | null;
  onModeDeselect?: () => void;
  animatePlaceholder?: boolean;
  selectedCharts?: string[];
  selectedOutputFormat?: string | null;
  selectedTemplate?: string | null;
  threadId?: string | null;
  projectId?: string;
}

export interface UploadedFile {
  name: string;
  path: string;
  size: number;
  type: string;
  localUrl?: string;
}



export const ChatInput = memo(forwardRef<ChatInputHandles, ChatInputProps>(
  (
    {
      onSubmit,
      placeholder = 'Describe what you need help with...',
      loading = false,
      disabled = false,
      isAgentRunning = false,
      onStopAgent,
      autoFocus = true,
      value: controlledValue,
      onChange: controlledOnChange,
      onFileBrowse,
      sandboxId,
      hideAttachments = false,
      selectedAgentId,
      onAgentSelect,
      agentName,
      messages = [],
      bgColor = 'bg-card',
      toolCalls = [],
      toolCallIndex = 0,
      showToolPreview = false,
      onExpandToolPreview,
      isLoggedIn = true,
      enableAdvancedConfig = false,
      onConfigureAgent,
      hideAgentSelection = false,
      defaultShowSnackbar = false,
      showToLowCreditUsers = true,
      showScrollToBottomIndicator = false,
      onScrollToBottom,
      selectedMode,
      onModeDeselect,
      animatePlaceholder = false,
      selectedCharts = [],
      selectedOutputFormat = null,
      selectedTemplate = null,
      threadId = null,
      projectId,
    },
    ref,
  ) => {
    // =========================================================================
    // STATE MANAGEMENT - Optimized to prevent re-renders on typing
    // =========================================================================
    
    // Ref to access current value - textarea manages its own state
    const valueRef = useRef('');
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    
    // hasContent state - only changes when empty/non-empty state changes (not every keystroke)
    const [hasContent, setHasContent] = useState(false);
    
    // File state
    const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
    const uploadedFilesRef = useRef(uploadedFiles);
    uploadedFilesRef.current = uploadedFiles;
    
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const [isUploading, setIsUploading] = useState(false);
    const [isDraggingOver, setIsDraggingOver] = useState(false);
    const [hasSubmitted, setHasSubmitted] = useState(false);
    const [isSendingFiles, setIsSendingFiles] = useState(false);

    // Derived values
    const hasFiles = uploadedFiles.length > 0;
    const pendingFilesCount = pendingFiles.length;
    
    // Controlled mode support
    const isControlled = controlledValue !== undefined && controlledOnChange !== undefined;

    const [registryDialogOpen, setRegistryDialogOpen] = useState(false);
    const [selectedIntegration, setSelectedIntegration] = useState<string | null>(null);
    const [showSnackbar, setShowSnackbar] = useState(defaultShowSnackbar);
    const [userDismissedUsage, setUserDismissedUsage] = useState(false);
    const [planModalOpen, setPlanSelectionModalOpen] = useState(false);
    const [agentConfigDialog, setAgentConfigDialog] = useState<{ open: boolean; tab: 'instructions' | 'knowledge' | 'triggers' | 'tools' | 'integrations' }>({ open: false, tab: 'instructions' });
    const [mounted, setMounted] = useState(false);
    const [animatedPlaceholder, setAnimatedPlaceholder] = useState('');
    const [isModeDismissing, setIsModeDismissing] = useState(false);    // Kortix Agent Modes feature flag
    const ENABLE_SUNA_AGENT_MODES = false;
    const [sunaAgentModes, setSunaAgentModes] = useState<'adaptive' | 'autonomous' | 'chat'>('adaptive');

    const {
      selectedModel,
      setSelectedModel: handleModelChange,
      subscriptionStatus,
      allModels: modelOptions,
      canAccessModel,
      getActualModelId,
      refreshCustomModels,
    } = useModelSelection();

    const { data: accountState, isLoading: isAccountStateLoading } = useAccountState({ enabled: isLoggedIn });
    const deleteFileMutation = useFileDelete();
    const queryClient = useQueryClient();
    
    // Transform accountState to subscriptionData format for backward compatibility
    const subscriptionData = accountState ? (() => {
      const isFreeTier = accountState.subscription.tier_key === 'free' || 
                         accountState.subscription.tier_key === 'none' ||
                         accountState.tier.monthly_credits === 0;
      
      // For free tier with daily credits, use daily credits
      if (isFreeTier && accountState.credits.daily_refresh?.enabled) {
        const dailyAmount = accountState.credits.daily_refresh.daily_amount || 0;
        const dailyRemaining = accountState.credits.daily || 0;
        const currentUsage = Math.max(0, dailyAmount - dailyRemaining);
        
        return {
          tier_key: accountState.subscription.tier_key,
          tier: {
            name: accountState.subscription.tier_key,
            display_name: accountState.subscription.tier_display_name,
          },
          plan_name: accountState.subscription.tier_display_name,
          status: accountState.subscription.status,
          current_usage: currentUsage,
          cost_limit: dailyAmount,
          credits: {
            balance: accountState.credits.total,
            tier_credits: dailyAmount,
          },
        };
      }
      
      // For paid tiers, use monthly credits
      const monthlyCreditsGranted = accountState.tier.monthly_credits || 0;
      const monthlyCreditsRemaining = accountState.credits.monthly || 0;
      const currentUsage = Math.max(0, monthlyCreditsGranted - monthlyCreditsRemaining);
      
      return {
        tier_key: accountState.subscription.tier_key,
        tier: {
          name: accountState.subscription.tier_key,
          display_name: accountState.subscription.tier_display_name,
        },
        plan_name: accountState.subscription.tier_display_name,
        status: accountState.subscription.status,
        current_usage: currentUsage,
        cost_limit: monthlyCreditsGranted,
        credits: {
          balance: accountState.credits.total,
          tier_credits: accountState.tier.monthly_credits,
        },
      };
    })() : null;
    
    // Check if user is on free tier
    const isFreeTier = accountState && (
      accountState.subscription.tier_key === 'free' ||
      accountState.subscription.tier_key === 'none' ||
      !accountState.subscription.tier_key
    );
    
    // Chat input button has inverted background from theme
    // Dark theme → light button → needs black loader
    // Light theme → dark button → needs white loader
    const { resolvedTheme } = useTheme();
    const buttonLoaderVariant = (resolvedTheme === 'dark' ? 'black' : 'white') as 'black' | 'white';

    // Define quick integrations
    const quickIntegrations = useMemo(() => [
      { id: 'googledrive', name: 'Google Drive', slug: 'googledrive' },
      { id: 'slack', name: 'Slack', slug: 'slack' },
      { id: 'notion', name: 'Notion', slug: 'notion' },
    ], []);

    // Fetch integration icons when logged in
    const { data: googleDriveIcon } = useComposioToolkitIcon('googledrive', { enabled: isLoggedIn });
    const { data: slackIcon } = useComposioToolkitIcon('slack', { enabled: isLoggedIn });
    const { data: notionIcon } = useComposioToolkitIcon('notion', { enabled: isLoggedIn });

    // Map icons to integrations
    const integrationIcons = useMemo(() => ({
      'googledrive': googleDriveIcon?.icon_url,
      'slack': slackIcon?.icon_url,
      'notion': notionIcon?.icon_url,
    }), [googleDriveIcon, slackIcon, notionIcon]);
    
    // Show usage preview logic:
    // - For free users with daily credits: only show when they've used 70%+ of daily credits
    // - For paid users: only show when they're at 70% or more of their monthly credit limit
    const shouldShowUsage = useMemo(() => {
      if (!accountState || !subscriptionData || !showToLowCreditUsers || isLocalMode()) return false;

      const costLimit = subscriptionData.cost_limit || 0;
      const currentUsage = subscriptionData.current_usage || 0;
      
      // Don't show if no limit is set
      if (costLimit === 0) return false;

      // Show when at 70% or more of limit (30% or less remaining)
      return currentUsage >= (costLimit * 0.7);
    }, [accountState, subscriptionData, showToLowCreditUsers, isLocalMode]);

    // Auto-show usage preview when we have subscription data
    useEffect(() => {
      if (shouldShowUsage && defaultShowSnackbar !== false && !userDismissedUsage && (showSnackbar === false || showSnackbar === defaultShowSnackbar)) {
        setShowSnackbar('upgrade');
      } else if (!shouldShowUsage && showSnackbar !== false) {
        setShowSnackbar(false);
      }
    }, [subscriptionData, showSnackbar, defaultShowSnackbar, shouldShowUsage, subscriptionStatus, showToLowCreditUsers, userDismissedUsage]);

    const fileInputRef = useRef<HTMLInputElement>(null);

    const { data: agentsResponse, isLoading: isLoadingAgents } = useAgents({}, { enabled: isLoggedIn });
    const agents = agentsResponse?.agents || [];

    // Check if selected agent is Kortix based on agent data
    // While loading, default to Kortix (assume Kortix is the default agent)
    const selectedAgent = agents.find(agent => agent.agent_id === selectedAgentId);
    const sunaAgent = agents.find(agent => agent.metadata?.is_suna_default === true);
    const isSunaAgent = isLoadingAgents 
        ? true // Show Kortix modes while loading
        : (selectedAgent?.metadata?.is_suna_default || (!selectedAgentId && sunaAgent !== undefined) || false);

    const { initializeFromAgents } = useAgentSelection();
    useImperativeHandle(ref, () => ({
      getPendingFiles: () => pendingFiles,
      clearPendingFiles: () => setPendingFiles([]),
      setValue: (newValue: string) => {
        // Use the textarea's custom method if available
        const textarea = textareaRef.current as any;
        if (textarea?.clearValue) {
          textarea.clearValue();
          if (newValue) textarea.appendValue(newValue);
        }
        valueRef.current = newValue;
      },
      getValue: () => valueRef.current,
    }), [pendingFiles]);

    useEffect(() => {
      if (agents.length > 0 && !onAgentSelect) {
        initializeFromAgents(agents);
      }
    }, [agents, onAgentSelect, initializeFromAgents]);

    useEffect(() => {
      setMounted(true);
    }, []);

    // Typewriter effect for placeholder
    useEffect(() => {
      if (!mounted || hasContent || !animatePlaceholder) {
        setAnimatedPlaceholder(placeholder);
        return;
      }

      let currentIndex = 0;
      setAnimatedPlaceholder('');

      const typingInterval = setInterval(() => {
        if (currentIndex < placeholder.length) {
          setAnimatedPlaceholder(placeholder.slice(0, currentIndex + 1));
          currentIndex++;
        } else {
          clearInterval(typingInterval);
        }
      }, 50); // 50ms per character

      return () => clearInterval(typingInterval);
    }, [mounted, placeholder, hasContent, animatePlaceholder]);

    // Reset mode dismissing state when selectedMode changes
    useEffect(() => {
      setIsModeDismissing(false);
    }, [selectedMode]);

    // Generate Markdown for selected data options
    const generateDataOptionsMarkdown = useCallback(() => {
      if (selectedMode !== 'data' || (selectedCharts.length === 0 && !selectedOutputFormat)) {
        return '';
      }

      let markdown = '\n\n----\n\n**Data Visualization Requirements:**\n';

      if (selectedOutputFormat) {
        markdown += `\n- **Output Format:** ${selectedOutputFormat}`;
      }

      if (selectedCharts.length > 0) {
        markdown += '\n- **Preferred Charts:**';
        selectedCharts.forEach(chartId => {
          markdown += `\n  - ${chartId}`;
        });
      }

      return markdown;
    }, [selectedMode, selectedCharts, selectedOutputFormat]);

    // Generate Markdown for selected slides template
    const generateSlidesTemplateMarkdown = useCallback(() => {
      if (selectedMode !== 'slides' || !selectedTemplate) {
        return '';
      }
      
      return `\n\n----\n\n**Presentation Template:** ${selectedTemplate}`;
    }, [selectedMode, selectedTemplate]);

    // Handle mode deselection with animation
    const handleModeDeselect = useCallback(() => {
      setIsModeDismissing(true);
      setTimeout(() => {
        onModeDeselect?.();
        setIsModeDismissing(false);
      }, 200); // Match animation duration
    }, [onModeDeselect]);

    // Auto-focus textarea on mount
    useEffect(() => {
      if (autoFocus && textareaRef.current) {
        textareaRef.current.focus();
      }
    }, [autoFocus]);

    // Track previous isAgentRunning value to detect actual transitions
    const prevIsAgentRunning = useRef(isAgentRunning);
    
    // Clear input only when agent STARTS running (transitions from false to true)
    // This prevents clearing when agent stops or when component re-renders
    useEffect(() => {
      const wasRunning = prevIsAgentRunning.current;
      prevIsAgentRunning.current = isAgentRunning;
      
      // Only clear when agent actually starts (false → true transition)
      if (isAgentRunning && !wasRunning) {
        // Clear the isolated textarea
        const textarea = textareaRef.current as any;
        if (textarea?.clearValue) {
          textarea.clearValue();
        }
        valueRef.current = '';
        setHasContent(false);
        setHasSubmitted(false);
        
        // Clear files when agent starts running
        setUploadedFiles([]);
        setIsSendingFiles(false);
        
        // Notify parent in controlled mode
        if (isControlled && controlledOnChange) {
          controlledOnChange('');
        }
      }
    }, [isAgentRunning, isControlled, controlledOnChange]);

    // Reset sending state if loading becomes false without agent starting (submission failure)
    useEffect(() => {
      if (!loading && !isAgentRunning && isSendingFiles) {
        // If loading stopped but agent didn't start, reset sending state
        // This allows user to retry or remove files
        setIsSendingFiles(false);
      }
    }, [loading, isAgentRunning, isSendingFiles]);

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
      e.preventDefault();
      // Use refs to get current values without adding them to deps
      const currentValue = valueRef.current;
      const currentUploadedFiles = uploadedFilesRef.current;
      
      if (
        (!currentValue.trim() && currentUploadedFiles.length === 0) ||
        loading ||
        (disabled && !isAgentRunning) ||
        isUploading // Prevent submission while files are uploading
      )
        return;

      // Only stop agent if there's no content (empty input)
      // If there's content, onSubmit will queue the message (handled in ThreadComponent)
      if (isAgentRunning && !currentValue.trim() && currentUploadedFiles.length === 0 && onStopAgent) {
        onStopAgent();
        return;
      }

      // Mark as submitted to disable input immediately
      setHasSubmitted(true);

      // Mark files as being sent (show loading spinner)
      if (currentUploadedFiles.length > 0) {
        setIsSendingFiles(true);
      }

      let message = currentValue;

      if (currentUploadedFiles.length > 0) {
        const fileInfo = currentUploadedFiles
          .map((file) => `[Uploaded File: ${file.path}]`)
          .join('\n');
        message = message ? `${message}\n\n${fileInfo}` : fileInfo;
      }

      // Append Markdown for data visualization options
      const dataOptionsMarkdown = generateDataOptionsMarkdown();
      if (dataOptionsMarkdown) {
        message = message + dataOptionsMarkdown;
      }

      // Append Markdown for slides template
      const slidesTemplateMarkdown = generateSlidesTemplateMarkdown();
      if (slidesTemplateMarkdown) {
        message = message + slidesTemplateMarkdown;
      }

      const baseModelName = selectedModel ? getActualModelId(selectedModel) : undefined;

      posthog.capture("task_prompt_submitted", { message });

      onSubmit(message, {
        agent_id: selectedAgentId,
        model_name: baseModelName && baseModelName.trim() ? baseModelName.trim() : undefined,
      });

      // Keep files visible with loading spinner - they'll be cleared when agent starts running
    }, [loading, disabled, isAgentRunning, isUploading, onStopAgent, generateDataOptionsMarkdown, generateSlidesTemplateMarkdown, getActualModelId, selectedModel, onSubmit, selectedAgentId]);

    // Handle paste for image files
    const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!e.clipboardData) return;
      const items = Array.from(e.clipboardData.items);
      const imageFiles: File[] = [];
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        handleFiles(
          imageFiles,
          sandboxId,
          projectId,
          setPendingFiles,
          setUploadedFiles,
          setIsUploading,
          messages,
          queryClient,
        );
      }
    }, [sandboxId, projectId, messages, queryClient]);

    const handleTranscription = useCallback((transcribedText: string) => {
      // Use the textarea's appendValue method
      const textarea = textareaRef.current as any;
      if (textarea?.appendValue) {
        textarea.appendValue(transcribedText);
      }
      
      // Notify parent in controlled mode
      if (isControlled && controlledOnChange) {
        const newValue = valueRef.current ? `${valueRef.current} ${transcribedText}` : transcribedText;
        controlledOnChange(newValue);
      }
    }, [isControlled, controlledOnChange]);

    const removeUploadedFile = useCallback(async (index: number) => {
      const fileToRemove = uploadedFiles[index];

      // Clean up local URL if it exists
      if (fileToRemove.localUrl) {
        URL.revokeObjectURL(fileToRemove.localUrl);
      }

      // Remove from local state immediately for responsive UI
      setUploadedFiles((prev) => prev.filter((_, i) => i !== index));
      if (!sandboxId && pendingFiles.length > index) {
        setPendingFiles((prev) => prev.filter((_, i) => i !== index));
      }

      // Check if file is referenced in existing chat messages before deleting from server
      const isFileUsedInChat = messages.some(message => {
        const content = typeof message.content === 'string' ? message.content : '';
        return content.includes(`[Uploaded File: ${fileToRemove.path}]`);
      });

      // Only delete from server if file is not referenced in chat history
      if (sandboxId && fileToRemove.path && !isFileUsedInChat) {
        deleteFileMutation.mutate({
          sandboxId,
          filePath: fileToRemove.path,
        }, {
          onError: (error) => {
            console.error('Failed to delete file from server:', error);
          }
        });
      } else {
        // File exists in chat history, don't delete from server
      }
    }, [uploadedFiles, sandboxId, pendingFiles, messages, deleteFileMutation]);

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDraggingOver(true);
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDraggingOver(false);
    };

    const renderConfigDropdown = useMemo(() => {
      // Don't render dropdown components until after hydration to prevent ID mismatches
      if (!mounted) {
        return <div className="flex items-center gap-2 h-8" />; // Placeholder with same height
      }
      // Unified compact menu for both logged and non-logged (non-logged shows only models subset via menu trigger)
      return (
        <div className="flex items-center gap-2">
          <UnifiedConfigMenu
            isLoggedIn={isLoggedIn}
            selectedAgentId={!hideAgentSelection ? selectedAgentId : undefined}
            onAgentSelect={!hideAgentSelection ? onAgentSelect : undefined}
            selectedModel={selectedModel}
            onModelChange={handleModelChange}
            modelOptions={modelOptions}
            subscriptionStatus={subscriptionStatus}
            canAccessModel={canAccessModel}
            refreshCustomModels={refreshCustomModels}
          />
        </div>
      );
    }, [mounted, isLoggedIn, hideAgentSelection, selectedAgentId, onAgentSelect, selectedModel, handleModelChange, modelOptions, subscriptionStatus, canAccessModel, refreshCustomModels]);

    // Stable callback for submit from textarea
    const handleTextareaSubmit = useCallback(() => {
      handleSubmit({ preventDefault: () => {} } as React.FormEvent);
    }, [handleSubmit]);

    // Stable callback for hasContent changes - only called when empty/non-empty state changes
    const handleHasContentChange = useCallback((newHasContent: boolean) => {
      setHasContent(newHasContent);
      // Notify parent in controlled mode
      if (isControlled && controlledOnChange) {
        controlledOnChange(valueRef.current);
      }
    }, [isControlled, controlledOnChange]);

    // Isolated textarea that manages its own state - prevents parent re-renders on typing
    const renderTextArea = useMemo(() => (
      <IsolatedTextarea
        ref={textareaRef}
        placeholder={animatedPlaceholder}
        disabled={disabled}
        isDraggingOver={isDraggingOver}
        onSubmit={handleTextareaSubmit}
        onPaste={handlePaste}
        hasFiles={hasFiles}
        loading={loading}
        isAgentRunning={isAgentRunning}
        isUploading={isUploading}
        valueRef={valueRef}
        onHasContentChange={handleHasContentChange}
      />
    ), [animatedPlaceholder, disabled, isDraggingOver, handleTextareaSubmit, handlePaste, hasFiles, loading, isAgentRunning, isUploading, handleHasContentChange]);

    // Stable callbacks for opening dialogs - don't need to be in deps
    const handleOpenRegistry = useCallback((slug: string | null) => {
      setSelectedIntegration(slug);
      setRegistryDialogOpen(true);
    }, []);

    const handleOpenPlanModal = useCallback(() => {
      setPlanSelectionModalOpen(true);
    }, []);

    // Controls are split into left and right to minimize re-renders
    // Memoized to prevent recreation on every keystroke
    const leftControls = useMemo(() => (
      <div className="flex items-center gap-2 min-w-0 flex-shrink overflow-visible">
        {!hideAttachments && (
          <FileUploadHandler
            ref={fileInputRef}
            loading={loading}
            disabled={disabled}
            isAgentRunning={isAgentRunning}
            isUploading={isUploading}
            sandboxId={sandboxId}
            projectId={projectId}
            setPendingFiles={setPendingFiles}
            setUploadedFiles={setUploadedFiles}
            setIsUploading={setIsUploading}
            messages={messages}
            isLoggedIn={isLoggedIn}
          />
        )}

        <IntegrationsDropdown
          isLoggedIn={isLoggedIn}
          loading={loading}
          disabled={disabled}
          isAgentRunning={isAgentRunning}
          isFreeTier={isFreeTier ?? false}
          quickIntegrations={quickIntegrations}
          integrationIcons={integrationIcons}
          onOpenRegistry={handleOpenRegistry}
          onOpenPlanModal={handleOpenPlanModal}
        />

        <SunaAgentModeSwitcher
          enabled={ENABLE_SUNA_AGENT_MODES}
          isSunaAgent={isSunaAgent}
          sunaAgentModes={sunaAgentModes}
          onModeChange={setSunaAgentModes}
        />

        {onModeDeselect && (
          <ModeButton
            selectedMode={selectedMode}
            isModeDismissing={isModeDismissing}
            onDeselect={handleModeDeselect}
          />
        )}
      </div>
    ), [hideAttachments, loading, disabled, isAgentRunning, isUploading, sandboxId, projectId, messages, isLoggedIn, isFreeTier, quickIntegrations, integrationIcons, handleOpenRegistry, handleOpenPlanModal, isSunaAgent, sunaAgentModes, onModeDeselect, selectedMode, isModeDismissing, handleModeDeselect]);

    const rightControls = useMemo(() => (
      <div className='flex items-center gap-2 flex-shrink-0'>
        {renderConfigDropdown}

        {isLoggedIn && <VoiceRecorder
          onTranscription={handleTranscription}
          disabled={loading || (disabled && !isAgentRunning)}
        />}

        <SubmitButton
          hasContent={hasContent}
          hasFiles={hasFiles}
          isAgentRunning={isAgentRunning}
          loading={loading}
          disabled={disabled}
          isUploading={isUploading}
          onStopAgent={onStopAgent}
          onSubmit={handleSubmit}
          buttonLoaderVariant={buttonLoaderVariant}
          pendingFilesCount={pendingFilesCount}
        />
      </div>
    ), [renderConfigDropdown, isLoggedIn, handleTranscription, loading, disabled, isAgentRunning, hasContent, hasFiles, isUploading, onStopAgent, handleSubmit, buttonLoaderVariant, pendingFilesCount]);

    const renderControls = useMemo(() => (
      <div className="flex items-center justify-between mt-0 mb-1 px-2 gap-2">
        {leftControls}
        {rightControls}
      </div>
    ), [leftControls, rightControls]);

    const isSnackVisible = showToolPreview || !!showSnackbar || (isFreeTier && subscriptionData && !isLocalMode());

    // Message Queue - get from store
    const allQueuedMessages = useMessageQueueStore((state) => state.queuedMessages);
    const removeQueuedMessage = useMessageQueueStore((state) => state.removeMessage);
    const moveUpQueuedMessage = useMessageQueueStore((state) => state.moveUp);
    const queuedMessages = React.useMemo(() => 
      threadId ? allQueuedMessages.filter((msg) => msg.threadId === threadId) : [],
      [allQueuedMessages, threadId]
    );
    // Message queue feature flag
    const ENABLE_MESSAGE_QUEUE = false;
    const hasQueuedMessages = ENABLE_MESSAGE_QUEUE && queuedMessages.length > 0;

    // Send now handler - stops agent and sends message immediately
    const handleSendNow = React.useCallback((msg: typeof queuedMessages[0]) => {
      if (onStopAgent) {
        onStopAgent();
      }
      removeQueuedMessage(msg.id);
      // Small delay to let agent stop
      setTimeout(() => {
        onSubmit(msg.message, msg.options);
      }, 100);
    }, [onStopAgent, removeQueuedMessage, onSubmit]);

    return (
      <TooltipProvider>
        <div className="mx-auto w-full max-w-4xl relative">
          {/* Message Queue - grows out of chat input */}
          {hasQueuedMessages && (
            <div className="absolute bottom-full left-[10%] right-[10%] mb-0 z-20">
              <div className="bg-muted/80 backdrop-blur-sm border border-border/50 border-b-0 rounded-t-lg overflow-hidden">
                {queuedMessages.map((msg, i) => (
                  <div
                    key={msg.id}
                    className="px-3 py-1.5 flex items-center gap-2 border-b border-border/30 last:border-b-0 group"
                  >
                    <Clock className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                    <span className="flex-1 text-xs text-foreground/80 truncate">{msg.message}</span>
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => handleSendNow(msg)}
                            className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                          >
                            <Send className="w-3 h-3" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">Send now</TooltipContent>
                      </Tooltip>
                      {i > 0 && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => threadId && moveUpQueuedMessage(msg.id, threadId)}
                              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">Move up</TooltipContent>
                        </Tooltip>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => removeQueuedMessage(msg.id)}
                            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">Remove</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="relative">
            <ChatSnack
            toolCalls={toolCalls}
            toolCallIndex={toolCallIndex}
            onExpandToolPreview={onExpandToolPreview}
            agentName={agentName}
            showToolPreview={showToolPreview}
            subscriptionData={subscriptionData}
            onOpenUpgrade={() => setPlanSelectionModalOpen(true)}
            isVisible={isSnackVisible}
          />

          {/* Scroll to bottom button */}
          {showScrollToBottomIndicator && onScrollToBottom && (
            <button
              onClick={onScrollToBottom}
              className={`absolute cursor-pointer right-3 z-50 w-8 h-8 rounded-full bg-card border border-border transition-all duration-200 hover:scale-105 flex items-center justify-center -top-12
                }`}
              title="Scroll to bottom"
            >
              <ArrowDown className="w-4 h-4 text-muted-foreground" />
            </button>
          )}
          <Card
            className={`shadow-none w-full max-w-4xl mx-auto bg-transparent border-none overflow-visible py-0 pb-5 ${isSnackVisible ? 'mt-6' : ''} ${enableAdvancedConfig && selectedAgentId ? '' : 'rounded-3xl'} relative z-10`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDraggingOver(false);
              if (fileInputRef.current && e.dataTransfer.files.length > 0) {
                const files = Array.from(e.dataTransfer.files);
                handleFiles(
                  files,
                  sandboxId,
                  projectId,
                  setPendingFiles,
                  setUploadedFiles,
                  setIsUploading,
                  messages,
                  queryClient,
                );
              }
            }}
          >
            <div className="w-full text-sm flex flex-col justify-between items-start rounded-lg">
              <CardContent className={`w-full p-1.5 pb-2 ${bgColor} border rounded-[24px]`}>
                {(uploadedFiles.length > 0 || isUploading) && (
                  <div className="relative">
                    <AttachmentGroup
                      files={uploadedFiles || []}
                      sandboxId={sandboxId}
                      onRemove={isSendingFiles ? undefined : removeUploadedFile}
                      layout="inline"
                      maxHeight="216px"
                      showPreviews={true}
                    />
                    {(isUploading && pendingFiles.length > 0) && (
                      <div className="absolute inset-0 bg-background/50 backdrop-blur-sm rounded-xl flex items-center justify-center z-10">
                        <div className="flex items-center gap-2 bg-background/90 px-3 py-2 rounded-lg border border-border">
                          <KortixLoader size="small" customSize={16} variant="auto" />
                          <span className="text-sm">Uploading {pendingFiles.length} file{pendingFiles.length !== 1 ? 's' : ''}...</span>
                        </div>
                      </div>
                    )}
                    {isSendingFiles && !isUploading && (
                      <div className="absolute inset-0 bg-background/50 backdrop-blur-sm rounded-xl flex items-center justify-center z-10">
                        <div className="flex items-center gap-2 bg-background/90 px-3 py-2 rounded-lg border border-border">
                          <KortixLoader size="small" customSize={16} variant="auto" />
                          <span className="text-sm">Sending {uploadedFiles.length} file{uploadedFiles.length !== 1 ? 's' : ''}...</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className="relative flex flex-col w-full h-full gap-2 justify-between">
                  {renderTextArea}
                  {renderControls}
                </div>
              </CardContent>
            </div>
          </Card>

          {enableAdvancedConfig && selectedAgentId && (
            <div className="w-full max-w-4xl mx-auto -mt-12 relative z-20">
              <div className="bg-gradient-to-b from-transparent via-transparent to-muted/30 pt-8 pb-2 px-4 rounded-b-3xl border border-t-0 border-border/50 transition-all duration-300 ease-out">
                <div className="flex items-center justify-between gap-1 overflow-x-auto scrollbar-none relative">
                  <button
                    onClick={() => setAgentConfigDialog({ open: true, tab: 'integrations' })}
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-all duration-200 px-2.5 py-1.5 rounded-2xl hover:bg-muted/50 border border-transparent hover:border-border/30 flex-shrink-0 cursor-pointer relative pointer-events-auto"
                  >
                    <div className="flex items-center -space-x-0.5">
                      {quickIntegrations.every(int => integrationIcons[int.id as keyof typeof integrationIcons]) ? (
                        <>
                          {quickIntegrations.map((integration) => (
                            <div key={integration.id} className="w-4 h-4 bg-white dark:bg-muted border border-border rounded-full flex items-center justify-center shadow-sm">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={integrationIcons[integration.id as keyof typeof integrationIcons]}
                                className="w-2.5 h-2.5"
                                alt={integration.name}
                              />
                            </div>
                          ))}
                        </>
                      ) : (
                        <>
                          {quickIntegrations.map((integration) => (
                            <div key={integration.id} className="w-4 h-4 bg-white dark:bg-muted border border-border rounded-full flex items-center justify-center shadow-sm">
                              <Skeleton className="w-2.5 h-2.5 rounded" />
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                    <span className="text-xs font-medium">Integrations</span>
                  </button>
                  <button
                    onClick={() => setAgentConfigDialog({ open: true, tab: 'tools' })}
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-all duration-200 px-2.5 py-1.5 rounded-2xl hover:bg-muted/50 border border-transparent hover:border-border/30 flex-shrink-0 cursor-pointer relative pointer-events-auto"
                  >
                    <Wrench className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="text-xs font-medium">Tools</span>
                  </button>
                  <button
                    onClick={() => setAgentConfigDialog({ open: true, tab: 'instructions' })}
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-all duration-200 px-2.5 py-1.5 rounded-2xl hover:bg-muted/50 border border-transparent hover:border-border/30 flex-shrink-0 cursor-pointer relative pointer-events-auto"
                  >
                    <Brain className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="text-xs font-medium">Instructions</span>
                  </button>
                  <button
                    onClick={() => setAgentConfigDialog({ open: true, tab: 'knowledge' })}
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-all duration-200 px-2.5 py-1.5 rounded-2xl hover:bg-muted/50 border border-transparent hover:border-border/30 flex-shrink-0 cursor-pointer relative pointer-events-auto"
                  >
                    <Database className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="text-xs font-medium">Knowledge</span>
                  </button>

                  <button
                    onClick={() => setAgentConfigDialog({ open: true, tab: 'triggers' })}
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-all duration-200 px-2.5 py-1.5 rounded-2xl hover:bg-muted/50 border border-transparent hover:border-border/30 flex-shrink-0 cursor-pointer relative pointer-events-auto"
                  >
                    <Zap className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="text-xs font-medium">Triggers</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          <Dialog open={registryDialogOpen} onOpenChange={(open) => {
            setRegistryDialogOpen(open);
            if (!open) {
              setSelectedIntegration(null);
            }
          }}>
            <DialogContent className="p-0 max-w-6xl h-[90vh] overflow-hidden">
              <DialogHeader className="sr-only">
                <DialogTitle>Integrations</DialogTitle>
              </DialogHeader>
              <IntegrationsRegistry
                showAgentSelector={true}
                selectedAgentId={selectedAgentId}
                onAgentChange={onAgentSelect}
                onToolsSelected={(profileId, selectedTools, appName, appSlug) => {
                }}
                initialSelectedApp={selectedIntegration}
                isBlocked={isFreeTier && !isLocalMode()}
                onBlockedClick={() => setPlanSelectionModalOpen(true)}
              />
            </DialogContent>
          </Dialog>
          <PlanSelectionModal
            open={planModalOpen}
            onOpenChange={setPlanSelectionModalOpen}
          />
          {selectedAgentId && agentConfigDialog.open && (
            <AgentConfigurationDialog
              open={agentConfigDialog.open}
              onOpenChange={(open) => setAgentConfigDialog({ ...agentConfigDialog, open })}
              agentId={selectedAgentId}
              initialTab={agentConfigDialog.tab}
              onAgentChange={onAgentSelect}
            />
          )}
          </div>
        </div>
      </TooltipProvider>
    );
  },
));

ChatInput.displayName = 'ChatInput';