'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ThreadContent } from '@/components/thread/content/ThreadContent';
import {
  PlaybackControls,
  PlaybackController,
} from '@/components/thread/content/PlaybackControls';
import {
  UnifiedMessage,
  ParsedMetadata,
  ThreadParams,
} from '@/components/thread/types';
import { safeJsonParse } from '@/components/thread/utils';
import { useAgentStream } from '@/hooks/useAgentStream';
import { ThreadSkeleton } from '@/components/thread/content/ThreadSkeleton';
import { extractToolName } from '@/components/thread/tool-views/xml-parser';
import { ToolCallInput } from '@/components/thread/tool-call-side-panel';

// Share-specific imports
import { useShareThreadData } from './_hooks/useShareThreadData';
import { ShareThreadLayout } from './_components/ShareThreadLayout';

interface StreamingToolCall {
  id?: string;
  name?: string;
  arguments?: string;
  index?: number;
  xml_tag_name?: string;
}

export default function ShareThreadPage({
  params,
}: {
  params: Promise<ThreadParams>;
}) {
  const unwrappedParams = React.use(params);
  const threadId = unwrappedParams.threadId;

  const router = useRouter();
  
  // Use the new share-specific hook
  const {
    messages,
    setMessages,
    project,
    sandboxId,
    projectName,
    agentRunId,
    setAgentRunId,
    agentStatus,
    setAgentStatus,
    isLoading,
    error,
    initialLoadCompleted,
  } = useShareThreadData(threadId);

  // Tool calls and side panel state
  const [toolCalls, setToolCalls] = useState<ToolCallInput[]>([]);
  const [currentToolIndex, setCurrentToolIndex] = useState<number>(0);
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(false);
  const [autoOpenedPanel, setAutoOpenedPanel] = useState(false);
  const [externalNavIndex, setExternalNavIndex] = useState<number | undefined>(undefined);

  // File viewer state
  const [fileViewerOpen, setFileViewerOpen] = useState(false);
  const [fileToView, setFileToView] = useState<string | null>(null);

  // Playback state for the controls
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMessageIndex, setCurrentMessageIndex] = useState(0);

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [userHasScrolled, setUserHasScrolled] = useState(false);
  const userClosedPanelRef = useRef(false);

  useEffect(() => {
    userClosedPanelRef.current = true;
    setIsSidePanelOpen(false);
  }, []);

  const toggleSidePanel = useCallback(() => {
    setIsSidePanelOpen((prev) => !prev);
  }, []);

  const handleSidePanelNavigate = useCallback((newIndex: number) => {
    setCurrentToolIndex(newIndex);
  }, []);

  const handleNewMessageFromStream = useCallback((message: UnifiedMessage) => {
    if (!message.message_id) {
      console.warn(
        `[STREAM HANDLER] Received message is missing ID: Type=${message.type}`,
      );
    }

    setMessages((prev) => {
      const messageExists = prev.some(
        (m) => m.message_id === message.message_id,
      );
      if (messageExists) {
        return prev.map((m) =>
          m.message_id === message.message_id ? message : m,
        );
      } else {
        return [...prev, message];
      }
    });

    if (message.type === 'tool') {
      setAutoOpenedPanel(false);
    }
  }, []);

  const handleStreamStatusChange = useCallback(
    (hookStatus: string) => {
      switch (hookStatus) {
        case 'idle':
        case 'completed':
        case 'stopped':
        case 'agent_not_running':
          setAgentStatus('idle');
          setAgentRunId(null);
          setAutoOpenedPanel(false);
          break;
        case 'connecting':
          setAgentStatus('connecting');
          break;
        case 'streaming':
          setAgentStatus('running');
          break;
        case 'error':
          setAgentStatus('error');
          setTimeout(() => {
            setAgentStatus('idle');
            setAgentRunId(null);
          }, 3000);
          break;
      }
    },
    [],
  );

  const handleStreamError = useCallback((errorMessage: string) => {
    console.error(`[PAGE] Stream hook error: ${errorMessage}`);
    toast.error(errorMessage, { duration: 15000 });
  }, []);

  const handleStreamClose = useCallback(() => {
  }, [agentStatus]);

  // Handle streaming tool calls
  const handleStreamingToolCall = useCallback(
    (toolCall: StreamingToolCall | null) => {
      if (!toolCall) return;

      // Normalize the tool name like the project thread page does
      const rawToolName = toolCall.name || toolCall.xml_tag_name || 'Unknown Tool';
      const toolName = rawToolName.replace(/_/g, '-').toLowerCase();

      // If user explicitly closed the panel, don't reopen it for streaming calls
      if (userClosedPanelRef.current) return;

      // Create a properly formatted tool call input for the streaming tool
      // that matches the format of historical tool calls
      const toolArguments = toolCall.arguments || '';

      // Format the arguments in a way that matches the expected XML format for each tool
      // This ensures the specialized tool views render correctly
      let formattedContent = toolArguments;
      
      if (
        toolName.includes('command') &&
        !toolArguments.includes('<execute-command>')
      ) {
        formattedContent = `<execute-command>${toolArguments}</execute-command>`;
      } else if (
        toolName.includes('file') ||
        toolName === 'create-file' ||
        toolName === 'delete-file' ||
        toolName === 'full-file-rewrite' ||
        toolName === 'edit-file'
      ) {
        // For file operations, check if toolArguments contains a file path
        // If it's just a raw file path, format it properly
        const fileOpTags = ['create-file', 'delete-file', 'full-file-rewrite', 'edit-file'];
        const matchingTag = fileOpTags.find((tag) => toolName === tag);
        if (matchingTag) {
          // Check if arguments already have the proper XML format
          if (!toolArguments.includes(`<${matchingTag}>`) && !toolArguments.includes('file_path=') && !toolArguments.includes('target_file=')) {
            // If toolArguments looks like a raw file path, format it properly
            const filePath = toolArguments.trim();
            if (filePath && !filePath.startsWith('<')) {
              if (matchingTag === 'edit-file') {
                formattedContent = `<${matchingTag} target_file="${filePath}">`;
              } else {
              formattedContent = `<${matchingTag} file_path="${filePath}">`;
              }
            } else {
              formattedContent = `<${matchingTag}>${toolArguments}</${matchingTag}>`;
            }
          } else {
            formattedContent = toolArguments;
          }
        }
      }

      const newToolCall: ToolCallInput = {
        assistantCall: {
          name: toolName,  // Use normalized tool name
          content: formattedContent,
          timestamp: new Date().toISOString(),
        },
        // For streaming tool calls, provide empty content that indicates streaming
        toolResult: {
          content: 'STREAMING',
          isSuccess: true,
          timestamp: new Date().toISOString(),
        },
      };

      // Update the tool calls state to reflect the streaming tool
      setToolCalls((prev) => {
        // If the same tool is already being streamed, update it instead of adding a new one
        if (prev.length > 0 && prev[0].assistantCall.name === toolName) {
          return [
            {
              ...prev[0],
              assistantCall: {
                ...prev[0].assistantCall,
                content: formattedContent,
              },
            },
          ];
        }
        return [newToolCall];
      });

      setCurrentToolIndex(0);
      setIsSidePanelOpen(true);
    },
    [],
  );

  const {
    status: streamHookStatus,
    toolCall: streamingToolCall,
    error: streamError,
    agentRunId: currentHookRunId,
    startStreaming,
    stopStreaming,
  } = useAgentStream(
    {
      onMessage: handleNewMessageFromStream,
      onStatusChange: handleStreamStatusChange,
      onError: handleStreamError,
      onClose: handleStreamClose,
    },
    threadId,
    setMessages,
    undefined, // No agent ID available in share page
  );

  useEffect(() => {
    if (agentRunId && agentRunId !== currentHookRunId) {
      startStreaming(agentRunId);
    }
  }, [agentRunId, startStreaming, currentHookRunId]);

  // Handle streaming tool calls
  useEffect(() => {
    if (streamingToolCall) {
      handleStreamingToolCall(streamingToolCall);
    }
  }, [streamingToolCall, handleStreamingToolCall]);

  // Build tool calls from messages (shared logic from useToolCalls hook)
  useEffect(() => {
    const historicalToolPairs: ToolCallInput[] = [];
    const assistantMessages = messages.filter(
      (m) => m.type === 'assistant' && m.message_id,
    );

    assistantMessages.forEach((assistantMsg) => {
      const resultMessage = messages.find((toolMsg) => {
        if (toolMsg.type !== 'tool' || !toolMsg.metadata || !assistantMsg.message_id) return false;
        try {
          const metadata = safeJsonParse<ParsedMetadata>(toolMsg.metadata, {});
          return metadata.assistant_message_id === assistantMsg.message_id;
        } catch (e) {
          return false;
        }
      });

      if (resultMessage) {
        let toolName = 'unknown';
        try {
          const assistantContent = (() => {
            try {
              const parsed = safeJsonParse<{ content?: string }>(assistantMsg.content, {});
              return parsed.content || assistantMsg.content;
            } catch {
              return assistantMsg.content;
            }
          })();
          const extractedToolName = extractToolName(assistantContent);
          if (extractedToolName) {
            toolName = extractedToolName;
          } else {
            const assistantContentParsed = safeJsonParse<{
              tool_calls?: Array<{ function?: { name?: string }; name?: string }>;
            }>(assistantMsg.content, {});
            if (
              assistantContentParsed.tool_calls &&
              assistantContentParsed.tool_calls.length > 0
            ) {
              const firstToolCall = assistantContentParsed.tool_calls[0];
              const rawName = firstToolCall.function?.name || firstToolCall.name || 'unknown';
              toolName = rawName.replace(/_/g, '-').toLowerCase();
            }
          }
        } catch { }

        let isSuccess = true;
        try {
          const toolResultContent = (() => {
            try {
              const parsed = safeJsonParse<{ content?: string }>(resultMessage.content, {});
              return parsed.content || resultMessage.content;
            } catch {
              return resultMessage.content;
            }
          })();
          if (toolResultContent && typeof toolResultContent === 'string') {
            const toolResultMatch = toolResultContent.match(/ToolResult\s*\(\s*success\s*=\s*(True|False|true|false)/i);
            if (toolResultMatch) {
              isSuccess = toolResultMatch[1].toLowerCase() === 'true';
            } else {
              const toolContent = toolResultContent.toLowerCase();
              isSuccess = !(toolContent.includes('failed') ||
                toolContent.includes('error') ||
                toolContent.includes('failure'));
            }
          }
        } catch { }

        historicalToolPairs.push({
          assistantCall: {
            name: toolName,
            content: assistantMsg.content,
            timestamp: assistantMsg.created_at,
          },
          toolResult: {
            content: resultMessage.content,
            isSuccess: isSuccess,
            timestamp: resultMessage.created_at,
          },
        });
      }
    });
    
    historicalToolPairs.sort((a, b) => {
      const timeA = new Date(a.assistantCall.timestamp || '').getTime();
      const timeB = new Date(b.assistantCall.timestamp || '').getTime();
      return timeA - timeB;
    });

    setToolCalls(historicalToolPairs);
  }, [messages]);


  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  const handleToolClick = useCallback(
    (clickedAssistantMessageId: string | null, clickedToolName: string) => {
      if (!clickedAssistantMessageId) {
        console.warn(
          'Clicked assistant message ID is null. Cannot open side panel.',
        );
        toast.warning('Cannot view details: Assistant message ID is missing.');
        return;
      }

      userClosedPanelRef.current = false;

      const toolIndex = toolCalls.findIndex((tc) => {
        if (!tc.toolResult?.content || tc.toolResult.content === 'STREAMING')
          return false;

        const assistantMessage = messages.find(
          (m) =>
            m.message_id === clickedAssistantMessageId &&
            m.type === 'assistant',
        );
        if (!assistantMessage) return false;
        const toolMessage = messages.find((m) => {
          if (m.type !== 'tool' || !m.metadata) return false;
          try {
            const metadata = safeJsonParse<ParsedMetadata>(m.metadata, {});
            return (
              metadata.assistant_message_id === assistantMessage.message_id
            );
          } catch {
            return false;
          }
        });
        return (
          tc.assistantCall?.content === assistantMessage.content &&
          tc.toolResult?.content === toolMessage?.content
        );
      });

      if (toolIndex !== -1) {
        setExternalNavIndex(toolIndex);
        setCurrentToolIndex(toolIndex);
        setIsSidePanelOpen(true);

        setTimeout(() => setExternalNavIndex(undefined), 100);
      } else {
        console.warn(
          `[PAGE] Could not find matching tool call in toolCalls array for assistant message ID: ${clickedAssistantMessageId}`,
        );
        toast.info('Could not find details for this tool call.');
      }
    },
    [messages, toolCalls],
  );

  const handleOpenFileViewer = useCallback((filePath?: string, filePathList?: string[]) => {
    if (filePath) {
      setFileToView(filePath);
    } else {
      setFileToView(null);
    }
    setFileViewerOpen(true);
  }, []);

  const playbackController: PlaybackController = PlaybackControls({
    messages,
    isSidePanelOpen,
    onToggleSidePanel: toggleSidePanel,
    toolCalls,
    setCurrentToolIndex,
    onFileViewerOpen: handleOpenFileViewer,
    projectName: projectName || 'Shared Conversation',
  });

  const {
    playbackState,
    renderHeader,
    renderFloatingControls,
    renderWelcomeOverlay,
    togglePlayback,
    resetPlayback,
    skipToEnd,
  } = playbackController;

  useEffect(() => {
    setIsPlaying(playbackState.isPlaying);
    setCurrentMessageIndex(playbackState.currentMessageIndex);
  }, [playbackState.isPlaying, playbackState.currentMessageIndex]);

  useEffect(() => {
    if (playbackState.visibleMessages.length > 0 && !userHasScrolled) {
      scrollToBottom('smooth');
    }
  }, [playbackState.visibleMessages, userHasScrolled]);



  useEffect(() => {
    if (
      (streamHookStatus === 'completed' ||
        streamHookStatus === 'stopped' ||
        streamHookStatus === 'agent_not_running' ||
        streamHookStatus === 'error') &&
      (agentStatus === 'running' || agentStatus === 'connecting')
    ) {
      setAgentStatus('idle');
      setAgentRunId(null);
      setAutoOpenedPanel(false);
    }
  }, [agentStatus, streamHookStatus, agentRunId, currentHookRunId]);


  useEffect(() => {
    if (!isPlaying || currentMessageIndex <= 0 || !messages.length) return;
    const currentMsg = messages[currentMessageIndex - 1];
    if (currentMsg?.type === 'tool' && currentMsg.metadata) {
      try {
        const metadata = safeJsonParse<ParsedMetadata>(currentMsg.metadata, {});
        const assistantId = metadata.assistant_message_id;
        if (assistantId) {
          const toolIndex = toolCalls.findIndex((tc) => {
            const assistantMessage = messages.find(
              (m) => m.message_id === assistantId && m.type === 'assistant'
            );
            if (!assistantMessage) return false;
            return tc.assistantCall?.content === assistantMessage.content;
          });
          if (toolIndex !== -1) {
            setCurrentToolIndex(toolIndex);
          }
        }
      } catch (e) {
        console.error('Error in direct tool mapping:', e);
      }
    }
  }, [currentMessageIndex, isPlaying, messages, toolCalls]);

  useEffect(() => {
    if (!isPlaying || messages.length === 0 || currentMessageIndex <= 0) return;
    const currentMessages = messages.slice(0, currentMessageIndex);
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      const msg = currentMessages[i];
      if (msg.type === 'tool' && msg.metadata) {
        try {
          const metadata = safeJsonParse<ParsedMetadata>(msg.metadata, {});
          const assistantId = metadata.assistant_message_id;
          if (assistantId) {
            for (let j = 0; j < toolCalls.length; j++) {
              const content = toolCalls[j].assistantCall?.content || '';
              if (content.includes(assistantId)) {
                setCurrentToolIndex(j);
                return;
              }
            }
          }
        } catch (e) {
          console.error('Error parsing tool message metadata:', e);
        }
      }
    }
  }, [currentMessageIndex, isPlaying, messages, toolCalls]);

  if (isLoading && !initialLoadCompleted) {
    return (
      <ThreadSkeleton isSidePanelOpen={isSidePanelOpen} showHeader={true} />
    );
  }

  if (error) {
    return (
      <ShareThreadLayout
        threadId={threadId}
        projectId={project?.id || ''}
        projectName="Shared Conversation"
        project={null}
        sandboxId={null}
        isSidePanelOpen={isSidePanelOpen}
        onToggleSidePanel={toggleSidePanel}
        onViewFiles={handleOpenFileViewer}
        fileViewerOpen={fileViewerOpen}
        setFileViewerOpen={setFileViewerOpen}
        fileToView={fileToView}
        toolCalls={toolCalls}
        messages={messages}
        externalNavIndex={externalNavIndex}
        agentStatus={agentStatus}
        currentToolIndex={currentToolIndex}
        onSidePanelNavigate={handleSidePanelNavigate}
        onSidePanelClose={() => {
          setIsSidePanelOpen(false);
          userClosedPanelRef.current = true;
        }}
        initialLoadCompleted={initialLoadCompleted}
      >
        <div className="flex flex-1 items-center justify-center p-4">
          <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-lg border bg-card p-6 text-center">
            <h2 className="text-lg font-semibold text-destructive">Error</h2>
            <p className="text-sm text-muted-foreground">{error}</p>
            <button
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              onClick={() => router.push('/')}
            >
              Back to Home
            </button>
          </div>
        </div>
      </ShareThreadLayout>
    );
  }

  return (
    <ShareThreadLayout
      threadId={threadId}
      projectId={project?.id || ''}
      projectName={projectName || 'Shared Conversation'}
      project={project}
      sandboxId={sandboxId}
      isSidePanelOpen={isSidePanelOpen}
      onToggleSidePanel={toggleSidePanel}
      onViewFiles={handleOpenFileViewer}
      fileViewerOpen={fileViewerOpen}
      setFileViewerOpen={setFileViewerOpen}
      fileToView={fileToView}
      toolCalls={toolCalls}
      messages={messages}
      externalNavIndex={externalNavIndex}
      agentStatus={agentStatus}
      currentToolIndex={currentToolIndex}
      onSidePanelNavigate={handleSidePanelNavigate}
      onSidePanelClose={() => {
        setIsSidePanelOpen(false);
        userClosedPanelRef.current = true;
      }}
      initialLoadCompleted={initialLoadCompleted}
    >
      <ThreadContent
        messages={messages}
        agentStatus={agentStatus}
        handleToolClick={handleToolClick}
        handleOpenFileViewer={handleOpenFileViewer}
        readOnly={true}
        visibleMessages={playbackState.visibleMessages}
        streamingText={playbackState.streamingText}
        isStreamingText={playbackState.isStreamingText}
        currentToolCall={playbackState.currentToolCall}
        sandboxId={sandboxId || ''}
        project={project}
      />
      {renderWelcomeOverlay()}
      {renderFloatingControls()}
    </ShareThreadLayout>
  );
}
