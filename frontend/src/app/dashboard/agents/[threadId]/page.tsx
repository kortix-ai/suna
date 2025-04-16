'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ArrowDown, File } from 'lucide-react';
import { addUserMessage, getMessages, startAgent, stopAgent, getAgentStatus, streamAgent, getAgentRuns, getProject, getThread } from '@/lib/api';
import { toast } from 'sonner';
import { Skeleton } from "@/components/ui/skeleton";
import { ChatInput } from '@/components/thread/chat-input';
import { FileViewerModal } from '@/components/thread/file-viewer-modal';

// Define a type for the params to make React.use() work properly
type ThreadParams = { 
  threadId: string;
};

interface ApiMessage {
  role: string;
  content: string;
  type?: string;
  name?: string;
  arguments?: string;
  tool_call?: {
    id: string;
    function: {
      name: string;
      arguments: string;
    };
    type: string;
    index: number;
  };
}

interface ApiAgentRun {
  id: string;
  thread_id: string;
  status: 'running' | 'completed' | 'stopped' | 'error';
  started_at: string;
  completed_at: string | null;
  responses: ApiMessage[];
  error: string | null;
}

export default function ThreadPage({ params }: { params: Promise<ThreadParams> }) {
  const unwrappedParams = React.use(params);
  const threadId = unwrappedParams.threadId;
  
  const router = useRouter();
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<'idle' | 'running' | 'paused'>('idle');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState('');
  const [toolCallData, setToolCallData] = useState<{id?: string, name?: string, arguments?: string, index?: number} | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  
  const streamCleanupRef = useRef<(() => void) | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const initialLoadCompleted = useRef<boolean>(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const latestMessageRef = useRef<HTMLDivElement>(null);
  const messagesLoadedRef = useRef(false);
  const agentRunsCheckedRef = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [buttonOpacity, setButtonOpacity] = useState(0);
  const [userHasScrolled, setUserHasScrolled] = useState(false);
  const hasInitiallyScrolled = useRef<boolean>(false);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [fileViewerOpen, setFileViewerOpen] = useState(false);

  const handleStreamAgent = useCallback(async (runId: string) => {
    // Prevent multiple streams for the same run
    if (streamCleanupRef.current && agentRunId === runId) {
      console.log(`[PAGE] Stream already exists for run ${runId}, skipping`);
      return;
    }

    // Clean up any existing stream
    if (streamCleanupRef.current) {
      console.log(`[PAGE] Cleaning up existing stream before starting new one`);
      streamCleanupRef.current();
      streamCleanupRef.current = null;
    }
    
    setIsStreaming(true);
    setStreamContent('');
    
    console.log(`[PAGE] Setting up stream for agent run ${runId}`);
    
    // Start streaming the agent's responses with improved implementation
    const cleanup = streamAgent(runId, {
      onMessage: async (rawData: string) => {
        try {
          // Update last message timestamp to track stream health
          (window as any).lastStreamMessage = Date.now();
          
          // Log the raw data first for debugging
          console.log(`[PAGE] Raw message data:`, rawData);
          
          let processedData = rawData;
          let jsonData: {
            type?: string;
            status?: string;
            content?: string;
            message?: string;
            name?: string;
            arguments?: string;
            tool_call?: {
              id: string;
              function: {
                name: string;
                arguments: string;
              };
              type: string;
              index: number;
            };
          } | null = null;
          
          try {
            jsonData = JSON.parse(processedData);
            
            // Handle error messages immediately and only once
            if (jsonData?.status === 'error' && jsonData?.message) {
              // Get a clean string version of the error, handling any nested objects
              const errorMessage = typeof jsonData.message === 'object' 
                ? JSON.stringify(jsonData.message)
                : String(jsonData.message);

              if (jsonData.status !== 'error') {
                console.error('[PAGE] Error from stream:', errorMessage);
              }
              
              // Only show toast and cleanup if we haven't already
              if (agentStatus === 'running') {
                toast.error(errorMessage);
                setAgentStatus('idle');
                setAgentRunId(null);
                
                // Clean up the stream
                if (streamCleanupRef.current) {
                  streamCleanupRef.current();
                  streamCleanupRef.current = null;
                }
              }
              return;
            }

            // Handle completion status
            if (jsonData?.type === 'status' && jsonData?.status === 'completed') {
              console.log('[PAGE] Received completion status');
              if (streamCleanupRef.current) {
                streamCleanupRef.current();
                streamCleanupRef.current = null;
              }
              setAgentStatus('idle');
              setAgentRunId(null);
              return;
            }
          } catch (e) {
            console.warn('[PAGE] Failed to parse message:', e);
          }

          // Continue with normal message processing...
          // ... rest of the onMessage handler ...
        } catch (error) {
          console.error('[PAGE] Error processing message:', error);
          toast.error('Failed to process agent response');
        }
      },
      onError: (error: Error | string) => {
        console.error('[PAGE] Streaming error:', error);
        
        // Show error toast and clean up state
        toast.error(typeof error === 'string' ? error : error.message);
        
        // Clean up on error
        streamCleanupRef.current = null;
        setIsStreaming(false);
        setAgentStatus('idle');
        setAgentRunId(null);
        setStreamContent('');  // Clear any partial content
      },
      onClose: async () => {
        console.log('[PAGE] Stream connection closed');
        
        // Immediately set UI state to idle
        setAgentStatus('idle');
        setIsStreaming(false);
        
        // Reset tool call data
        setToolCallData(null);
        
        try {
          // Only check status if we still have an agent run ID
          if (agentRunId) {
            console.log(`[PAGE] Checking final status for agent run ${agentRunId}`);
            const status = await getAgentStatus(agentRunId);
            console.log(`[PAGE] Agent status: ${status.status}`);
            
            // Clear cleanup reference to prevent reconnection
            streamCleanupRef.current = null;
            
            // Set agent run ID to null to prevent lingering state
            setAgentRunId(null);
            
            // Fetch final messages first, then clear streaming content
            console.log('[PAGE] Fetching final messages');
            const updatedMessages = await getMessages(threadId);
            
            // Update messages first
            setMessages(updatedMessages as ApiMessage[]);
            
            // Then clear streaming content
            setStreamContent('');
          }
        } catch (err) {
          console.error('[PAGE] Error checking agent status:', err);
          toast.error('Failed to verify agent status');
          
          // Clear the agent run ID
          setAgentRunId(null);
          setStreamContent('');
        }
      }
    });
    
    // Store cleanup function
    streamCleanupRef.current = cleanup;
  }, [threadId, agentRunId]);

  useEffect(() => {
    let isMounted = true;

    async function loadData() {
      // Only show loading state on the first load, not when switching tabs
      if (!initialLoadCompleted.current) {
        setIsLoading(true);
      }
      
      setError(null);
      
      try {
        if (!threadId) {
          throw new Error('Thread ID is required');
        }
        
        // First fetch the thread to get the project_id
        const threadData = await getThread(threadId).catch(err => {
          throw new Error('Failed to load thread data: ' + err.message);
        });
        
        if (!isMounted) return;
        
        // Set the project ID from the thread data
        if (threadData && threadData.project_id) {
          setProjectId(threadData.project_id);
        }
        
        // Fetch project details to get sandbox_id
        if (threadData && threadData.project_id) {
          const projectData = await getProject(threadData.project_id);
          if (isMounted && projectData && projectData.sandbox) {
            // Extract the sandbox ID correctly
            setSandboxId(typeof projectData.sandbox === 'string' ? projectData.sandbox : projectData.sandbox.id);
            
            // Load messages only if not already loaded
            if (!messagesLoadedRef.current) {
              const messagesData = await getMessages(threadId);
              if (isMounted) {
                setMessages(messagesData as ApiMessage[]);
                messagesLoadedRef.current = true;
                
                // Only scroll to bottom on initial page load
                if (!hasInitiallyScrolled.current) {
                  scrollToBottom('auto');
                  hasInitiallyScrolled.current = true;
                }
              }
            }

            // Check for active agent runs only once per thread
            if (!agentRunsCheckedRef.current) {
              try {
                // Get agent runs for this thread using the proper API function
                const agentRuns = await getAgentRuns(threadId);
                agentRunsCheckedRef.current = true;
                
                // Look for running agent runs
                const activeRuns = agentRuns.filter(run => run.status === 'running');
                if (activeRuns.length > 0 && isMounted) {
                  // Sort by start time to get the most recent
                  activeRuns.sort((a, b) => 
                    new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
                  );
                  
                  // Set the current agent run
                  const latestRun = activeRuns[0];
                  if (latestRun) {
                    setAgentRunId(latestRun.id);
                    setAgentStatus('running');
                    
                    // Start streaming only on initial page load
                    console.log('Starting stream for active run on initial page load');
                    handleStreamAgent(latestRun.id);
                  }
                }
              } catch (err) {
                console.error('Error checking for active runs:', err);
              }
            }
            
            // Mark that we've completed the initial load
            initialLoadCompleted.current = true;
          }
        }
      } catch (err) {
        console.error('Error loading thread data:', err);
        if (isMounted) {
          const errorMessage = err instanceof Error ? err.message : 'Failed to load thread';
          setError(errorMessage);
          toast.error(errorMessage);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }
    
    loadData();

    // Handle visibility changes for more responsive streaming
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && agentRunId && agentStatus === 'running') {
        console.log('[PAGE] Page became visible, checking stream health');
        
        // Check if we've received any messages recently
        const lastMessage = (window as any).lastStreamMessage || 0;
        const now = Date.now();
        const messageTimeout = 10000; // 10 seconds
        
        // Only reconnect if we haven't received messages in a while
        if (!streamCleanupRef.current && (!lastMessage || (now - lastMessage > messageTimeout))) {
          // Add a debounce to prevent rapid reconnections
          const lastStreamAttempt = (window as any).lastStreamAttempt || 0;
          
          if (now - lastStreamAttempt > 5000) { // 5 second cooldown
            console.log('[PAGE] Stream appears stale, reconnecting');
            (window as any).lastStreamAttempt = now;
            handleStreamAgent(agentRunId);
          } else {
            console.log('[PAGE] Skipping reconnect - too soon since last attempt');
          }
        } else {
          console.log('[PAGE] Stream appears healthy, no reconnection needed');
        }
      }
    };

    // Add visibility change listener
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Cleanup function
    return () => {
      isMounted = false;
      
      // Remove visibility change listener
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      
      // Properly clean up stream
      if (streamCleanupRef.current) {
        console.log('[PAGE] Cleaning up stream on unmount');
        streamCleanupRef.current();
        streamCleanupRef.current = null;
      }
      
      // Reset component state to prevent memory leaks
      console.log('[PAGE] Resetting component state on unmount');
    };
  }, [threadId, handleStreamAgent, agentRunId, agentStatus, isStreaming]);

  const handleSubmitMessage = async (message: string) => {
    if (!message.trim()) return;
    
    setIsSending(true);
    
    try {
      // Add the message optimistically to the UI
      const userMessage: ApiMessage = {
        role: 'user',
        content: message
      };
      
      setMessages(prev => [...prev, userMessage]);
      setNewMessage('');
      scrollToBottom();
      
      // Send to the API and start agent in parallel
      const [messageResult, agentResult] = await Promise.all([
        addUserMessage(threadId, userMessage.content).catch(err => {
          throw new Error('Failed to send message: ' + err.message);
        }),
        startAgent(threadId).catch(err => {
          throw new Error('Failed to start agent: ' + err.message);
        })
      ]);
      
      setAgentRunId(agentResult.agent_run_id);
      setAgentStatus('running');
      
      // Start streaming the agent's responses immediately
      handleStreamAgent(agentResult.agent_run_id);
    } catch (err) {
      console.error('Error sending message:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to send message');
      
      // Remove the optimistically added message on error
      setMessages(prev => prev.slice(0, -1));
    } finally {
      setIsSending(false);
    }
  };

  const handleStopAgent = async () => {
    if (!agentRunId) {
      console.warn('[PAGE] No agent run ID to stop');
      return;
    }
    
    console.log(`[PAGE] Stopping agent run: ${agentRunId}`);
    
    try {
      // First clean up the stream if it exists
      if (streamCleanupRef.current) {
        console.log('[PAGE] Cleaning up stream connection');
        streamCleanupRef.current();
        streamCleanupRef.current = null;
      }
      
      // Mark as not streaming, but keep content visible during transition
      setIsStreaming(false);
      setAgentStatus('idle');
      
      // Then stop the agent
      console.log('[PAGE] Sending stop request to backend');
      await stopAgent(agentRunId).catch(err => {
        throw new Error('Failed to stop agent: ' + err.message);
      });
      
      // Update UI
      console.log('[PAGE] Agent stopped successfully');
      toast.success('Agent stopped successfully');
      
      // Reset agent run ID
      setAgentRunId(null);
      
      // Fetch final messages to get state from database
      console.log('[PAGE] Fetching final messages after stop');
      const updatedMessages = await getMessages(threadId);
      
      // Update messages first - cast to ApiMessage[] to fix type error
      setMessages(updatedMessages as ApiMessage[]);
      
      // Then clear streaming content after a tiny delay for smooth transition
      setTimeout(() => {
        console.log('[PAGE] Clearing streaming content');
        setStreamContent('');
      }, 50);
    } catch (err) {
      console.error('[PAGE] Error stopping agent:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to stop agent');
      
      // Still update UI state to avoid being stuck
      setAgentStatus('idle');
      setIsStreaming(false);
      setAgentRunId(null);
      setStreamContent('');
    }
  };

  // Auto-focus on textarea when component loads
  useEffect(() => {
    if (!isLoading && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isLoading]);

  // Adjust textarea height based on content
  useEffect(() => {
    const adjustHeight = () => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
      }
    };

    adjustHeight();
    
    // Adjust on window resize too
    window.addEventListener('resize', adjustHeight);
    return () => window.removeEventListener('resize', adjustHeight);
  }, [newMessage]);

  // // Handle keyboard shortcuts
  // const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
  //   // Send on Enter (without Shift)
  //   if (e.key === 'Enter' && !e.shiftKey) {
  //     e.preventDefault();
      
  //     if (newMessage.trim() && !isSending && agentStatus !== 'running') {
  //       handleSubmitMessage(newMessage);
  //     }
  //   }
  // };

  // Check if user has scrolled up from bottom
  const handleScroll = () => {
    if (!messagesContainerRef.current) return;
    
    const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
    const isScrolledUp = scrollHeight - scrollTop - clientHeight > 100;
    
    setShowScrollButton(isScrolledUp);
    setButtonOpacity(isScrolledUp ? 1 : 0);
    setUserHasScrolled(isScrolledUp);
  };

  // Scroll to bottom explicitly
  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  // Auto-scroll only when:
  // 1. User sends a new message
  // 2. Agent starts responding
  // 3. User clicks the scroll button
  useEffect(() => {
    const isNewUserMessage = messages.length > 0 && messages[messages.length - 1]?.role === 'user';
    
    if ((isNewUserMessage || agentStatus === 'running') && !userHasScrolled) {
      scrollToBottom();
    }
  }, [messages, agentStatus, userHasScrolled]);

  // Make sure clicking the scroll button scrolls to bottom
  const handleScrollButtonClick = () => {
    scrollToBottom();
    setUserHasScrolled(false);
  };

  // Remove unnecessary scroll effects
  useEffect(() => {
    if (!latestMessageRef.current || messages.length === 0) return;
    
    const observer = new IntersectionObserver(
      ([entry]) => {
        setShowScrollButton(!entry?.isIntersecting);
        setButtonOpacity(entry?.isIntersecting ? 0 : 1);
      },
      {
        root: messagesContainerRef.current,
        threshold: 0.1,
      }
    );
    
    observer.observe(latestMessageRef.current);
    return () => observer.disconnect();
  }, [messages, streamContent]);

  // Update UI states when agent status changes
  useEffect(() => {
    // Scroll to bottom when agent starts responding, but only if user hasn't scrolled up manually
    if (agentStatus === 'running' && !userHasScrolled) {
      scrollToBottom();
    }
  }, [agentStatus, userHasScrolled]);

  // Add synchronization effect to ensure agentRunId and agentStatus are in sync
  useEffect(() => {
    // If agentRunId is null, make sure agentStatus is 'idle'
    if (agentRunId === null && agentStatus !== 'idle') {
      console.log('[PAGE] Synchronizing agent status to idle because agentRunId is null');
      setAgentStatus('idle');
      setIsStreaming(false);
    }
    
    // If we have an agentRunId but status is idle, check if it should be running
    if (agentRunId !== null && agentStatus === 'idle') {
      const checkAgentRunStatus = async () => {
        try {
          const status = await getAgentStatus(agentRunId);
          if (status.status === 'running') {
            console.log('[PAGE] Synchronizing agent status to running based on backend status');
            setAgentStatus('running');
            
            // If not already streaming, start streaming
            if (!isStreaming && !streamCleanupRef.current) {
              console.log('[PAGE] Starting stream due to status synchronization');
              handleStreamAgent(agentRunId);
            }
          } else {
            // If the backend shows completed/stopped but we have an ID, reset it
            console.log('[PAGE] Agent run is not running, resetting agentRunId');
            setAgentRunId(null);
          }
        } catch (err) {
          console.error('[PAGE] Error checking agent status for sync:', err);
          // In case of error, reset to idle state
          setAgentRunId(null);
          setAgentStatus('idle');
          setIsStreaming(false);
        }
      };
      
      checkAgentRunStatus();
    }
  }, [agentRunId, agentStatus, isStreaming, handleStreamAgent]);

  // Add debug logging for agentStatus changes
  useEffect(() => {
    console.log(`[PAGE] 🔄 AgentStatus changed to: ${agentStatus}, isStreaming: ${isStreaming}, agentRunId: ${agentRunId}`);
  }, [agentStatus, isStreaming, agentRunId]);

  // Failsafe effect to ensure UI consistency
  useEffect(() => {
    // Force agentStatus to idle if not streaming or no agentRunId
    if ((!isStreaming || agentRunId === null) && agentStatus !== 'idle') {
      console.log('[PAGE] 🔒 FAILSAFE: Forcing agentStatus to idle because isStreaming is false or agentRunId is null');
      setAgentStatus('idle');
    }
  }, [isStreaming, agentRunId, agentStatus]);

  // Open the file viewer modal
  const handleOpenFileViewer = () => {
    setFileViewerOpen(true);
  };

  // Only show a full-screen loader on the very first load
  if (isLoading && !initialLoadCompleted.current) {
    return (
      <div className="flex h-[calc(100vh-4rem)] flex-col">
        <div className="relative flex-1 flex flex-col">
          <div className="absolute inset-0 overflow-y-auto px-6 py-4 pb-[5.5rem]">
            <div className="mx-auto max-w-3xl">
              <div className="space-y-4">
                {/* User message skeleton */}
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg bg-primary/10 px-4 py-3">
                    <Skeleton className="h-4 w-32" />
                  </div>
                </div>
                
                {/* Assistant message skeleton */}
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-lg bg-muted px-4 py-3">
                    <Skeleton className="h-4 w-48 mb-2" />
                    <Skeleton className="h-4 w-40" />
                  </div>
                </div>
                
                {/* User message skeleton */}
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-lg bg-primary/10 px-4 py-3">
                    <Skeleton className="h-4 w-40" />
                  </div>
                </div>
                
                {/* Assistant message skeleton */}
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-lg bg-muted px-4 py-3">
                    <Skeleton className="h-4 w-56 mb-2" />
                    <Skeleton className="h-4 w-44" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Input area skeleton */}
          <div className="absolute inset-x-0 bottom-0 border-t bg-background/80 backdrop-blur-sm">
            <div className="mx-auto max-w-3xl px-6 py-4">
              <div className="relative">
                <Skeleton className="h-[50px] w-full rounded-md" />
                <div className="absolute right-2 bottom-2">
                  <Skeleton className="h-8 w-8 rounded-full" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-[calc(100vh-4rem)] items-center justify-center">
        <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-lg border bg-card p-6 text-center">
          <h2 className="text-lg font-semibold text-destructive">Error</h2>
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" onClick={() => router.push(`/dashboard/projects/${projectId || ''}`)}>
            Back to Project
          </Button>
        </div>
      </div>
    );
  }

  // const projectName = project?.name || 'Loading...';

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <div className="relative flex-1 flex flex-col">
        <div 
          ref={messagesContainerRef}
          className="absolute inset-0 overflow-y-auto px-6 py-4 pb-[5.5rem]" 
          onScroll={handleScroll}
        >
          <div className="mx-auto max-w-3xl">
            {messages.length === 0 && !streamContent ? (
              <div className="flex h-full items-center justify-center">
                <div className="flex flex-col items-center gap-1 text-center">
                  <p className="text-sm text-muted-foreground">Send a message to start the conversation.</p>
                  <p className="text-xs text-muted-foreground/60">The AI agent will respond automatically.</p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((message, index) => (
                  <div 
                    key={index} 
                    ref={index === messages.length - 1 && message.role === 'assistant' ? latestMessageRef : null}
                    className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div 
                      className={`max-w-[85%] rounded-lg px-4 py-3 text-sm ${
                        message.role === 'user' 
                          ? 'bg-primary text-primary-foreground' 
                          : 'bg-muted'
                      }`}
                    >
                      <div className="whitespace-pre-wrap break-words">
                        {message.type === 'tool_call' ? (
                          <div className="font-mono text-xs">
                            <div className="flex items-center gap-2 mb-1 text-muted-foreground">
                              <div className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/10">
                                <div className="h-2 w-2 rounded-full bg-primary"></div>
                              </div>
                              <span>Tool: {message.name}</span>
                            </div>
                            <div className="mt-1 p-3 bg-secondary/20 rounded-md overflow-x-auto">
                              {message.arguments}
                            </div>
                          </div>
                        ) : message.role === 'tool' ? (
                          <div className="font-mono text-xs">
                            <div className="flex items-center gap-2 mb-1 text-muted-foreground">
                              <div className="flex h-4 w-4 items-center justify-center rounded-full bg-success/10">
                                <div className="h-2 w-2 rounded-full bg-success"></div>
                              </div>
                              <span>Tool Result: {message.name}</span>
                            </div>
                            <div className="mt-1 p-3 bg-success/5 rounded-md">
                              {message.content}
                            </div>
                          </div>
                        ) : (
                          message.content
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                
                {streamContent && (
                  <div 
                    ref={latestMessageRef}
                    className="flex justify-start"
                  >
                    <div className="max-w-[85%] rounded-lg bg-muted px-4 py-3 text-sm">
                      <div className="whitespace-pre-wrap break-words">
                        {toolCallData ? (
                          <div className="font-mono text-xs">
                            <div className="flex items-center gap-2 mb-1 text-muted-foreground">
                              <div className="flex h-4 w-4 items-center justify-center rounded-full bg-primary/10">
                                <div className="h-2 w-2 rounded-full bg-primary animate-pulse"></div>
                              </div>
                              <span>Tool: {toolCallData.name}</span>
                            </div>
                            <div className="mt-1 p-3 bg-secondary/20 rounded-md overflow-x-auto">
                              {toolCallData.arguments || ''}
                            </div>
                          </div>
                        ) : (
                          streamContent
                        )}
                        {isStreaming && (
                          <span className="inline-flex items-center ml-0.5">
                            <span 
                              className="inline-block h-4 w-0.5 bg-foreground/50 mx-px"
                              style={{ 
                                opacity: 0.7,
                                animation: 'cursorBlink 1s ease-in-out infinite',
                              }}
                            />
                            <style jsx global>{`
                              @keyframes cursorBlink {
                                0%, 100% { opacity: 1; }
                                50% { opacity: 0; }
                              }
                            `}</style>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                
                {agentStatus === 'running' && !streamContent && (
                  <div className="flex justify-start">
                    <div className="flex items-center gap-1.5 rounded-lg bg-muted px-4 py-3">
                      <div className="h-1.5 w-1.5 rounded-full bg-foreground/50 animate-pulse" />
                      <div className="h-1.5 w-1.5 rounded-full bg-foreground/50 animate-pulse delay-150" />
                      <div className="h-1.5 w-1.5 rounded-full bg-foreground/50 animate-pulse delay-300" />
                    </div>
                  </div>
                )}
                
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>
          
          <div 
            className="sticky bottom-6 flex justify-center"
            style={{ 
              opacity: buttonOpacity,
              transition: 'opacity 0.3s ease-in-out',
              visibility: showScrollButton ? 'visible' : 'hidden'
            }}
          >
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 rounded-full bg-background/80 backdrop-blur-sm hover:bg-background"
              onClick={handleScrollButtonClick}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="absolute inset-x-0 bottom-0 border-t bg-background/80 backdrop-blur-sm">
          <div className="mx-auto max-w-3xl px-6 py-4">
            <ChatInput
              value={newMessage}
              onChange={setNewMessage}
              onSubmit={handleSubmitMessage}
              placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
              loading={isSending}
              disabled={isSending}
              isAgentRunning={agentStatus === 'running'}
              onStopAgent={handleStopAgent}
              autoFocus={!isLoading}
              onFileBrowse={handleOpenFileViewer}
              sandboxId={sandboxId || undefined}
            />
            
            {/* File Viewer Modal */}
            {sandboxId && (
              <FileViewerModal
                open={fileViewerOpen}
                onOpenChange={setFileViewerOpen}
                sandboxId={sandboxId}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
} 