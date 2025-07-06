import React, { forwardRef, useEffect, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Square, Loader2, ArrowUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { UploadedFile } from './chat-input';
import { FileUploadHandler } from './file-upload-handler';
import { VoiceRecorder } from './voice-recorder';
import { ModelSelector } from './model-selector';
import { ChatSettingsDropdown } from './chat-settings-dropdown';
import { SubscriptionStatus } from './_use-model-selection';
import { isLocalMode } from '@/lib/config';
import { useFeatureFlag } from '@/lib/feature-flags';
import { TooltipContent } from '@/components/ui/tooltip';
import { Tooltip } from '@/components/ui/tooltip';
import { TooltipProvider, TooltipTrigger } from '@radix-ui/react-tooltip';
import { BillingModal } from '@/components/billing/billing-modal';

interface MessageInputProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onSubmit: (e: React.FormEvent) => void;
  onTranscription: (text: string) => void;
  placeholder: string;
  loading: boolean;
  disabled: boolean;
  isAgentRunning: boolean;
  onStopAgent?: () => void;
  isDraggingOver: boolean;
  uploadedFiles: UploadedFile[];

  fileInputRef: React.RefObject<HTMLInputElement>;
  isUploading: boolean;
  sandboxId?: string;
  setPendingFiles: React.Dispatch<React.SetStateAction<File[]>>;
  setUploadedFiles: React.Dispatch<React.SetStateAction<UploadedFile[]>>;
  setIsUploading: React.Dispatch<React.SetStateAction<boolean>>;
  hideAttachments?: boolean;
  messages?: any[]; // Add messages prop

  selectedModel: string;
  onModelChange: (model: string) => void;
  modelOptions: any[];
  subscriptionStatus: SubscriptionStatus;
  canAccessModel: (modelId: string) => boolean;
  refreshCustomModels?: () => void;
  selectedAgentId?: string;
  onAgentSelect?: (agentId: string | undefined) => void;
}

export const MessageInput = forwardRef<HTMLTextAreaElement, MessageInputProps>(
  (
    {
      value,
      onChange,
      onSubmit,
      onTranscription,
      placeholder,
      loading,
      disabled,
      isAgentRunning,
      onStopAgent,
      isDraggingOver,
      uploadedFiles,

      fileInputRef,
      isUploading,
      sandboxId,
      setPendingFiles,
      setUploadedFiles,
      setIsUploading,
      hideAttachments = false,
      messages = [],

      selectedModel,
      onModelChange,
      modelOptions,
      subscriptionStatus,
      canAccessModel,
      refreshCustomModels,

      selectedAgentId,
      onAgentSelect,
    },
    ref,
  ) => {
    const [billingModalOpen, setBillingModalOpen] = useState(false);
    const { enabled: customAgentsEnabled, loading: flagsLoading } = useFeatureFlag('custom_agents');

    useEffect(() => {
      const textarea = ref as React.RefObject<HTMLTextAreaElement>;
      if (!textarea.current) return;

      const adjustHeight = () => {
        textarea.current!.style.height = 'auto';
        const newHeight = Math.min(
          Math.max(textarea.current!.scrollHeight, 24),
          200,
        );
        textarea.current!.style.height = `${newHeight}px`;
      };

      adjustHeight();

      // Call it twice to ensure proper height calculation
      adjustHeight();

      window.addEventListener('resize', adjustHeight);
      return () => window.removeEventListener('resize', adjustHeight);
    }, [value, ref]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (
          (value.trim() || uploadedFiles.length > 0) &&
          !loading &&
          (!disabled || isAgentRunning)
        ) {
          onSubmit(e as unknown as React.FormEvent);
        }
      }
    };

    return (
      <div className="relative flex flex-col w-full h-full gap-2 justify-between">

        <div className="flex flex-col gap-1 px-2">
          <Textarea
            ref={ref}
            value={value}
            onChange={onChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className={cn(
              'w-full bg-transparent dark:bg-transparent border-none shadow-none focus-visible:ring-0 px-0.5 pb-6 pt-4 !text-[15px] min-h-[36px] max-h-[200px] overflow-y-auto resize-none',
              isDraggingOver ? 'opacity-40' : '',
            )}
            disabled={loading || (disabled && !isAgentRunning)}
            rows={1}
          />
        </div>


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
              />
            )}

          </div>

          {subscriptionStatus === 'no_subscription' && !isLocalMode() &&
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <p role='button' className='text-sm text-amber-500 hidden sm:block cursor-pointer' onClick={() => setBillingModalOpen(true)}>Upgrade for more usage</p>
                </TooltipTrigger>
                <TooltipContent>
                  <p>The free tier is severely limited by the amount of usage. Upgrade to experience the full power of Suna.</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          }

          <div className='flex items-center gap-2'>
            {/* Show model selector inline if custom agents are disabled, otherwise show settings dropdown */}
            {!customAgentsEnabled || flagsLoading ? (
              <ModelSelector
                selectedModel={selectedModel}
                onModelChange={onModelChange}
                modelOptions={modelOptions}
                subscriptionStatus={subscriptionStatus}
                canAccessModel={canAccessModel}
                refreshCustomModels={refreshCustomModels}
                billingModalOpen={billingModalOpen}
                setBillingModalOpen={setBillingModalOpen}
              />
            ) : (
              <ChatSettingsDropdown
                selectedAgentId={selectedAgentId}
                onAgentSelect={onAgentSelect}
                selectedModel={selectedModel}
                onModelChange={onModelChange}
                modelOptions={modelOptions}
                subscriptionStatus={subscriptionStatus}
                canAccessModel={canAccessModel}
                refreshCustomModels={refreshCustomModels}
                disabled={loading || (disabled && !isAgentRunning)}
              />
            )}

            {/* Billing Modal */}
            <BillingModal
              open={billingModalOpen}
              onOpenChange={setBillingModalOpen}
              returnUrl={typeof window !== 'undefined' ? window.location.href : '/'}
            />

            <VoiceRecorder
              onTranscription={onTranscription}
              disabled={loading || (disabled && !isAgentRunning)}
            />

            <Button
              type="submit"
              onClick={isAgentRunning && onStopAgent ? onStopAgent : onSubmit}
              size="sm"
              className={cn(
                'w-8 h-8 flex-shrink-0 self-end rounded-xl',
                (!value.trim() && uploadedFiles.length === 0 && !isAgentRunning) ||
                  loading ||
                  (disabled && !isAgentRunning)
                  ? 'opacity-50'
                  : '',
              )}
              disabled={
                (!value.trim() && uploadedFiles.length === 0 && !isAgentRunning) ||
                loading ||
                (disabled && !isAgentRunning)
              }
            >
              {loading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : isAgentRunning ? (
                <div className="min-h-[14px] min-w-[14px] w-[14px] h-[14px] rounded-sm bg-current" />
              ) : (
                <ArrowUp className="h-5 w-5" />
              )}
            </Button>
          </div>
        </div>
        {subscriptionStatus === 'no_subscription' && !isLocalMode() &&
          <div className='sm:hidden absolute -bottom-8 left-0 right-0 flex justify-center'>
            <p className='text-xs text-amber-500 px-2 py-1'>
              Upgrade for better performance
            </p>
          </div>
        }
      </div>
    );
  },
);

MessageInput.displayName = 'MessageInput';