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
import { useAgents } from '@/hooks/react-query/agents/use-agents';
import { useAgentSelection } from '@/lib/stores/agent-selection-store';

import { Card, CardContent } from '@/components/ui/card';
import { handleFiles, FileUploadHandler } from './file-upload-handler';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Loader2, ArrowUp, X, Image as ImageIcon, Presentation, BarChart3, FileText, Search, Users, Code2, Sparkles, Brain as BrainIcon, MessageSquare } from 'lucide-react';
import { VoiceRecorder } from './voice-recorder';
import { UnifiedConfigMenu } from './unified-config-menu';
import { AttachmentGroup } from '../attachment-group';
import { cn } from '@/lib/utils';
import { useModelSelection } from '@/hooks/use-model-selection';
import { useFileDelete } from '@/hooks/react-query/files';
import { useQueryClient } from '@tanstack/react-query';
import { ToolCallInput } from './floating-tool-preview';
import { ChatSnack } from './chat-snack';
import { Brain, Zap, Database, ArrowDown, Wrench } from 'lucide-react';
import { useComposioToolkitIcon } from '@/hooks/react-query/composio/use-composio';
import { Skeleton } from '@/components/ui/skeleton';

import { IntegrationsRegistry } from '@/components/agents/integrations-registry';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useSubscriptionData } from '@/contexts/SubscriptionContext';
import { isStagingMode, isLocalMode } from '@/lib/config';
import { BillingModal } from '@/components/billing/billing-modal';
import { AgentConfigurationDialog } from '@/components/agents/agent-configuration-dialog';
import { ContextUsageIndicator } from '../ContextUsageIndicator';

import posthog from 'posthog-js';

// Helper function to get the icon for each mode
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

export type SubscriptionStatus = 'no_subscription' | 'active';

export interface ChatInputHandles {
  getPendingFiles: () => File[];
  clearPendingFiles: () => void;
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
  threadId?: string | null;
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
      threadId = null,
    },
    ref,
  ) => {
    const isControlled =
      controlledValue !== undefined && controlledOnChange !== undefined;

    const [uncontrolledValue, setUncontrolledValue] = useState('');
    const value = isControlled ? controlledValue : uncontrolledValue;

    const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const [isUploading, setIsUploading] = useState(false);
    const [isDraggingOver, setIsDraggingOver] = useState(false);

    const [registryDialogOpen, setRegistryDialogOpen] = useState(false);
    const [showSnackbar, setShowSnackbar] = useState(defaultShowSnackbar);
    const [userDismissedUsage, setUserDismissedUsage] = useState(false);
    const [billingModalOpen, setBillingModalOpen] = useState(false);
    const [agentConfigDialog, setAgentConfigDialog] = useState<{ open: boolean; tab: 'instructions' | 'knowledge' | 'triggers' | 'tools' | 'integrations' }>({ open: false, tab: 'instructions' });
    const [mounted, setMounted] = useState(false);
    const [animatedPlaceholder, setAnimatedPlaceholder] = useState('');
    const [isModeDismissing, setIsModeDismissing] = useState(false);
    
    // Suna Agent Modes feature flag
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

    const { data: subscriptionData } = useSubscriptionData();
    const deleteFileMutation = useFileDelete();
    const queryClient = useQueryClient();

    // Fetch integration icons only when logged in and advanced config UI is in use
    const shouldFetchIcons = isLoggedIn && !!enableAdvancedConfig;
    const { data: googleDriveIcon } = useComposioToolkitIcon('googledrive', { enabled: shouldFetchIcons });
    const { data: slackIcon } = useComposioToolkitIcon('slack', { enabled: shouldFetchIcons });
    const { data: notionIcon } = useComposioToolkitIcon('notion', { enabled: shouldFetchIcons });

    // Show usage preview logic:
    // - Always show to free users when showToLowCreditUsers is true
    // - For paid users, only show when they're at 70% or more of their cost limit (30% or below remaining)
    const shouldShowUsage = useMemo(() => {
      if (!subscriptionData || !showToLowCreditUsers || isLocalMode()) return false;
      
      // Free users: always show
      if (subscriptionStatus === 'no_subscription') {
        return true;
      }

      // Paid users: only show when at 70% or more of cost limit
      const currentUsage = subscriptionData.current_usage || 0;
      const costLimit = subscriptionData.cost_limit || 0;

      if (costLimit === 0) return false; // No limit set

      return currentUsage >= (costLimit * 0.7); // 70% or more used (30% or less remaining)
    }, [subscriptionData, showToLowCreditUsers, subscriptionStatus]);

    // Auto-show usage preview when we have subscription data
    useEffect(() => {
      if (shouldShowUsage && defaultShowSnackbar !== false && !userDismissedUsage && (showSnackbar === false || showSnackbar === defaultShowSnackbar)) {
        setShowSnackbar('upgrade');
      } else if (!shouldShowUsage && showSnackbar !== false) {
        setShowSnackbar(false);
      }
    }, [subscriptionData, showSnackbar, defaultShowSnackbar, shouldShowUsage, subscriptionStatus, showToLowCreditUsers, userDismissedUsage]);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const { data: agentsResponse } = useAgents({}, { enabled: isLoggedIn });
    const agents = agentsResponse?.agents || [];

    // Check if selected agent is Suna based on agent data
    const selectedAgent = agents.find(agent => agent.agent_id === selectedAgentId);
    const isSunaAgent = selectedAgent?.metadata?.is_suna_default || false;

    const { initializeFromAgents } = useAgentSelection();
    useImperativeHandle(ref, () => ({
      getPendingFiles: () => pendingFiles,
      clearPendingFiles: () => setPendingFiles([]),
    }));

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
      if (!mounted || value || !animatePlaceholder) {
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
    }, [mounted, placeholder, value, animatePlaceholder]);

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

    // Handle mode deselection with animation
    const handleModeDeselect = useCallback(() => {
      setIsModeDismissing(true);
      setTimeout(() => {
        onModeDeselect?.();
        setIsModeDismissing(false);
      }, 200); // Match animation duration
    }, [onModeDeselect]);

    // Auto-resize textarea
    useEffect(() => {
      if (!textareaRef.current) return;

      const adjustHeight = () => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.maxHeight = '200px';
        el.style.overflowY = el.scrollHeight > 200 ? 'auto' : 'hidden';

        const newHeight = Math.min(el.scrollHeight, 200);
        el.style.height = `${newHeight}px`;
      };

      adjustHeight();

      window.addEventListener('resize', adjustHeight);
      return () => window.removeEventListener('resize', adjustHeight);
    }, [value]);



    useEffect(() => {
      if (autoFocus && textareaRef.current) {
        textareaRef.current.focus();
      }
    }, [autoFocus]);

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
      e.preventDefault();
      if (
        (!value.trim() && uploadedFiles.length === 0) ||
        loading ||
        (disabled && !isAgentRunning) ||
        isUploading // Prevent submission while files are uploading
      )
        return;

      if (isAgentRunning && onStopAgent) {
        onStopAgent();
        return;
      }

      let message = value;

      if (uploadedFiles.length > 0) {
        const fileInfo = uploadedFiles
          .map((file) => `[Uploaded File: ${file.path}]`)
          .join('\n');
        message = message ? `${message}\n\n${fileInfo}` : fileInfo;
      }
      
      // Append Markdown for data visualization options
      const dataOptionsMarkdown = generateDataOptionsMarkdown();
      if (dataOptionsMarkdown) {
        message = message + dataOptionsMarkdown;
      }

      const baseModelName = getActualModelId(selectedModel);

      posthog.capture("task_prompt_submitted", { message });

      onSubmit(message, {
        agent_id: selectedAgentId,
        model_name: baseModelName,
      });

      if (!isControlled) {
        setUncontrolledValue('');
      }

      setUploadedFiles([]);
    }, [value, uploadedFiles, loading, disabled, isAgentRunning, isUploading, onStopAgent, generateDataOptionsMarkdown, getActualModelId, selectedModel, onSubmit, selectedAgentId, isControlled]);

    const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      if (isControlled) {
        controlledOnChange(newValue);
      } else {
        setUncontrolledValue(newValue);
      }
    }, [isControlled, controlledOnChange]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (
          (value.trim() || uploadedFiles.length > 0) &&
          !loading &&
          (!disabled || isAgentRunning) &&
          !isUploading // Prevent submission while files are uploading
        ) {
          handleSubmit(e as unknown as React.FormEvent);
        }
      }
    }, [value, uploadedFiles, loading, disabled, isAgentRunning, isUploading, handleSubmit]);

    const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
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
          setPendingFiles,
          setUploadedFiles,
          setIsUploading,
          messages,
          queryClient,
        );
      }
    };

    const handleTranscription = useCallback((transcribedText: string) => {
      const currentValue = isControlled ? controlledValue : uncontrolledValue;
      const newValue = currentValue ? `${currentValue} ${transcribedText}` : transcribedText;

      if (isControlled) {
        controlledOnChange(newValue);
      } else {
        setUncontrolledValue(newValue);
      }
    }, [isControlled, controlledValue, uncontrolledValue, controlledOnChange]);

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
        <div className="flex items-center gap-2" data-tour="agent-selector">
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

    const renderTextArea = useMemo(() => (
      <div className="flex flex-col gap-1 px-2">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={animatedPlaceholder}
          className={cn(
            'w-full bg-transparent dark:bg-transparent border-none shadow-none focus-visible:ring-0 px-0.5 pb-6 pt-4 !text-[15px] min-h-[72px] max-h-[200px] overflow-y-auto resize-none',
            isDraggingOver ? 'opacity-40' : '',
          )}
          disabled={loading || (disabled && !isAgentRunning)}
          rows={1}
        />
      </div>
    ), [value, handleChange, handleKeyDown, handlePaste, animatedPlaceholder, isDraggingOver, loading, disabled, isAgentRunning]);

    const renderControls = useMemo(() => (
      <div className="flex items-center justify-between mt-0 mb-1 px-2">
        <div className="flex items-center gap-3">
          {!hideAttachments && (
            <FileUploadHandler
              ref={fileInputRef}
              loading={loading}
              disabled={disabled}
              isAgentRunning={isAgentRunning}
              isUploading={isUploading}
              sandboxId={sandboxId}
              setPendingFiles={setPendingFiles}
              setUploadedFiles={setUploadedFiles}
              setIsUploading={setIsUploading}
              messages={messages}
              isLoggedIn={isLoggedIn}
            />
          )}
          
          {/* Agent Mode Switcher - Only for Suna */}
          {ENABLE_SUNA_AGENT_MODES && (isStagingMode() || isLocalMode()) && isSunaAgent && (
            <TooltipProvider>
              <div className="flex items-center gap-1 p-0.5 bg-muted/50 rounded-lg">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setSunaAgentModes('adaptive')}
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
                      onClick={() => setSunaAgentModes('autonomous')}
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
                      onClick={() => setSunaAgentModes('chat')}
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
            </TooltipProvider>
          )}
          
          {(selectedMode || isModeDismissing) && onModeDeselect && (
            <Button
              variant="outline"
              size="sm"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!isModeDismissing) {
                  handleModeDeselect();
                }
              }}
              className={cn(
                "h-8 px-3 py-2 bg-transparent border border-border rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent/50 flex items-center gap-1.5 cursor-pointer transition-all duration-200",
                !isModeDismissing && "animate-in fade-in-0 zoom-in-95",
                isModeDismissing && "animate-out fade-out-0 zoom-out-95"
              )}
            >
              {selectedMode && getModeIcon(selectedMode)}
              <span className="text-sm">{selectedMode?.charAt(0).toUpperCase()}{selectedMode?.slice(1)}</span>
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>

        <div className='flex items-center gap-2'>
          {renderConfigDropdown}
          <BillingModal
            open={billingModalOpen}
            onOpenChange={setBillingModalOpen}
            returnUrl={typeof window !== 'undefined' ? window.location.href : '/'}
          />

          {isLoggedIn && <VoiceRecorder
            onTranscription={handleTranscription}
            disabled={loading || (disabled && !isAgentRunning)}
          />}

          <div className="relative">
            {threadId && <ContextUsageIndicator threadId={threadId} modelName={selectedModel} />}
            
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="submit"
                    onClick={isAgentRunning && onStopAgent ? onStopAgent : handleSubmit}
                    size="sm"
                    className={cn(
                      'w-8 h-8 flex-shrink-0 self-end rounded-xl relative z-10',
                      (!value.trim() && uploadedFiles.length === 0 && !isAgentRunning) ||
                        loading ||
                        (disabled && !isAgentRunning) ||
                        isUploading
                        ? 'opacity-50'
                        : '',
                    )}
                    disabled={
                      (!value.trim() && uploadedFiles.length === 0 && !isAgentRunning) ||
                      loading ||
                      (disabled && !isAgentRunning) ||
                      isUploading
                    }
                  >
                    {loading || isUploading ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : isAgentRunning ? (
                      <div className="min-h-[14px] min-w-[14px] w-[14px] h-[14px] rounded-sm bg-current" />
                    ) : (
                      <ArrowUp className="h-5 w-5" />
                    )}
                  </Button>
                </TooltipTrigger>
                {isUploading && (
                  <TooltipContent side="top">
                    <p>Uploading {pendingFiles.length} file{pendingFiles.length !== 1 ? 's' : ''}...</p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </div>
    ), [hideAttachments, loading, disabled, isAgentRunning, isUploading, sandboxId, messages, isLoggedIn, renderConfigDropdown, billingModalOpen, setBillingModalOpen, handleTranscription, onStopAgent, handleSubmit, value, uploadedFiles, selectedMode, onModeDeselect, handleModeDeselect, isModeDismissing, isSunaAgent, sunaAgentModes, pendingFiles, threadId]);



    return (
      <div className="mx-auto w-full max-w-4xl relative">
        <div className="relative">
          <ChatSnack
            toolCalls={toolCalls}
            toolCallIndex={toolCallIndex}
            onExpandToolPreview={onExpandToolPreview}
            agentName={agentName}
            showToolPreview={showToolPreview}
            showUsagePreview={showSnackbar}
            subscriptionData={subscriptionData}
            onCloseUsage={() => { setShowSnackbar(false); setUserDismissedUsage(true); }}
            onOpenUpgrade={() => setBillingModalOpen(true)}
            isVisible={showToolPreview || !!showSnackbar}
          />

          {/* Scroll to bottom button */}
          {showScrollToBottomIndicator && onScrollToBottom && (
            <button
              onClick={onScrollToBottom}
              className={`absolute cursor-pointer right-3 z-50 w-8 h-8 rounded-full bg-card border border-border transition-all duration-200 hover:scale-105 flex items-center justify-center ${showToolPreview || !!showSnackbar ? '-top-12' : '-top-5'
                }`}
              title="Scroll to bottom"
            >
              <ArrowDown className="w-4 h-4 text-muted-foreground" />
            </button>
          )}
          <Card
            className={`-mb-2 shadow-none w-full max-w-4xl mx-auto bg-transparent border-none overflow-visible ${enableAdvancedConfig && selectedAgentId ? '' : 'rounded-3xl'} relative z-10`}
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
              <CardContent className={`w-full p-1.5 pb-2 ${bgColor} border rounded-3xl`}>
                {(uploadedFiles.length > 0 || isUploading) && (
                  <div className="relative">
                    <AttachmentGroup
                      files={uploadedFiles || []}
                      sandboxId={sandboxId}
                      onRemove={removeUploadedFile}
                      layout="inline"
                      maxHeight="216px"
                      showPreviews={true}
                    />
                    {isUploading && pendingFiles.length > 0 && (
                      <div className="absolute inset-0 bg-background/50 backdrop-blur-sm rounded-xl flex items-center justify-center">
                        <div className="flex items-center gap-2 bg-background/90 px-3 py-2 rounded-lg border border-border">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span className="text-sm">Uploading {pendingFiles.length} file{pendingFiles.length !== 1 ? 's' : ''}...</span>
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
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-all duration-200 px-2.5 py-1.5 rounded-lg hover:bg-muted/50 border border-transparent hover:border-border/30 flex-shrink-0 cursor-pointer relative pointer-events-auto"
                  >
                    <div className="flex items-center -space-x-0.5">
                      {googleDriveIcon?.icon_url && slackIcon?.icon_url && notionIcon?.icon_url ? (
                        <>
                          <div className="w-4 h-4 bg-white dark:bg-muted border border-border rounded-full flex items-center justify-center shadow-sm">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={googleDriveIcon.icon_url} className="w-2.5 h-2.5" alt="Google Drive" />
                          </div>
                          <div className="w-4 h-4 bg-white dark:bg-muted border border-border rounded-full flex items-center justify-center shadow-sm">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={slackIcon.icon_url} className="w-2.5 h-2.5" alt="Slack" />
                          </div>
                          <div className="w-4 h-4 bg-white dark:bg-muted border border-border rounded-full flex items-center justify-center shadow-sm">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={notionIcon.icon_url} className="w-2.5 h-2.5" alt="Notion" />
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="w-4 h-4 bg-white dark:bg-muted border border-border rounded-full flex items-center justify-center shadow-sm">
                            <Skeleton className="w-2.5 h-2.5 rounded" />
                          </div>
                          <div className="w-4 h-4 bg-white dark:bg-muted border border-border rounded-full flex items-center justify-center shadow-sm">
                            <Skeleton className="w-2.5 h-2.5 rounded" />
                          </div>
                          <div className="w-4 h-4 bg-white dark:bg-muted border border-border rounded-full flex items-center justify-center shadow-sm">
                            <Skeleton className="w-2.5 h-2.5 rounded" />
                          </div>
                        </>
                      )}
                    </div>
                    <span className="text-xs font-medium">Integrations</span>
                  </button>
                  <button
                    onClick={() => setAgentConfigDialog({ open: true, tab: 'tools' })}
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-all duration-200 px-2.5 py-1.5 rounded-lg hover:bg-muted/50 border border-transparent hover:border-border/30 flex-shrink-0 cursor-pointer relative pointer-events-auto"
                  >
                    <Wrench className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="text-xs font-medium">Tools</span>
                  </button>                  
                  <button
                    onClick={() => setAgentConfigDialog({ open: true, tab: 'instructions' })}
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-all duration-200 px-2.5 py-1.5 rounded-lg hover:bg-muted/50 border border-transparent hover:border-border/30 flex-shrink-0 cursor-pointer relative pointer-events-auto"
                  >
                    <Brain className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="text-xs font-medium">Instructions</span>
                  </button>
                  <button
                    onClick={() => setAgentConfigDialog({ open: true, tab: 'knowledge' })}
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-all duration-200 px-2.5 py-1.5 rounded-lg hover:bg-muted/50 border border-transparent hover:border-border/30 flex-shrink-0 cursor-pointer relative pointer-events-auto"
                  >
                    <Database className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="text-xs font-medium">Knowledge</span>
                  </button>

                  <button
                    onClick={() => setAgentConfigDialog({ open: true, tab: 'triggers' })}
                    className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-all duration-200 px-2.5 py-1.5 rounded-lg hover:bg-muted/50 border border-transparent hover:border-border/30 flex-shrink-0 cursor-pointer relative pointer-events-auto"
                  >
                    <Zap className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="text-xs font-medium">Triggers</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          <Dialog open={registryDialogOpen} onOpenChange={setRegistryDialogOpen}>
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
              />
            </DialogContent>
          </Dialog>
          <BillingModal
            open={billingModalOpen}
            onOpenChange={setBillingModalOpen}
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
    );
  },
));

ChatInput.displayName = 'ChatInput';