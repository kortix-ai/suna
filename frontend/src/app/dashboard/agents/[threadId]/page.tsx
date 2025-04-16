'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ArrowDown, File, Terminal, ExternalLink, User, CheckCircle, CircleDashed } from 'lucide-react';
import { addUserMessage, getMessages, startAgent, stopAgent, getAgentStatus, streamAgent, getAgentRuns, getProject, getThread, updateProject } from '@/lib/api';
import { toast } from 'sonner';
import { Skeleton } from "@/components/ui/skeleton";
import { ChatInput } from '@/components/thread/chat-input';
import { FileViewerModal } from '@/components/thread/file-viewer-modal';
import { SiteHeader } from "@/components/thread/thread-site-header"
import { ToolCallSidePanel, SidePanelContent, ToolCallData } from "@/components/thread/tool-call-side-panel";
import { useSidebar } from "@/components/ui/sidebar";

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

// Define structure for grouped tool call/result sequences
type ToolSequence = {
  type: 'tool_sequence';
  items: ApiMessage[];
};

// Type for items that will be rendered
type RenderItem = ApiMessage | ToolSequence;

// Type guard to check if an item is a ToolSequence
function isToolSequence(item: RenderItem): item is ToolSequence {
  return (item as ToolSequence).type === 'tool_sequence';
}

// Function to group consecutive assistant tool call / user tool result pairs
function groupMessages(messages: ApiMessage[]): RenderItem[] {
  const grouped: RenderItem[] = [];
  let i = 0;
  const excludedTags = ['ask', 'inform']; // Tags to exclude from grouping

  while (i < messages.length) {
    const currentMsg = messages[i];
    const nextMsg = i + 1 < messages.length ? messages[i + 1] : null;

    let currentSequence: ApiMessage[] = [];

    // Check if current message is the start of a potential sequence
    if (currentMsg.role === 'assistant') {
      // Regex to find the first XML-like tag: <tagname ...> or <tagname>
      const toolTagMatch = currentMsg.content?.match(/<([a-zA-Z\-_]+)(?:\s+[^>]*)?>/);
      if (toolTagMatch && nextMsg && nextMsg.role === 'user') {
        const expectedTag = toolTagMatch[1];
        // *** Check if the tag is excluded ***
        if (excludedTags.includes(expectedTag)) {
          // If excluded, treat as a normal message and break potential sequence start
          grouped.push(currentMsg);
          i++;
          continue;
        }

        // Regex to check for <tool_result><tagname>...</tagname></tool_result>
        // Using 's' flag for dotall to handle multiline content within tags -> Replaced with [\s\S] to avoid ES target issues
        const toolResultRegex = new RegExp(`^<tool_result>\\s*<(${expectedTag})(?:\\s+[^>]*)?>[\\s\\S]*?</\\1>\\s*</tool_result>`);

        if (nextMsg.content?.match(toolResultRegex)) {
          // Found a pair, start a sequence
          currentSequence.push(currentMsg);
          currentSequence.push(nextMsg);
          i += 2; // Move past this pair

          // Check for continuation
          while (i < messages.length) {
            const potentialAssistant = messages[i];
            const potentialUser = i + 1 < messages.length ? messages[i + 1] : null;

            if (potentialAssistant.role === 'assistant') {
              const nextToolTagMatch = potentialAssistant.content?.match(/<([a-zA-Z\-_]+)(?:\s+[^>]*)?>/);
              if (nextToolTagMatch && potentialUser && potentialUser.role === 'user') {
                const nextExpectedTag = nextToolTagMatch[1];
                // *** Check if the continuation tag is excluded ***
                if (excludedTags.includes(nextExpectedTag)) {
                  // If excluded, break the sequence
                  break;
                }

                // Replaced dotall 's' flag with [\s\S]
                const nextToolResultRegex = new RegExp(`^<tool_result>\\s*<(${nextExpectedTag})(?:\\s+[^>]*)?>[\\s\\S]*?</\\1>\\s*</tool_result>`);

                if (potentialUser.content?.match(nextToolResultRegex)) {
                  // Sequence continues
                  currentSequence.push(potentialAssistant);
                  currentSequence.push(potentialUser);
                  i += 2; // Move past the added pair
                } else {
                  // Assistant/User message, but not a matching tool result pair - break sequence
                  break;
                }
              } else {
                // Assistant message without tool tag, or no following user message - break sequence
                break;
              }
            } else {
              // Not an assistant message - break sequence
              break;
            }
          }
          // Add the completed sequence to grouped results
          grouped.push({ type: 'tool_sequence', items: currentSequence });
          continue; // Continue the outer loop from the new 'i'
        }
      }
    }

    // If no sequence was started or continued, add the current message normally
    if (currentSequence.length === 0) {
       grouped.push(currentMsg);
       i++; // Move to the next message
    }
  }
  return grouped;
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
  const [toolCallData, setToolCallData] = useState<ToolCallData | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string>('Project');
  
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
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(false);
  const initialLayoutAppliedRef = useRef(false);
  const [sidePanelContent, setSidePanelContent] = useState<SidePanelContent | null>(null);
  const [allHistoricalPairs, setAllHistoricalPairs] = useState<{ assistantCall: ApiMessage, userResult: ApiMessage }[]>([]);
  const [currentPairIndex, setCurrentPairIndex] = useState<number | null>(null);

  // Access the state and controls for the main SidebarLeft
  const { state: leftSidebarState, setOpen: setLeftSidebarOpen } = useSidebar();

  // Handler to toggle the right side panel (ToolCallSidePanel)
  const toggleSidePanel = useCallback(() => {
    setIsSidePanelOpen(prevIsOpen => !prevIsOpen);
  }, []);

  // Function to handle project renaming from SiteHeader
  const handleProjectRenamed = useCallback((newName: string) => {
    setProjectName(newName);
  }, []);

  // Effect to enforce exclusivity: Close left sidebar if right panel opens
  useEffect(() => {
    if (isSidePanelOpen && leftSidebarState !== 'collapsed') {
      // Run this update as an effect after the right panel state is set to true
      setLeftSidebarOpen(false);
    }
  }, [isSidePanelOpen, leftSidebarState, setLeftSidebarOpen]);

  // Effect to enforce exclusivity: Close the right panel if the left sidebar is opened
  useEffect(() => {
    if (leftSidebarState === 'expanded' && isSidePanelOpen) {
      setIsSidePanelOpen(false);
    }
  }, [leftSidebarState, isSidePanelOpen]);

  // Auto-close left sidebar and open tool call side panel on page load
  useEffect(() => {
    // Only apply the initial layout once and only on first mount
    if (!initialLayoutAppliedRef.current) {
      // Close the left sidebar when page loads
      setLeftSidebarOpen(false);
      
      // Mark that we've applied the initial layout
      initialLayoutAppliedRef.current = true;
    }
    // Empty dependency array ensures this only runs once on mount
  }, []);

  // Effect for CMD+I keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Use CMD on Mac, CTRL on others
      if ((event.metaKey || event.ctrlKey) && event.key === 'i') {
        event.preventDefault(); // Prevent default browser action (e.g., italics)
        toggleSidePanel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    // Cleanup listener on component unmount
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [toggleSidePanel]); // Dependency: the toggle function

  // Preprocess messages to group tool call/result sequences and extract historical pairs
  const processedMessages = useMemo(() => {
    const grouped = groupMessages(messages);
    const historicalPairs: { assistantCall: ApiMessage, userResult: ApiMessage }[] = [];
    grouped.forEach(item => {
      if (isToolSequence(item)) {
        for (let i = 0; i < item.items.length; i += 2) {
          if (item.items[i+1]) {
            historicalPairs.push({ assistantCall: item.items[i], userResult: item.items[i+1] });
          }
        }
      }
    });
    // Update the state containing all historical pairs
    // Use a functional update if necessary to avoid stale state issues, though likely fine here
    setAllHistoricalPairs(historicalPairs);
    return grouped;
  }, [messages]);

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
    setToolCallData(null); // Clear old live tool call data
    setSidePanelContent(null); // Clear side panel when starting new stream
    setCurrentPairIndex(null); // Reset index when starting new stream
    
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
          
          let currentLiveToolCall: ToolCallData | null = null;
          
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

            // --- Handle Live Tool Call Updates for Side Panel ---
            if (jsonData?.type === 'tool_call' && jsonData.tool_call) {
              console.log('[PAGE] Received tool_call update:', jsonData.tool_call);
              currentLiveToolCall = {
                id: jsonData.tool_call.id,
                name: jsonData.tool_call.function.name,
                arguments: jsonData.tool_call.function.arguments,
                index: jsonData.tool_call.index,
              };
              setToolCallData(currentLiveToolCall); // Keep for stream content rendering
              setCurrentPairIndex(null); // Live data means not viewing a historical pair
              setSidePanelContent(currentLiveToolCall); // Update side panel
              if (!isSidePanelOpen) {
                // Optionally auto-open side panel? Maybe only if user hasn't closed it recently.
                // setIsSidePanelOpen(true);
              }
            } else if (jsonData?.type === 'tool_result') {
              // When tool result comes in, clear the live tool from side panel?
              // Or maybe wait until stream end?
              console.log('[PAGE] Received tool_result, clearing live tool from side panel');
              setSidePanelContent(null);
              setToolCallData(null);
              // Don't necessarily clear currentPairIndex here, user might want to navigate back
            }
            // --- End Side Panel Update Logic ---
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
        setToolCallData(null); // Clear tool call data on error
        setSidePanelContent(null); // Clear side panel on error
        setCurrentPairIndex(null);
      },
      onClose: async () => {
        console.log('[PAGE] Stream connection closed');
        
        // Immediately set UI state to idle
        setAgentStatus('idle');
        setIsStreaming(false);
        
        // Reset tool call data
        setToolCallData(null);
        setSidePanelContent(null); // Clear side panel on close
        setCurrentPairIndex(null);
        
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
            setToolCallData(null); // Also clear tool call data when stream closes normally
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
            
            // Set project name from project data
            if (projectData.name) {
              setProjectName(projectData.name);
            }
            
            // Load messages only if not already loaded
            if (!messagesLoadedRef.current) {
              const messagesData = await getMessages(threadId);
              if (isMounted) {
                // Log the parsed messages structure
                console.log('[PAGE] Loaded messages structure:', {
                  count: messagesData.length,
                  fullMessages: messagesData
                });
                
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

  // Click handler for historical tool previews
  const handleHistoricalToolClick = (pair: { assistantCall: ApiMessage, userResult: ApiMessage }) => {
    // Extract tool names for display in the side panel
    const userToolName = pair.userResult.content?.match(/<tool_result>\s*<([a-zA-Z\-_]+)/)?.[1] || 'Tool';

    // Extract only the XML part and the tool name from the assistant message
    const assistantContent = pair.assistantCall.content || '';
    // Find the first opening tag and the corresponding closing tag
    const xmlRegex = /<([a-zA-Z\-_]+)(?:\s+[^>]*)?>[\s\S]*?<\/\1>/;
    const xmlMatch = assistantContent.match(xmlRegex);
    const toolCallXml = xmlMatch ? xmlMatch[0] : '[Could not extract XML tag]';
    const assistantToolName = xmlMatch ? xmlMatch[1] : 'Tool'; // Extract name from the matched tag

    const userResultContent = pair.userResult.content?.match(/<tool_result>([\s\S]*)<\/tool_result>/)?.[1].trim() || '[Could not parse result]';

    setSidePanelContent({
      type: 'historical',
      assistantCall: { name: assistantToolName, content: toolCallXml },
      userResult: { name: userToolName, content: userResultContent }
    });
    // Find and set the index of the clicked pair
    const pairIndex = allHistoricalPairs.findIndex(p => 
      p.assistantCall.content === pair.assistantCall.content && 
      p.userResult.content === pair.userResult.content
      // Note: This comparison might be fragile if messages aren't unique.
      // A unique ID per message would be better.
    );
    setCurrentPairIndex(pairIndex !== -1 ? pairIndex : null);
    setIsSidePanelOpen(true);
  };

  // Handler for navigation within the side panel
  const handleSidePanelNavigate = (newIndex: number) => {
    if (newIndex >= 0 && newIndex < allHistoricalPairs.length) {
      const pair = allHistoricalPairs[newIndex];
      setCurrentPairIndex(newIndex);
      
      // Re-extract data for the side panel (similar to handleHistoricalToolClick)
      const assistantContent = pair.assistantCall.content || '';
      const xmlRegex = /<([a-zA-Z\-_]+)(?:\s+[^>]*)?>[\s\S]*?<\/\1>/;
      const xmlMatch = assistantContent.match(xmlRegex);
      const toolCallXml = xmlMatch ? xmlMatch[0] : '[Could not extract XML tag]';
      const assistantToolName = xmlMatch ? xmlMatch[1] : 'Tool';
      const userToolName = pair.userResult.content?.match(/<tool_result>\s*<([a-zA-Z\-_]+)/)?.[1] || 'Tool';
      const userResultContent = pair.userResult.content?.match(/<tool_result>([\s\S]*)<\/tool_result>/)?.[1].trim() || '[Could not parse result]';

      setSidePanelContent({
        type: 'historical',
        assistantCall: { name: assistantToolName, content: toolCallXml },
        userResult: { name: userToolName, content: userResultContent }
      });
    }
  };

  // Only show a full-screen loader on the very first load
  if (isLoading && !initialLoadCompleted.current) {
    return (
      <div className="flex h-screen">
        <div className="flex-1 flex flex-col overflow-hidden">
          <SiteHeader 
            threadId={threadId} 
            projectName={projectName}
            projectId={projectId}
            onViewFiles={() => setFileViewerOpen(true)} 
            onToggleSidePanel={toggleSidePanel}
          />
          <div className="flex flex-1 overflow-hidden">
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
        </div>
        <ToolCallSidePanel 
          isOpen={isSidePanelOpen} 
          onClose={() => { setIsSidePanelOpen(false); setSidePanelContent(null); setCurrentPairIndex(null); }}
          content={sidePanelContent}
          currentIndex={currentPairIndex}
          totalPairs={allHistoricalPairs.length}
          onNavigate={handleSidePanelNavigate}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen">
        <div className="flex-1 flex flex-col overflow-hidden">
          <SiteHeader 
            threadId={threadId} 
            projectName={projectName}
            projectId={projectId}
            onViewFiles={() => setFileViewerOpen(true)} 
            onToggleSidePanel={toggleSidePanel}
          />
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-lg border bg-card p-6 text-center">
              <h2 className="text-lg font-semibold text-destructive">Error</h2>
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" onClick={() => router.push(`/dashboard/projects/${projectId || ''}`)}>
                Back to Project
              </Button>
            </div>
          </div>
        </div>
        <ToolCallSidePanel 
          isOpen={isSidePanelOpen} 
          onClose={() => { setIsSidePanelOpen(false); setSidePanelContent(null); setCurrentPairIndex(null); }}
          content={sidePanelContent}
          currentIndex={currentPairIndex}
          totalPairs={allHistoricalPairs.length}
          onNavigate={handleSidePanelNavigate}
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <div className="flex-1 flex flex-col overflow-hidden">
        <SiteHeader 
          threadId={threadId} 
          projectName={projectName}
          projectId={projectId}
          onViewFiles={() => setFileViewerOpen(true)} 
          onToggleSidePanel={toggleSidePanel}
          onProjectRenamed={handleProjectRenamed}
        />
        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 flex flex-col relative overflow-hidden">
            <div 
              ref={messagesContainerRef}
              className="flex-1 overflow-y-auto px-6 py-4 pb-[0.5rem]"
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
                  <div className="space-y-6">
                    {/* Map over processed messages */}
                    {processedMessages.map((item, index) => {
                      // ---- Rendering Logic for Tool Sequences ----
                      if (isToolSequence(item)) {
                        // Group sequence items into pairs of [assistant, user]
                        const pairs: { assistantCall: ApiMessage, userResult: ApiMessage }[] = [];
                        for (let i = 0; i < item.items.length; i += 2) {
                          if (item.items[i+1]) {
                            pairs.push({ assistantCall: item.items[i], userResult: item.items[i+1] });
                          }
                        }

                        return (
                          <div
                            key={`seq-${index}`}
                            ref={index === processedMessages.length - 1 ? latestMessageRef : null}
                            className="relative group pl-10"
                          >
                            {/* Left border for the sequence */}
                            <div className="absolute left-3 top-0 bottom-0 w-0.5 bg-blue-500/50" aria-hidden="true"></div>

                            {/* Kortix Suna Label (Hover) */}
                            <span className="absolute left-0 top-1 -translate-x-full bg-blue-100 text-blue-700 text-xs font-semibold px-1.5 py-0.5 rounded z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                              Kortix Suna
                            </span>

                            {/* Render Avatar & Name ONCE for the sequence */}
                            <div className="absolute left-0 top-0 -translate-x-1/2 transform -translate-y-0 "> {/* Position avatar centered on the line */}
                              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center overflow-hidden border bg-background">
                                <Image src="/kortix-symbol.svg" alt="Suna Logo" width={20} height={20} className="object-contain" />
                              </div>
                            </div>
                            <div className="mb-1 ml-[-2.5rem]"> {/* Adjust margin to align name */}
                               <span className="text-xs font-semibold">Suna</span>
                            </div>

                            {/* Container for the pairs within the sequence */}
                            <div className="space-y-3">
                              {pairs.map((pair, pairIndex) => {
                                // Parse assistant message content
                                const assistantContent = pair.assistantCall.content || '';
                                const xmlRegex = /<([a-zA-Z\-_]+)(?:\s+[^>]*)?>[\s\S]*?<\/\1>/;
                                const xmlMatch = assistantContent.match(xmlRegex);
                                const toolName = xmlMatch ? xmlMatch[1] : 'Tool';
                                const preContent = xmlMatch ? assistantContent.substring(0, xmlMatch.index).trim() : assistantContent.trim();
                                const postContent = xmlMatch ? assistantContent.substring(xmlMatch.index + xmlMatch[0].length).trim() : '';
                                const userResultName = pair.userResult.content?.match(/<tool_result>\s*<([a-zA-Z\-_]+)/)?.[1] || 'Result';

                                return (
                                  <div key={`${index}-pair-${pairIndex}`} className="space-y-2">
                                    {/* Assistant Content (No Avatar/Name here) */}
                                    <div className="flex flex-col items-start space-y-2 flex-1">
                                      {/* Pre-XML Content */}
                                      {preContent && (
                                        <div className="w-full rounded-lg bg-muted p-3 text-sm">
                                          <div className="whitespace-pre-wrap break-words">
                                            {preContent}
                                          </div>
                                        </div>
                                      )}

                                      {/* Tool Call Button */}
                                      {xmlMatch && (
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="h-auto py-1.5 px-3 text-xs w-full sm:w-auto justify-start bg-background hover:bg-muted/50 border-muted-foreground/20 shadow-sm"
                                          onClick={() => handleHistoricalToolClick(pair)}
                                        >
                                          <Terminal className="h-3 w-3 mr-1.5 flex-shrink-0" />
                                          <span className="font-mono truncate mr-2">{toolName}</span>
                                          <span className="ml-auto text-muted-foreground/70 flex items-center">
                                            View Details <ExternalLink className="h-3 w-3 ml-1" />
                                          </span>
                                        </Button>
                                      )}

                                      {/* Post-XML Content (Less Common) */}
                                      {postContent && (
                                        <div className="w-full rounded-lg bg-muted p-3 text-sm">
                                          <div className="whitespace-pre-wrap break-words">
                                            {postContent}
                                          </div>
                                        </div>
                                      )}
                                    </div>

                                    {/* User Tool Result Part */}
                                    <div className="flex justify-start">
                                      <div className="flex items-center gap-2 rounded-md bg-green-100/60 border border-green-200/80 px-2.5 py-1 text-xs font-mono text-green-900 shadow-sm">
                                        <CheckCircle className="h-3.5 w-3.5 flex-shrink-0 text-green-600" />
                                        <span>{userResultName} Result Received</span>
                                        {/* Optional: Add a button to show result details here too? */}
                                        {/* <Button variant="ghost" size="xs" onClick={() => handleHistoricalToolClick(pair)}>(details)</Button> */}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      }
                      // ---- Rendering Logic for Regular Messages ----
                      else {
                        const message = item as ApiMessage; // Safe cast now due to type guard
                        // We rely on the existing rendering for *structured* tool calls/results (message.type === 'tool_call', message.role === 'tool')
                        // which are populated differently (likely via streaming updates) than the raw XML content.

                        return (
                          <div
                            key={index} // Use the index from processedMessages
                            ref={index === processedMessages.length - 1 && message.role !== 'user' ? latestMessageRef : null} // Ref on the regular message div if it's last (and not user)
                            className={`flex items-start gap-3 ${message.role === 'user' ? 'justify-end pl-12' : 'justify-start'}`}
                          >
                            {/* Avatar (User = Right, Assistant/Tool = Left) */}
                            {message.role === 'user' ? (
                              // User bubble comes first in flex-end
                              <>
                                <div className="flex-1 space-y-1 flex justify-end">
                                  {/* User message bubble */}
                                  <div className="max-w-[85%] rounded-lg bg-primary text-primary-foreground p-3 text-sm shadow-sm">
                                    <div className="whitespace-pre-wrap break-words">
                                      {message.content}
                                    </div>
                                  </div>
                                </div>
                              </>
                            ) : (
                              // Assistant / Tool bubble on the left
                              <>
                                {/* Assistant Avatar */}
                                <div className="flex-shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center overflow-hidden border">
                                  <Image src="/kortix-symbol.svg" alt="Suna Logo" width={20} height={20} className="object-contain" />
                                </div>
                                {/* Content Bubble */}
                                <div className="flex-1 space-y-1">
                                  <span className="text-xs font-semibold">Suna</span>
                                  <div className={`max-w-[85%] rounded-lg p-3 text-sm shadow-sm ${message.role === 'tool' ? 'bg-purple-100/60 border border-purple-200/80' : 'bg-muted'}`}>
                                    <div className="whitespace-pre-wrap break-words">
                                      {/* Use existing logic for structured tool calls/results and normal messages */}
                                      {message.type === 'tool_call' && message.tool_call ? (
                                        // Existing rendering for structured tool_call type
                                        <div className="font-mono text-xs space-y-1.5">
                                          <div className="flex items-center gap-1.5 text-muted-foreground">
                                            <CircleDashed className="h-3.5 w-3.5 animate-spin animation-duration-2000" />
                                            <span>Tool Call: {message.tool_call.function.name}</span>
                                          </div>
                                          <div className="mt-1 p-2 bg-background/50 rounded-md overflow-x-auto border">
                                            {message.tool_call.function.arguments}
                                          </div>
                                        </div>
                                      ) : message.role === 'tool' ? (
                                        // Existing rendering for standard 'tool' role messages
                                        <div className="font-mono text-xs space-y-1.5">
                                          <div className="flex items-center gap-1.5 text-purple-800">
                                            <CheckCircle className="h-3.5 w-3.5 text-purple-600" />
                                            <span>Tool Result: {message.name || 'Unknown Tool'}</span>
                                          </div>
                                          <div className="mt-1 p-2 bg-background/50 rounded-md overflow-x-auto border">
                                            {/* Render content safely, handle potential objects */}
                                            {typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}
                                          </div>
                                        </div>
                                      ) : (
                                        // Default rendering for plain assistant messages
                                        message.content
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      }
                    })}
                    {/* ---- End of Message Mapping ---- */}
                    
                    {streamContent && (
                      <div 
                        ref={latestMessageRef}
                        className="flex items-start gap-3 justify-start" // Assistant streaming style
                      >
                        {/* Assistant Avatar */}
                        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center overflow-hidden border">
                          <Image src="/kortix-symbol.svg" alt="Suna Logo" width={20} height={20} className="object-contain" />
                        </div>
                        {/* Content Bubble */}
                        <div className="flex-1 space-y-1">
                          <span className="text-xs font-semibold">Suna</span>
                          <div className="max-w-[85%] rounded-lg bg-muted p-3 text-sm shadow-sm">
                            <div className="whitespace-pre-wrap break-words">
                              {toolCallData ? (
                                // Streaming Tool Call
                                <div className="font-mono text-xs space-y-1.5">
                                  <div className="flex items-center gap-1.5 text-muted-foreground">
                                    <CircleDashed className="h-3.5 w-3.5 animate-spin animation-duration-2000" />
                                    <span>Tool Call: {toolCallData.name}</span>
                                  </div>
                                  <div className="mt-1 p-2 bg-background/50 rounded-md overflow-x-auto border">
                                    {toolCallData.arguments || ''}
                                  </div>
                                </div>
                              ) : (
                                // Streaming Text Content
                                streamContent
                              )}
                              {/* Blinking Cursor */}
                              {isStreaming && (
                                <span className="inline-block h-4 w-0.5 bg-foreground/50 ml-0.5 -mb-1 animate-pulse" />
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                    
                    {/* Loading indicator (three dots) */}
                    {agentStatus === 'running' && !streamContent && !toolCallData && (
                      <div className="flex items-start gap-3 justify-start"> {/* Assistant style */}
                        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center overflow-hidden border">
                          <Image src="/kortix-symbol.svg" alt="Suna Logo" width={20} height={20} className="object-contain" />
                        </div>
                        <div className="flex-1 space-y-1">
                          <span className="text-xs font-semibold">Suna</span>
                          <div className="max-w-[85%] rounded-lg bg-muted px-4 py-3 text-sm shadow-sm">
                            <div className="flex items-center gap-1.5">
                              <div className="h-1.5 w-1.5 rounded-full bg-foreground/50 animate-pulse" />
                              <div className="h-1.5 w-1.5 rounded-full bg-foreground/50 animate-pulse delay-150" />
                              <div className="h-1.5 w-1.5 rounded-full bg-foreground/50 animate-pulse delay-300" />
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
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

            <div className="bg-sidebar backdrop-blur-sm">
              <div className="mx-auto max-w-3xl px-6 py-2">
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
              </div>
            </div>
          </div>
        </div>
      </div>

      <ToolCallSidePanel 
        isOpen={isSidePanelOpen} 
        onClose={() => { setIsSidePanelOpen(false); setSidePanelContent(null); setCurrentPairIndex(null); }}
        content={sidePanelContent}
        currentIndex={currentPairIndex}
        totalPairs={allHistoricalPairs.length}
        onNavigate={handleSidePanelNavigate}
      />

      {sandboxId && (
        <FileViewerModal
          open={fileViewerOpen}
          onOpenChange={setFileViewerOpen}
          sandboxId={sandboxId}
        />
      )}
    </div>
  );
} 