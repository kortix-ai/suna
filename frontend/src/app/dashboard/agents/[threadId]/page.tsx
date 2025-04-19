'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  ArrowDown, CheckCircle, CircleDashed, AlertTriangle, Info, File
} from 'lucide-react';
import { addUserMessage, getMessages, startAgent, stopAgent, getAgentRuns, getProject, getThread, updateProject, Project, Message as BaseApiMessageType } from '@/lib/api';
import { toast } from 'sonner';
import { Skeleton } from "@/components/ui/skeleton";
import { ChatInput } from '@/components/thread/chat-input';
import { FileViewerModal } from '@/components/thread/file-viewer-modal';
import { SiteHeader } from "@/components/thread/thread-site-header"
import { ToolCallSidePanel, ToolCallInput } from "@/components/thread/tool-call-side-panel";
import { useSidebar } from "@/components/ui/sidebar";
import { useAgentStream } from '@/hooks/useAgentStream';

import { UnifiedMessage, ParsedContent, ParsedMetadata, ThreadParams } from '@/components/thread/types';
import { getToolIcon, extractPrimaryParam, safeJsonParse } from '@/components/thread/utils';

// Define the set of tags whose raw XML should be hidden during streaming
const HIDE_STREAMING_XML_TAGS = new Set([
  'execute-command',
  'create-file',
  'delete-file',
  'full-file-rewrite',
  'str-replace',
  'browser-click-element',
  'browser-close-tab',
  'browser-drag-drop',
  'browser-get-dropdown-options',
  'browser-go-back',
  'browser-input-text',
  'browser-navigate-to',
  'browser-scroll-down',
  'browser-scroll-to-text',
  'browser-scroll-up',
  'browser-select-dropdown-option',
  'browser-send-keys',
  'browser-switch-tab',
  'browser-wait',
  'deploy',
  'ask',
  'complete',
  'crawl-webpage',
  'web-search'
]);

// Extend the base Message type with the expected database fields
interface ApiMessageType extends BaseApiMessageType {
  message_id?: string;
  thread_id?: string;
  is_llm_message?: boolean;
  metadata?: string;
  created_at?: string;
  updated_at?: string;
}

// Add a simple interface for streaming tool calls
interface StreamingToolCall {
  id?: string;
  name?: string;
  arguments?: string;
  index?: number;
  xml_tag_name?: string;
}

export default function ThreadPage({ params }: { params: Promise<ThreadParams> }) {
  const unwrappedParams = React.use(params);
  const threadId = unwrappedParams.threadId;
  
  const router = useRouter();
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<'idle' | 'running' | 'connecting' | 'error'>('idle');
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(false);
  const [toolCalls, setToolCalls] = useState<ToolCallInput[]>([]);
  const [currentToolIndex, setCurrentToolIndex] = useState<number>(0);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const latestMessageRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [userHasScrolled, setUserHasScrolled] = useState(false);
  const hasInitiallyScrolled = useRef<boolean>(false);

  const [project, setProject] = useState<Project | null>(null);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [fileViewerOpen, setFileViewerOpen] = useState(false);
  const [projectName, setProjectName] = useState<string>('Project');
  const [fileToView, setFileToView] = useState<string | null>(null);

  const initialLoadCompleted = useRef<boolean>(false);
  const messagesLoadedRef = useRef(false);
  const agentRunsCheckedRef = useRef(false);

  const handleProjectRenamed = useCallback((newName: string) => {
    setProjectName(newName);
  }, []);

  const { state: leftSidebarState, setOpen: setLeftSidebarOpen } = useSidebar();
  const initialLayoutAppliedRef = useRef(false);

  const toggleSidePanel = useCallback(() => {
    setIsSidePanelOpen(prevIsOpen => !prevIsOpen);
  }, []);

  const handleSidePanelNavigate = useCallback((newIndex: number) => {
    setCurrentToolIndex(newIndex);
  }, []);

  useEffect(() => {
    if (isSidePanelOpen && leftSidebarState !== 'collapsed') {
      setLeftSidebarOpen(false);
    }
  }, [isSidePanelOpen, leftSidebarState, setLeftSidebarOpen]);

  useEffect(() => {
    if (leftSidebarState === 'expanded' && isSidePanelOpen) {
      setIsSidePanelOpen(false);
    }
  }, [leftSidebarState, isSidePanelOpen]);

  useEffect(() => {
    if (!initialLayoutAppliedRef.current) {
      setLeftSidebarOpen(false);
      initialLayoutAppliedRef.current = true;
    }
  }, [setLeftSidebarOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'i') {
        event.preventDefault();
        toggleSidePanel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidePanel]);

  const handleNewMessageFromStream = useCallback((message: UnifiedMessage) => {
    // Log the ID of the message received from the stream
    console.log(`[STREAM HANDLER] Received message: ID=${message.message_id}, Type=${message.type}`);
    if (!message.message_id) {
        console.warn(`[STREAM HANDLER] Received message is missing ID: Type=${message.type}, Content=${message.content?.substring(0, 50)}...`);
    }
    
    setMessages(prev => {
      const messageExists = prev.some(m => m.message_id === message.message_id);
      if (messageExists) {
        return prev.map(m => m.message_id === message.message_id ? message : m);
      } else {
        return [...prev, message];
      }
    });
  }, []);

  const handleStreamStatusChange = useCallback((hookStatus: string) => {
    console.log(`[PAGE] Hook status changed: ${hookStatus}`);
    switch(hookStatus) {
      case 'idle':
      case 'completed':
      case 'stopped':
      case 'agent_not_running':
        setAgentStatus('idle');
        setAgentRunId(null);
        break;
      case 'connecting':
        setAgentStatus('connecting');
        break;
      case 'streaming':
        setAgentStatus('running');
        break;
      case 'error':
        setAgentStatus('error');
        break;
    }
  }, []);

  const handleStreamError = useCallback((errorMessage: string) => {
    console.error(`[PAGE] Stream hook error: ${errorMessage}`);
    if (!errorMessage.toLowerCase().includes('not found') && 
        !errorMessage.toLowerCase().includes('agent run is not running')) {
        toast.error(`Stream Error: ${errorMessage}`);
    }
  }, []);
  
  const handleStreamClose = useCallback(() => {
      console.log(`[PAGE] Stream hook closed with final status: ${agentStatus}`);
  }, [agentStatus]);

  const {
    status: streamHookStatus,
    textContent: streamingTextContent,
    toolCall: streamingToolCall,
    error: streamError,
    agentRunId: currentHookRunId,
    startStreaming,
    stopStreaming,
  } = useAgentStream({
    onMessage: handleNewMessageFromStream,
    onStatusChange: handleStreamStatusChange,
    onError: handleStreamError,
    onClose: handleStreamClose,
  });

  useEffect(() => {
    if (agentRunId && agentRunId !== currentHookRunId) {
      console.log(`[PAGE] Target agentRunId set to ${agentRunId}, initiating stream...`);
      startStreaming(agentRunId);
    }
  }, [agentRunId, startStreaming]);

  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      if (!initialLoadCompleted.current) setIsLoading(true);
      setError(null);
      
      try {
        if (!threadId) throw new Error('Thread ID is required');

        const threadData = await getThread(threadId).catch(err => { 
          throw new Error('Failed to load thread data: ' + err.message); 
        });
        
        if (!isMounted) return;
        
        if (threadData?.project_id) {
          const projectData = await getProject(threadData.project_id);
          if (isMounted && projectData) {
            setProject(projectData);
            setSandboxId(typeof projectData.sandbox === 'string' ? projectData.sandbox : projectData.sandbox?.id);
            setProjectName(projectData.name || 'Project');
          }
        }

        if (!messagesLoadedRef.current) {
          const messagesData = await getMessages(threadId);
          if (isMounted) {
            // Log raw messages fetched from API
            console.log('[PAGE] Raw messages fetched:', messagesData);
            
            // Map API message type to UnifiedMessage type
            const unifiedMessages = (messagesData || [])
              .filter(msg => msg.type !== 'status') // Filter out status messages early
              .map((msg: ApiMessageType, index: number) => {
                console.log(`[MAP ${index}] Processing raw message:`, msg);
                const messageId = msg.message_id;
                console.log(`[MAP ${index}] Accessed msg.message_id:`, messageId);
                if (!messageId && msg.type !== 'status') { 
                  console.warn(`[MAP ${index}] Non-status message fetched from API is missing ID: Type=${msg.type}`);
                }
                const threadIdMapped = msg.thread_id || threadId;
                console.log(`[MAP ${index}] Accessed msg.thread_id (using fallback):`, threadIdMapped);
                const typeMapped = (msg.type || 'system') as UnifiedMessage['type'];
                console.log(`[MAP ${index}] Accessed msg.type (using fallback):`, typeMapped);
                const isLlmMessageMapped = Boolean(msg.is_llm_message);
                console.log(`[MAP ${index}] Accessed msg.is_llm_message:`, isLlmMessageMapped);
                const contentMapped = msg.content || '';
                console.log(`[MAP ${index}] Accessed msg.content (using fallback):`, contentMapped.substring(0, 50) + '...');
                const metadataMapped = msg.metadata || '{}';
                console.log(`[MAP ${index}] Accessed msg.metadata (using fallback):`, metadataMapped);
                const createdAtMapped = msg.created_at || new Date().toISOString();
                console.log(`[MAP ${index}] Accessed msg.created_at (using fallback):`, createdAtMapped);
                const updatedAtMapped = msg.updated_at || new Date().toISOString();
                console.log(`[MAP ${index}] Accessed msg.updated_at (using fallback):`, updatedAtMapped);

                return {
                  message_id: messageId || null, 
                  thread_id: threadIdMapped,
                  type: typeMapped, 
                  is_llm_message: isLlmMessageMapped,
                  content: contentMapped,
                  metadata: metadataMapped,
                  created_at: createdAtMapped,
                  updated_at: updatedAtMapped
                };
            });
            
            setMessages(unifiedMessages); // Set the filtered and mapped messages
            console.log('[PAGE] Loaded Messages (excluding status):', unifiedMessages.length)
            
            // Debug loaded messages
            const assistantMessages = unifiedMessages.filter(m => m.type === 'assistant');
            const toolMessages = unifiedMessages.filter(m => m.type === 'tool');
            
            console.log('[PAGE] Assistant messages:', assistantMessages.length);
            console.log('[PAGE] Tool messages:', toolMessages.length);
            
            // Check if tool messages have associated assistant messages
            toolMessages.forEach(toolMsg => {
              try {
                const metadata = JSON.parse(toolMsg.metadata);
                if (metadata.assistant_message_id) {
                  const hasAssociated = assistantMessages.some(
                    assMsg => assMsg.message_id === metadata.assistant_message_id
                  );
                  console.log(`[PAGE] Tool message ${toolMsg.message_id} references assistant ${metadata.assistant_message_id} - found: ${hasAssociated}`);
                }
              } catch (e) {
                console.error("Error parsing tool message metadata:", e);
              }
            });
            
            messagesLoadedRef.current = true;
            if (!hasInitiallyScrolled.current) {
              scrollToBottom('auto');
              hasInitiallyScrolled.current = true;
            }
          }
        }

        if (!agentRunsCheckedRef.current && isMounted) {
          try {
            console.log('[PAGE] Checking for active agent runs...');
            const agentRuns = await getAgentRuns(threadId);
            agentRunsCheckedRef.current = true;

            const activeRun = agentRuns.find(run => run.status === 'running');
            if (activeRun && isMounted) {
              console.log('[PAGE] Found active run on load:', activeRun.id);
              setAgentRunId(activeRun.id);
            } else {
              console.log('[PAGE] No active agent runs found');
              if (isMounted) setAgentStatus('idle');
            }
          } catch (err) {
            console.error('[PAGE] Error checking for active runs:', err);
            agentRunsCheckedRef.current = true;
            if (isMounted) setAgentStatus('idle');
          }
        }
          
        initialLoadCompleted.current = true;

      } catch (err) {
        console.error('Error loading thread data:', err);
        if (isMounted) {
          const errorMessage = err instanceof Error ? err.message : 'Failed to load thread';
          setError(errorMessage);
          toast.error(errorMessage);
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }
    
    loadData();

    return () => {
      isMounted = false;
    };
  }, [threadId]);

  const handleSubmitMessage = useCallback(async (message: string) => {
    if (!message.trim()) return;
    setIsSending(true);

    const optimisticUserMessage: UnifiedMessage = {
      message_id: `temp-${Date.now()}`,
      thread_id: threadId,
      type: 'user',
      is_llm_message: false,
      content: message,
      metadata: '{}',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    setMessages(prev => [...prev, optimisticUserMessage]);
    setNewMessage('');
    scrollToBottom('smooth');

    try {
      const results = await Promise.allSettled([
        addUserMessage(threadId, message),
        startAgent(threadId)
      ]);

      if (results[0].status === 'rejected') {
        console.error("Failed to send message:", results[0].reason);
        throw new Error(`Failed to send message: ${results[0].reason?.message || results[0].reason}`);
      }

      if (results[1].status === 'rejected') {
        console.error("Failed to start agent:", results[1].reason);
        throw new Error(`Failed to start agent: ${results[1].reason?.message || results[1].reason}`);
      }

      const agentResult = results[1].value;
      setAgentRunId(agentResult.agent_run_id);

    } catch (err) {
      console.error('Error sending message or starting agent:', err);
      toast.error(err instanceof Error ? err.message : 'Operation failed');
      setMessages(prev => prev.filter(m => m.message_id !== optimisticUserMessage.message_id));
    } finally {
      setIsSending(false);
    }
  }, [threadId]);

  const handleStopAgent = useCallback(async () => {
    console.log(`[PAGE] Requesting agent stop via hook.`);
    setAgentStatus('idle');
    await stopStreaming();
    
    // Refetch messages after agent stop
    try {
      console.log('[PAGE] Refetching messages after agent stop');
      const messagesData = await getMessages(threadId);
      if (messagesData) {
        // Map API message type to UnifiedMessage type
        const unifiedMessages = (messagesData || [])
          .filter(msg => msg.type !== 'status') // Filter out status messages
          .map((msg: ApiMessageType, index: number) => {
            return {
              message_id: msg.message_id || null, 
              thread_id: msg.thread_id || threadId,
              type: (msg.type || 'system') as UnifiedMessage['type'], 
              is_llm_message: Boolean(msg.is_llm_message),
              content: msg.content || '',
              metadata: msg.metadata || '{}',
              created_at: msg.created_at || new Date().toISOString(),
              updated_at: msg.updated_at || new Date().toISOString()
            };
          });
        
        console.log('[PAGE] Refetched messages after stop:', unifiedMessages.length);
        setMessages(unifiedMessages);
        scrollToBottom('smooth');
      }
    } catch (err) {
      console.error('Error refetching messages after agent stop:', err);
    }
  }, [stopStreaming, threadId]);

  const handleScroll = () => {
    if (!messagesContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
    const isScrolledUp = scrollHeight - scrollTop - clientHeight > 100;
    setShowScrollButton(isScrolledUp);
    setUserHasScrolled(isScrolledUp);
  };

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    const isNewUserMessage = lastMsg?.type === 'user';
    if ((isNewUserMessage || agentStatus === 'running') && !userHasScrolled) {
      scrollToBottom('smooth');
    }
  }, [messages, agentStatus, userHasScrolled]);

  useEffect(() => {
    if (!latestMessageRef.current || messages.length === 0) return;
    const observer = new IntersectionObserver(
      ([entry]) => setShowScrollButton(!entry?.isIntersecting),
      { root: messagesContainerRef.current, threshold: 0.1 }
    );
    observer.observe(latestMessageRef.current);
    return () => observer.disconnect();
  }, [messages, streamingTextContent, streamingToolCall]);

  const handleScrollButtonClick = () => {
    scrollToBottom('smooth');
    setUserHasScrolled(false);
  };

  useEffect(() => {
    console.log(`[PAGE] 🔄 Page AgentStatus: ${agentStatus}, Hook Status: ${streamHookStatus}, Target RunID: ${agentRunId || 'none'}, Hook RunID: ${currentHookRunId || 'none'}`);
  }, [agentStatus, streamHookStatus, agentRunId, currentHookRunId]);

  const handleOpenFileViewer = useCallback((filePath?: string) => {
    if (filePath) {
      setFileToView(filePath);
    } else {
      setFileToView(null);
    }
    setFileViewerOpen(true);
  }, []);

  const handleToolClick = useCallback((clickedAssistantMessageId: string | null, clickedToolName: string) => {
    if (!clickedAssistantMessageId) {
      console.warn("Clicked assistant message ID is null. Cannot open side panel.");
      toast.warning("Cannot view details: Assistant message ID is missing.");
      return;
    }

    console.log("Tool Click Triggered. Assistant Message ID:", clickedAssistantMessageId, "Tool Name:", clickedToolName);

    const historicalToolPairs: ToolCallInput[] = [];
    const assistantMessages = messages.filter(m => m.type === 'assistant' && m.message_id);

    assistantMessages.forEach(assistantMsg => {
      // We need to parse the content to see if it actually contains tool calls
      // For simplicity, we assume any assistant message *might* have a corresponding tool result
      // A more robust solution would parse assistantMsg.content for tool XML
      
      const resultMessage = messages.find(toolMsg => {
        if (toolMsg.type !== 'tool' || !toolMsg.metadata || !assistantMsg.message_id) return false;
        try {
          const metadata = JSON.parse(toolMsg.metadata);
          return metadata.assistant_message_id === assistantMsg.message_id;
        } catch (e) {
          return false;
        }
      });

      if (resultMessage) {
        // Try to get the specific tool name from the result metadata if possible,
        // otherwise fallback to a generic name or the one passed from the click.
        let toolNameForResult = clickedToolName; // Fallback
        try {
          const assistantContentParsed = safeJsonParse<{ tool_calls?: { name: string }[] }>(assistantMsg.content, {});
          // A simple heuristic: if the assistant message content has tool_calls structure
          if (assistantContentParsed.tool_calls && assistantContentParsed.tool_calls.length > 0) {
            toolNameForResult = assistantContentParsed.tool_calls[0].name || clickedToolName;
          }
          // More advanced: parse the XML in assistant message content to find the tool name associated with this result
        } catch {}

        let isSuccess = true;
        try {
          const toolContent = resultMessage.content?.toLowerCase() || '';
          isSuccess = !(toolContent.includes('failed') || 
                        toolContent.includes('error') || 
                        toolContent.includes('failure'));
        } catch {}

        historicalToolPairs.push({
          assistantCall: {
            name: toolNameForResult,
            content: assistantMsg.content,
            timestamp: assistantMsg.created_at
          },
          toolResult: {
            content: resultMessage.content,
            isSuccess: isSuccess,
            timestamp: resultMessage.created_at
          }
        });
      } else {
        // Optionally handle assistant messages with tool calls but no result yet (or error in result)
        // console.log(`No tool result found for assistant message: ${assistantMsg.message_id}`);
      }
    });

    if (historicalToolPairs.length === 0) {
      console.warn("No historical tool pairs found to display.");
      toast.info("No tool call details available to display.");
      return;
    }

    // Find the index of the specific pair that was clicked
    const clickedIndex = historicalToolPairs.findIndex(pair => 
      pair.assistantCall.timestamp === messages.find(m => m.message_id === clickedAssistantMessageId)?.created_at
    );

    if (clickedIndex === -1) {
      console.error("Could not find the clicked tool call pair in the generated list. Displaying the first one.");
      setToolCalls(historicalToolPairs);
      setCurrentToolIndex(0); // Fallback to the first item
    } else {
      setToolCalls(historicalToolPairs);
      setCurrentToolIndex(clickedIndex);
    }
    
    setIsSidePanelOpen(true);

  }, [messages]);

  // Handle streaming tool calls - Temporarily disable opening side panel
  const handleStreamingToolCall = useCallback((toolCall: StreamingToolCall | null) => {
    if (!toolCall) return;
    console.log("[STREAM] Received tool call:", toolCall.name || toolCall.xml_tag_name);
    // --- Temporarily disable opening side panel for streaming calls ---
    // const newToolCall: ToolCallInput = {
    //   assistantCall: {
    //     name: toolCall.name || toolCall.xml_tag_name || 'Unknown Tool',
    //     content: toolCall.arguments || ''
    //     // No timestamp available easily here
    //   }
    //   // No toolResult available yet
    // };
    // setToolCalls([newToolCall]);
    // setCurrentToolIndex(0);
    // setIsSidePanelOpen(true);
    // --- End temporary disable ---
  }, []);

  // Update useEffect to handle streaming tool calls
  useEffect(() => {
    if (streamingToolCall) {
      handleStreamingToolCall(streamingToolCall);
    }
  }, [streamingToolCall, handleStreamingToolCall]);

  if (isLoading && !initialLoadCompleted.current) {
    return (
      <div className="flex h-screen">
        <div className={`flex flex-col flex-1 overflow-hidden transition-all duration-200 ease-in-out ${isSidePanelOpen ? 'mr-[90%] sm:mr-[450px] md:mr-[500px] lg:mr-[550px] xl:mr-[600px]' : ''}`}>
          <SiteHeader 
            threadId={threadId} 
            projectName={projectName}
            projectId={project?.id ?? null}
            onViewFiles={handleOpenFileViewer} 
            onToggleSidePanel={toggleSidePanel}
          />
          <div className="flex-1 overflow-y-auto px-6 py-4 pb-[5.5rem]">
            <div className="mx-auto max-w-3xl space-y-4">
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg bg-primary/10 px-4 py-3">
                  <Skeleton className="h-4 w-32" />
                </div>
              </div>
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-lg bg-muted px-4 py-3">
                  <Skeleton className="h-4 w-48 mb-2" />
                  <Skeleton className="h-4 w-40" />
                </div>
              </div>
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg bg-primary/10 px-4 py-3">
                  <Skeleton className="h-4 w-40" />
                </div>
              </div>
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-lg bg-muted px-4 py-3">
                  <Skeleton className="h-4 w-56 mb-2" />
                  <Skeleton className="h-4 w-44" />
                </div>
              </div>
            </div>
          </div>
        </div>
        <ToolCallSidePanel 
          isOpen={isSidePanelOpen} 
          onClose={() => setIsSidePanelOpen(false)}
          toolCalls={[]}
          currentIndex={0}
          onNavigate={handleSidePanelNavigate}
          project={project}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen">
        <div className={`flex flex-col flex-1 overflow-hidden transition-all duration-200 ease-in-out ${isSidePanelOpen ? 'mr-[90%] sm:mr-[450px] md:mr-[500px] lg:mr-[550px] xl:mr-[600px]' : ''}`}>
          <SiteHeader 
            threadId={threadId} 
            projectName={projectName}
            projectId={project?.id ?? null}
            onViewFiles={handleOpenFileViewer} 
            onToggleSidePanel={toggleSidePanel}
          />
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-lg border bg-card p-6 text-center">
              <h2 className="text-lg font-semibold text-destructive">Error</h2>
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" onClick={() => router.push(`/dashboard/projects/${project?.id || ''}`)}>
                Back to Project
              </Button>
            </div>
          </div>
        </div>
        <ToolCallSidePanel 
          isOpen={isSidePanelOpen} 
          onClose={() => setIsSidePanelOpen(false)}
          toolCalls={[]}
          currentIndex={0}
          onNavigate={handleSidePanelNavigate}
          project={project}
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <div className={`flex flex-col flex-1 overflow-hidden transition-all duration-200 ease-in-out ${isSidePanelOpen ? 'mr-[90%] sm:mr-[450px] md:mr-[500px] lg:mr-[550px] xl:mr-[600px]' : ''}`}>
        <SiteHeader 
          threadId={threadId} 
          projectName={projectName}
          projectId={project?.id ?? null}
          onViewFiles={handleOpenFileViewer} 
          onToggleSidePanel={toggleSidePanel}
          onProjectRenamed={handleProjectRenamed}
        />
        <div 
          ref={messagesContainerRef}
          className="flex-1 overflow-y-auto px-6 py-4 pb-[0.5rem]"
          onScroll={handleScroll}
        >
          <div className="mx-auto max-w-3xl">
            {messages.length === 0 && !streamingTextContent && !streamingToolCall && agentStatus === 'idle' ? (
              <div className="flex h-full items-center justify-center">
                <div className="text-center text-muted-foreground">Send a message to start.</div>
              </div>
            ) : (
              <div className="space-y-6">
                {(() => {
                  // Group messages logic
                  type MessageGroup = {
                    type: 'user' | 'assistant_group';
                    messages: UnifiedMessage[];
                    key: string;
                  };
                  const groupedMessages: MessageGroup[] = [];
                  let currentGroup: MessageGroup | null = null;

                  messages.forEach((message, index) => {
                    const messageType = message.type;
                    const key = message.message_id || `msg-${index}`;

                    if (messageType === 'user') {
                      if (currentGroup) {
                        groupedMessages.push(currentGroup);
                      }
                      groupedMessages.push({ type: 'user', messages: [message], key });
                      currentGroup = null;
                    } else if (messageType === 'assistant' || messageType === 'tool') {
                       // Assistant or tool message, add to the current assistant group or start a new one
                      if (currentGroup && currentGroup.type === 'assistant_group') {
                        currentGroup.messages.push(message);
                      } else {
                        if (currentGroup) { // End previous (user) group
                          groupedMessages.push(currentGroup);
                        }
                        currentGroup = { type: 'assistant_group', messages: [message], key };
                      }
                    } else if (messageType !== 'status') {
                       // Handle unknown/other non-status types if necessary
                       console.warn("Encountered unhandled message type during grouping:", messageType);
                       if (currentGroup) {
                         groupedMessages.push(currentGroup);
                       }
                       // Optionally render as a separate block or skip
                       currentGroup = null;
                    }
                    // 'status' messages are implicitly ignored by not being handled
                  });

                  if (currentGroup) {
                    groupedMessages.push(currentGroup);
                  }
                  
                  // Render grouped messages
                  return groupedMessages.map((group, groupIndex) => {
                    if (group.type === 'user') {
                      const message = group.messages[0];
                      // Fix parsing of user message content - handle both formats
                      const messageContent = (() => {
                        try {
                          const parsed = safeJsonParse<ParsedContent>(message.content, { content: message.content });
                          return parsed.content || message.content;
                        } catch {
                          return message.content;
                        }
                      })();
                      
                      return (
                        <div key={group.key} className="flex justify-end">
                          <div className="max-w-[85%] rounded-lg bg-primary/10 px-4 py-3 text-sm">
                            {messageContent}
                          </div>
                        </div>
                      );
                    } else if (group.type === 'assistant_group') {
                      return (
                        <div key={group.key} ref={groupIndex === groupedMessages.length - 1 ? latestMessageRef : null}>
                          <div className="flex items-start gap-3">
                            <div className="flex-shrink-0 w-5 h-5 mt-2 rounded-full flex items-center justify-center overflow-hidden bg-gray-200">
                              <Image src="/kortix-symbol.svg" alt="Suna" width={14} height={14} className="object-contain"/>
                            </div>
                            <div className="flex-1 space-y-2">
                              <div className="max-w-[90%] rounded-lg bg-muted px-4 py-3 text-sm">
                                <div className="space-y-3">
                                  {(() => {
                                    // Pre-process to map tool results to their calls for easier lookup
                                    const toolResultsMap = new Map<string | null, UnifiedMessage[]>();
                                    group.messages.forEach(msg => {
                                      if (msg.type === 'tool') {
                                        const meta = safeJsonParse<ParsedMetadata>(msg.metadata, {});
                                        const assistantId = meta.assistant_message_id || null;
                                        if (!toolResultsMap.has(assistantId)) {
                                          toolResultsMap.set(assistantId, []);
                                        }
                                        toolResultsMap.get(assistantId)?.push(msg);
                                      }
                                    });
                                    
                                    const renderedToolResultIds = new Set<string>();
                                    const elements: React.ReactNode[] = [];

                                    group.messages.forEach((message, msgIndex) => {
                                      if (message.type === 'assistant') {
                                        const parsedContent = safeJsonParse<ParsedContent>(message.content, {});
                                        const msgKey = message.message_id || `submsg-assistant-${msgIndex}`;

                                        const xmlRegex = /<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?>(?:[\s\S]*?)<\/\1>|<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?\/>/g;
                                        let lastIndex = 0;
                                        const contentParts: React.ReactNode[] = [];
                                        let match;

                                        if (!parsedContent.content) return; // Skip empty assistant messages

                                        while ((match = xmlRegex.exec(parsedContent.content)) !== null) {
                                          // Add text before the tag
                                          if (match.index > lastIndex) {
                                            contentParts.push(
                                              <span key={`text-${lastIndex}`} className="whitespace-pre-wrap break-words">
                                                {parsedContent.content.substring(lastIndex, match.index)}
                                              </span>
                                            );
                                          }

                                          const rawXml = match[0];
                                          const toolName = match[1] || match[2];
                                          const IconComponent = getToolIcon(toolName);
                                          const paramDisplay = extractPrimaryParam(toolName, rawXml);
                                          const toolCallKey = `tool-${match.index}`;

                                          // Find corresponding tool result (assuming order or simple 1:1 for now)
                                          const potentialResults = toolResultsMap.get(message.message_id || null) || [];
                                          const toolResult = potentialResults.find(r => !renderedToolResultIds.has(r.message_id!)); // Find first available result

                                          if (toolName === 'ask') {
                                            // Extract attachments from the XML attributes
                                            const attachmentsMatch = rawXml.match(/attachments=["']([^"']*)["']/i);
                                            const attachments = attachmentsMatch 
                                              ? attachmentsMatch[1].split(',').map(a => a.trim())
                                              : [];
                                            
                                            // Extract content from the ask tag
                                            const contentMatch = rawXml.match(/<ask[^>]*>([\s\S]*?)<\/ask>/i);
                                            const content = contentMatch ? contentMatch[1] : rawXml;

                                            // Render <ask> tag content with attachment UI
                                            contentParts.push(
                                              <div key={`ask-${match.index}`} className="space-y-3">
                                                <span className="whitespace-pre-wrap break-words">
                                                  {content}
                                                </span>
                                                
                                                {attachments.length > 0 && (
                                                  <div className="mt-3 space-y-2">
                                                    <div className="text-xs font-medium text-muted-foreground">Attachments:</div>
                                                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                                      {attachments.map((attachment, idx) => {
                                                        // Determine file type & icon based on extension
                                                        const extension = attachment.split('.').pop()?.toLowerCase();
                                                        const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(extension || '');
                                                        const isPdf = extension === 'pdf';
                                                        const isMd = extension === 'md';
                                                        
                                                        let icon = <File className="h-4 w-4 text-gray-500" />;
                                                        if (isImage) icon = <File className="h-4 w-4 text-purple-500" />;
                                                        if (isPdf) icon = <File className="h-4 w-4 text-red-500" />;
                                                        if (isMd) icon = <File className="h-4 w-4 text-blue-500" />;
                                                        
                                                        return (
                                                          <button
                                                            key={`attachment-${idx}`}
                                                            onClick={() => handleOpenFileViewer(attachment)}
                                                            className="flex items-center gap-1.5 py-1.5 px-2.5 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors cursor-pointer border border-gray-200"
                                                          >
                                                            {icon}
                                                            <span className="font-mono text-xs text-gray-700 truncate">{attachment}</span>
                                                          </button>
                                                        );
                                                      })}
                                                    </div>
                                                  </div>
                                                )}
                                              </div>
                                            );
                                          } else {
                                            // Render tool button AND its result icon inline
                                            contentParts.push(
                                              <button                                                  
                                                key={toolCallKey} // Use the tool call key for the button
                                                onClick={() => handleToolClick(message.message_id, toolName)}
                                                className="inline-flex items-center gap-1.5 py-0.5 px-2 my-0.5 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors cursor-pointer border border-gray-200"
                                              >
                                                <IconComponent className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
                                                <span className="font-mono text-xs text-gray-700">{toolName}</span>
                                                {paramDisplay && <span className="ml-1 text-gray-500 truncate max-w-[150px]" title={paramDisplay}>{paramDisplay}</span>}
                                                {/* Render status icon directly inside the button if result exists */}
                                                {toolResult && (() => {
                                                   renderedToolResultIds.add(toolResult.message_id!); // Still need to mark as rendered
                                                   const toolResultContent = safeJsonParse<ParsedContent>(toolResult.content, {});
                                                   let displayContent = '';
                                                   if (typeof toolResultContent.content === 'string') {
                                                       // Simplified parsing just to check success/failure
                                                       if (toolResultContent.content.includes('<tool_result>')) {
                                                           const toolMatch = toolResultContent.content.match(/<tool_result>([\s\S]*?)<\/tool_result>/i);
                                                           displayContent = toolMatch?.[1]?.trim() || toolResultContent.content;
                                                       } else {
                                                           displayContent = toolResultContent.content;
                                                       }
                                                   }
                                                   const toolSuccess = !(
                                                       displayContent.includes('error') || 
                                                       displayContent.includes('failed') || 
                                                       displayContent.includes('failure') ||
                                                       displayContent.includes('success=False')
                                                   );
                                                   const statusIcon = toolSuccess 
                                                       ? <CheckCircle className="h-3.5 w-3.5 text-green-500 ml-1.5 flex-shrink-0" /> // Adjusted margin
                                                       : <AlertTriangle className="h-3.5 w-3.5 text-amber-500 ml-1.5 flex-shrink-0" />; // Adjusted margin
                                                   return statusIcon;
                                                 })()}
                                              </button>
                                            );
                                          }
                                          lastIndex = xmlRegex.lastIndex;
                                        }

                                        // Add text after the last tag
                                        if (lastIndex < parsedContent.content.length) {
                                          contentParts.push(
                                            <span key={`text-${lastIndex}`} className="whitespace-pre-wrap break-words">
                                              {parsedContent.content.substring(lastIndex)}
                                            </span>
                                          );
                                        }
                                        // Add the processed assistant message parts to the main elements array
                                        if (contentParts.length > 0) {
                                            elements.push(<div key={msgKey}>{contentParts}</div>);
                                        }
                                      }
                                    });

                                    // Render all collected elements for the group
                                    return elements;
                                  })()}

                                  {/* Streaming content placeholder within the last assistant group */} 
                                  {groupIndex === groupedMessages.length - 1 && (streamHookStatus === 'streaming' || streamHookStatus === 'connecting') && (
                                    <div className="mt-2"> 
                                      {(() => {
                                          let detectedTag: string | null = null;
                                          let tagStartIndex = -1;
                                          if (streamingTextContent) {
                                              for (const tag of HIDE_STREAMING_XML_TAGS) {
                                                  const openingTagPattern = `<${tag}`;
                                                  const index = streamingTextContent.indexOf(openingTagPattern);
                                                  if (index !== -1) {
                                                      detectedTag = tag;
                                                      tagStartIndex = index;
                                                      break;
                                                  }
                                              }
                                          }

                                          const textToRender = streamingTextContent || '';
                                          const textBeforeTag = detectedTag ? textToRender.substring(0, tagStartIndex) : textToRender;
                                          const showCursor = (streamHookStatus === 'streaming' || streamHookStatus === 'connecting') && !detectedTag;

                                          return (
                                            <>
                                              {textBeforeTag && (
                                                <span className="whitespace-pre-wrap break-words">{textBeforeTag}</span>
                                              )}
                                              {showCursor && (
                                                 <span className="inline-block h-4 w-0.5 bg-gray-400 ml-0.5 -mb-1 animate-pulse" />
                                               )}

                                              {/* Render detected streaming tag (placeholder) */}
                                              {detectedTag && (
                                                 <div className="mt-1">
                                                   <button
                                                      className="inline-flex items-center gap-1.5 py-0.5 px-2 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors cursor-pointer border border-gray-200"
                                                    >
                                                      <CircleDashed className="h-3.5 w-3.5 text-gray-500 flex-shrink-0 animate-spin animation-duration-2000" />
                                                      <span className="font-mono text-xs text-gray-700">{detectedTag}</span>
                                                    </button>
                                                  </div>
                                              )}

                                              {/* Render fully parsed streaming tool call (placeholder) */}
                                              {streamingToolCall && !detectedTag && (
                                                <div className="mt-1">
                                                  {(() => {
                                                    const toolName = streamingToolCall.name || streamingToolCall.xml_tag_name || 'Tool';
                                                    const IconComponent = getToolIcon(toolName);
                                                    const paramDisplay = extractPrimaryParam(toolName, streamingToolCall.arguments || '');
                                                    return (
                                                      <button
                                                        className="inline-flex items-center gap-1.5 py-0.5 px-2 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors cursor-pointer border border-gray-200"
                                                      >
                                                        <CircleDashed className="h-3.5 w-3.5 text-gray-500 flex-shrink-0 animate-spin animation-duration-2000" />
                                                        <span className="font-mono text-xs text-gray-700">{toolName}</span>
                                                        {paramDisplay && <span className="ml-1 text-gray-500 truncate" title={paramDisplay}>{paramDisplay}</span>}
                                                      </button>
                                                    );
                                                  })()}
                                                </div>
                                              )}
                                            </>
                                          );
                                      })()}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    }
                    return null; // Should not happen
                  });
                })()}
                 {/* Render thinking indicator ONLY if agent is running AND the last group wasn't assistant OR there are no messages yet */}
                 {(agentStatus === 'running' || agentStatus === 'connecting') && 
                   (messages.length === 0 || messages[messages.length - 1].type === 'user') && (
                      <div ref={latestMessageRef}>
                         <div className="flex items-start gap-3">
                             <div className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center overflow-hidden bg-gray-200">
                               <Image src="/kortix-symbol.svg" alt="Suna" width={14} height={14} className="object-contain"/>
                             </div>
                        <div className="flex-1 space-y-2">
                          <div className="max-w-[90%] px-4 py-3 text-sm">
                            <div className="flex items-center gap-1.5 py-1"> {/* Adjusted padding/margin */}
                              <div className="h-1.5 w-1.5 rounded-full bg-gray-400/50 animate-pulse" />
                              <div className="h-1.5 w-1.5 rounded-full bg-gray-400/50 animate-pulse delay-150" />
                              <div className="h-1.5 w-1.5 rounded-full bg-gray-400/50 animate-pulse delay-300" />
                            </div>
                          </div>
                        </div>
                        </div>
                      </div>
                  )}
              </div>
            )}
            <div ref={messagesEndRef} className="h-1" />
          </div>

          <div
            className="sticky bottom-6 flex justify-center transition-opacity duration-300"
            style={{ opacity: showScrollButton ? 1 : 0, visibility: showScrollButton ? 'visible' : 'hidden' }}
          >
            <Button variant="outline" size="icon" className="h-8 w-8 rounded-full" onClick={handleScrollButtonClick}>
              <ArrowDown className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div>
          <div className="mx-auto max-w-3xl px-6 py-2">
            <ChatInput
              value={newMessage}
              onChange={setNewMessage}
              onSubmit={handleSubmitMessage}
              placeholder="Ask Suna anything..."
              loading={isSending}
              disabled={isSending || agentStatus === 'running' || agentStatus === 'connecting'}
              isAgentRunning={agentStatus === 'running' || agentStatus === 'connecting'}
              onStopAgent={handleStopAgent}
              autoFocus={!isLoading}
              onFileBrowse={handleOpenFileViewer}
              sandboxId={sandboxId || undefined}
            />
          </div>
        </div>
      </div>

      <ToolCallSidePanel 
        isOpen={isSidePanelOpen} 
        onClose={() => setIsSidePanelOpen(false)}
        toolCalls={toolCalls}
        currentIndex={currentToolIndex}
        onNavigate={handleSidePanelNavigate}
        project={project}
      />

      {sandboxId && (
        <FileViewerModal
          open={fileViewerOpen}
          onOpenChange={setFileViewerOpen}
          sandboxId={sandboxId}
          initialFilePath={fileToView}
        />
      )}
    </div>
  );
}
