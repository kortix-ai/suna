'use client';

import React, {
  useState,
  useRef,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { motion } from 'framer-motion';
import { Loader2, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { handleFiles } from './file-upload-handler';
import { MessageInput } from './message-input';
import { AttachmentGroup } from '../attachment-group';
import { useModelSelection } from './_use-model-selection';
import { AgentSelector } from './agent-selector';
import { useFileDelete } from '@/hooks/react-query/files';
import { useQueryClient } from '@tanstack/react-query';
import { FloatingToolPreview, ToolCallInput } from './floating-tool-preview';

export interface ChatInputHandles {
  getPendingFiles: () => File[];
  clearPendingFiles: () => void;
}

export interface ChatInputProps {
  onSubmit: (
    message: string,
    options?: { model_name?: string; enable_thinking?: boolean },
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
}

export interface UploadedFile {
  name: string;
  path: string;
  size: number;
  type: string;
  localUrl?: string;
}

export const ChatInput = forwardRef<ChatInputHandles, ChatInputProps>(
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
      bgColor = 'bg-sidebar',
      toolCalls = [],
      toolCallIndex = 0,
      showToolPreview = false,
      onExpandToolPreview,
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

    const {
      selectedModel,
      setSelectedModel: handleModelChange,
      subscriptionStatus,
      allModels: modelOptions,
      canAccessModel,
      getActualModelId,
      refreshCustomModels,
    } = useModelSelection();

    const deleteFileMutation = useFileDelete();
    const queryClient = useQueryClient();

    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    useImperativeHandle(ref, () => ({
      getPendingFiles: () => pendingFiles,
      clearPendingFiles: () => setPendingFiles([]),
    }));

    useEffect(() => {
      if (autoFocus && textareaRef.current) {
        textareaRef.current.focus();
      }
    }, [autoFocus]);

    const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      if (
        (!value.trim() && uploadedFiles.length === 0) ||
        loading ||
        (disabled && !isAgentRunning)
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

      let baseModelName = getActualModelId(selectedModel);
      let thinkingEnabled = false;
      if (selectedModel.endsWith('-thinking')) {
        baseModelName = getActualModelId(selectedModel.replace(/-thinking$/, ''));
        thinkingEnabled = true;
      }

      onSubmit(message, {
        model_name: baseModelName,
        enable_thinking: thinkingEnabled,
      });

      if (!isControlled) {
        setUncontrolledValue('');
      }

      setUploadedFiles([]);
    };

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      if (isControlled) {
        controlledOnChange(newValue);
      } else {
        setUncontrolledValue(newValue);
      }
    };

    const handleTranscription = (transcribedText: string) => {
      const currentValue = isControlled ? controlledValue : uncontrolledValue;
      const newValue = currentValue ? `${currentValue} ${transcribedText}` : transcribedText;

      if (isControlled) {
        controlledOnChange(newValue);
      } else {
        setUncontrolledValue(newValue);
      }
    };

    const removeUploadedFile = (index: number) => {
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
      } else if (isFileUsedInChat) {
        console.log(`Skipping server deletion for ${fileToRemove.path} - file is referenced in chat history`);
      }
    };

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

    return (
      <div className="mx-auto w-full max-w-4xl">
        <FloatingToolPreview
          toolCalls={toolCalls}
          currentIndex={toolCallIndex}
          onExpand={onExpandToolPreview || (() => {})}
          agentName={agentName}
          isVisible={showToolPreview}
        />
        <Card
          className="-mb-2 bg-red-400 shadow-none w-full max-w-4xl mx-auto bg-transparent border-none rounded-xl overflow-hidden"
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
            <CardContent className={`w-full p-1.5 pb-2 ${bgColor} rounded-2xl border`}>
              <AttachmentGroup
                files={uploadedFiles || []}
                sandboxId={sandboxId}
                onRemove={removeUploadedFile}
                layout="inline"
                maxHeight="216px"
                showPreviews={true}
              />
              <MessageInput
                ref={textareaRef}
                value={value}
                onChange={handleChange}
                onSubmit={handleSubmit}
                onTranscription={handleTranscription}
                placeholder={placeholder}
                loading={loading}
                disabled={disabled}
                isAgentRunning={isAgentRunning}
                onStopAgent={onStopAgent}
                isDraggingOver={isDraggingOver}
                uploadedFiles={uploadedFiles}

                fileInputRef={fileInputRef}
                isUploading={isUploading}
                sandboxId={sandboxId}
                setPendingFiles={setPendingFiles}
                setUploadedFiles={setUploadedFiles}
                setIsUploading={setIsUploading}
                hideAttachments={hideAttachments}
                messages={messages}

                selectedModel={selectedModel}
                onModelChange={handleModelChange}
                modelOptions={modelOptions}
                subscriptionStatus={subscriptionStatus}
                canAccessModel={canAccessModel}
                refreshCustomModels={refreshCustomModels}

                selectedAgentId={selectedAgentId}
                onAgentSelect={onAgentSelect}
              />
            </CardContent>
          </div>
        </Card>

        {isAgentRunning && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="pb-4 -mt-4 w-full flex items-center justify-center"
          >
            <div className="text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>{agentName ? `${agentName} is working...` : 'Suna is working...'}</span>
            </div>
          </motion.div>
        )}
      </div>
    );
  },
);

ChatInput.displayName = 'ChatInput';