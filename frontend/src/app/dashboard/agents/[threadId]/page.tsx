'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  ArrowDown, CheckCircle, CircleDashed,
} from 'lucide-react';
import { addUserMessage, getMessages, startAgent, stopAgent, getAgentStatus, streamAgent, getAgentRuns, getProject, getThread, updateProject, Project } from '@/lib/api';
import { toast } from 'sonner';
import { Skeleton } from "@/components/ui/skeleton";
import { ChatInput } from '@/components/thread/chat-input';
import { FileViewerModal } from '@/components/thread/file-viewer-modal';
import { SiteHeader } from "@/components/thread/thread-site-header"
import { ToolCallSidePanel, SidePanelContent, ToolCallData } from "@/components/thread/tool-call-side-panel";
import { useSidebar } from "@/components/ui/sidebar";

import { ApiMessage, ThreadParams, isToolSequence } from '@/components/thread/types';
import { getToolIcon, extractPrimaryParam, groupMessages, SHOULD_RENDER_TOOL_RESULTS } from '@/components/thread/utils';

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
  const [project, setProject] = useState<Project | null>(null);
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
            finish_reason?: string;
            function_name?: string;
            xml_tag_name?: string;
          } | null = null;
          
          // Handle data: prefix format (SSE standard)
          if (processedData.startsWith('data: ')) {
            processedData = processedData.substring(6).trim();
          }
          
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
            
            // Handle finish message
            if (jsonData?.type === 'finish') {
              console.log(`[PAGE] Received finish message with reason: ${jsonData.finish_reason}`);
              // If there's a specific finish reason, handle it
              if (jsonData.finish_reason === 'xml_tool_limit_reached') {
                // Potentially show a toast notification
                // toast.info('Tool execution limit reached. The agent will continue with available information.');
              }
              return;
            }

            // Handle content type messages (text from the agent)
            if (jsonData?.type === 'content' && jsonData?.content) {
              console.log('[PAGE] Adding content to stream:', jsonData.content);
              setStreamContent(prev => prev + jsonData.content);
              return;
            }
            
            // Handle tool status messages
            if (jsonData?.type === 'tool_status') {
              console.log(`[PAGE] Tool status: ${jsonData.status} for ${jsonData.function_name}`);
              
              // Update UI based on tool status
              if (jsonData.status === 'started') {
                // Could show a loading indicator for the specific tool
                const toolInfo = {
                  id: jsonData.xml_tag_name || `tool-${Date.now()}`,
                  name: jsonData.function_name || 'unknown',
                  arguments: '{}',
                  index: 0,
                };
                
                setToolCallData(toolInfo);
              } else if (jsonData.status === 'completed') {
                // Update UI to show tool completion
                setToolCallData(null);
              }
              return;
            }
            
            // Handle tool result messages
            if (jsonData?.type === 'tool_result') {
              console.log('[PAGE] Received tool result for:', jsonData.function_name);
              
              // Clear the tool data since execution is complete
              setSidePanelContent(null);
              setToolCallData(null);
              
              return;
            }

            // If we reach here and have JSON data but it's not a recognized type,
            // log it for debugging purposes
            console.log('[PAGE] Unhandled message type:', jsonData?.type);
            
          } catch (e) {
            // If JSON parsing fails, treat it as raw text content
            console.warn('[PAGE] Failed to parse as JSON, treating as raw content:', e);
            setStreamContent(prev => prev + processedData);
          }
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
            // Store the full project object
            setProject(projectData);
            
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

  const handleSubmitMessage = useCallback(async (message: string) => {
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
  }, [threadId, handleStreamAgent]);

  const handleStopAgent = useCallback(async () => {
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
  }, [agentRunId, threadId]);

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
  const handleOpenFileViewer = useCallback(() => {
    setFileViewerOpen(true);
  }, []);

  // Click handler for historical tool previews
  const handleHistoricalToolClick = (pair: { assistantCall: ApiMessage, userResult: ApiMessage }) => {
    // Extract tool names for display in the side panel
    const userToolName = pair.userResult.content?.match(/<tool_result>\s*<([a-zA-Z\-_]+)/)?.[1] || 'Tool';

    // Extract only the XML part and the tool name from the assistant message
    const assistantContent = pair.assistantCall.content || '';
    // First try to match complete tags, then try self-closing tags
    const xmlRegex = /<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?>[\s\S]*?<\/\1>|<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?(?:\/)?>/;
    const xmlMatch = assistantContent.match(xmlRegex);
    const toolCallXml = xmlMatch ? xmlMatch[0] : '[Could not extract XML tag]';
    // Get tag name from either the first capturing group (full tag) or second capturing group (self-closing)
    const assistantToolName = xmlMatch ? (xmlMatch[1] || xmlMatch[2]) : 'Tool';

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
      const xmlRegex = /<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?>[\s\S]*?<\/\1>|<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?(?:\/)?>/;
      const xmlMatch = assistantContent.match(xmlRegex);
      const toolCallXml = xmlMatch ? xmlMatch[0] : '[Could not extract XML tag]';
      const assistantToolName = xmlMatch ? (xmlMatch[1] || xmlMatch[2]) : 'Tool';
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
          project={project}
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
          project={project}
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
                      // Check if this message is an assistant message that follows a user message
                      const prevMessage = index > 0 ? processedMessages[index - 1] : null;
                      const isAssistantAfterUser = 
                        (isToolSequence(item) || ((item as ApiMessage).role === 'assistant')) && 
                        (prevMessage && !isToolSequence(prevMessage) && (prevMessage as ApiMessage).role === 'user');
                      
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
                            className="relative group pt-4 pb-2"
                          >
                            {/* Show header only if this is an assistant message after a user message */}
                            {isAssistantAfterUser && (
                              <div className="flex items-center mb-2 text-sm gap-2">
                                <div className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center overflow-hidden">
                                  <Image src="/kortix-symbol.svg" alt="Suna" width={16} height={16} className="object-contain" />
                                </div>
                                <span className="text-gray-700 font-medium">Suna</span>
                              </div>
                            )}

                            {/* Container for the pairs within the sequence */}
                            <div className="space-y-4">
                              {pairs.map((pair, pairIndex) => {
                                // Parse assistant message content
                                const assistantContent = pair.assistantCall.content || '';
                                const xmlRegex = /<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?>[\s\S]*?<\/\1>|<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?(?:\/)?>/;
                                const xmlMatch = assistantContent.match(xmlRegex);
                                // Get tag name from either the first or second capturing group
                                const toolName = xmlMatch ? (xmlMatch[1] || xmlMatch[2]) : 'Tool';
                                const preContent = xmlMatch ? assistantContent.substring(0, xmlMatch.index).trim() : assistantContent.trim();
                                const postContent = xmlMatch ? assistantContent.substring(xmlMatch.index + xmlMatch[0].length).trim() : '';
                                const userResultName = pair.userResult.content?.match(/<tool_result>\s*<([a-zA-Z\-_]+)/)?.[1] || 'Result';

                                // Get icon and parameter for the tag
                                const IconComponent = getToolIcon(toolName);
                                const paramDisplay = extractPrimaryParam(toolName, assistantContent);

                                return (
                                  <div key={`${index}-pair-${pairIndex}`} className="space-y-2">
                                    {/* Tool execution content */}
                                    <div className="space-y-1">
                                      {/* First show any text content before the tool call */}
                                      {preContent && (
                                        <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">
                                          {preContent}
                                        </p>
                                      )}
                                      
                                      {/* Clickable Tool Tag */}
                                      {xmlMatch && (
                                        <button
                                          onClick={() => handleHistoricalToolClick(pair)}
                                          className="inline-flex items-center gap-1.5 py-0.5 px-2 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors cursor-pointer border border-gray-200"
                                        >
                                          <IconComponent className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
                                          <span className="font-mono text-xs text-gray-700">
                                            {toolName}
                                          </span>
                                          {paramDisplay && (
                                            <span className="ml-1 text-gray-500 truncate" title={paramDisplay}>
                                              {paramDisplay}
                                            </span>
                                          )}
                                        </button>
                                      )}

                                      {/* Post-XML Content (Less Common) */}
                                      {postContent && (
                                        <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">
                                          {postContent}
                                        </p>
                                      )}
                                    </div>

                                    {/* Simple tool result indicator */}
                                    {SHOULD_RENDER_TOOL_RESULTS && userResultName && (
                                      <div className="ml-4 flex items-center gap-1.5 text-xs text-gray-500">
                                        <CheckCircle className="h-3 w-3 text-green-600" />
                                        <span className="font-mono">{userResultName} completed</span>
                                      </div>
                                    )}

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
                            className={`${message.role === 'user' ? 'text-right py-1' : 'py-2'}`} // Removed border-t
                          >
                            {/* Avatar (User = Right, Assistant/Tool = Left) */}
                            {message.role === 'user' ? (
                              // User bubble with rounded background that fits to text
                              <div className="inline-block ml-auto text-sm text-gray-800 whitespace-pre-wrap break-words bg-gray-100 rounded-lg py-2 px-3">
                                {message.content}
                              </div>
                            ) : (
                              // Assistant / Tool bubble on the left
                              <div>
                                {/* Show header only if this is an assistant message after a user message */}
                                {isAssistantAfterUser && (
                                  <div className="flex items-center mb-2 text-sm gap-2">
                                    <div className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center overflow-hidden">
                                      <Image src="/kortix-symbol.svg" alt="Suna" width={16} height={16} className="object-contain" />
                                    </div>
                                    <span className="text-gray-700 font-medium">Suna</span>
                                  </div>
                                )}

                                {/* Message content */}
                                {message.type === 'tool_call' && message.tool_call ? (
                                  // Clickable Tool Tag (Live)
                                  <div className="space-y-2">
                                    {(() => { // IIFE for scope
                                      const toolName = message.tool_call.function.name;
                                      const paramDisplay = extractPrimaryParam(toolName, message.tool_call.function.arguments);
                                      return (
                                        <button
                                          className="inline-flex items-center gap-1.5 py-0.5 px-2 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors cursor-pointer border border-gray-200"
                                          onClick={() => {
                                            if (message.tool_call) {
                                              setSidePanelContent({
                                                id: message.tool_call.id,
                                                name: message.tool_call.function.name,
                                                arguments: message.tool_call.function.arguments,
                                                index: message.tool_call.index
                                              });
                                              setIsSidePanelOpen(true);
                                            }
                                          }}
                                        >
                                          <CircleDashed className="h-3.5 w-3.5 text-gray-500 flex-shrink-0 animate-spin animation-duration-2000" />
                                          <span className="font-mono text-xs text-gray-700">
                                            {toolName}
                                          </span>
                                          {paramDisplay && (
                                            <span className="ml-1 text-gray-500 truncate" title={paramDisplay}>
                                              {paramDisplay}
                                            </span>
                                          )}
                                        </button>
                                      );
                                    })()}
                                    <pre className="text-xs font-mono overflow-x-auto my-1 p-2 bg-gray-50 border border-gray-100 rounded-sm">
                                      {message.tool_call.function.arguments}
                                    </pre>
                                  </div>
                                ) : (message.role === 'tool' && SHOULD_RENDER_TOOL_RESULTS) ? (
                                  // Clean tool result UI
                                  <div className="space-y-2">
                                    <div className="flex items-center justify-between py-1 group">
                                      <div className="flex items-center gap-2">
                                        <CheckCircle className="h-4 w-4 text-gray-400" />
                                        <span className="font-mono text-sm text-gray-700">
                                          {message.name || 'Unknown Tool'}
                                        </span>
                                      </div>
                                    </div>
                                    <pre className="text-xs font-mono overflow-x-auto my-1 p-2 bg-gray-50 border border-gray-100 rounded-sm">
                                      {typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2)}
                                    </pre>
                                  </div>
                                ) : (
                                  // Plain text message
                                  <div className="max-w-[85%] text-sm text-gray-800 whitespace-pre-wrap break-words">
                                    {(() => {
                                      // Parse XML from assistant messages
                                      if (message.role === 'assistant') {
                                        const assistantContent = message.content || '';
                                        const xmlRegex = /<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?>[\s\S]*?<\/\1>|<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?(?:\/)?>/;
                                        const xmlMatch = assistantContent.match(xmlRegex);
                                        
                                        if (xmlMatch) {
                                          // Get tag name from either the first capturing group (full tag) or second capturing group (self-closing)
                                          const toolName = xmlMatch[1] || xmlMatch[2];
                                          const preContent = assistantContent.substring(0, xmlMatch.index).trim();
                                          const postContent = assistantContent.substring(xmlMatch.index + xmlMatch[0].length).trim();
                                          const IconComponent = getToolIcon(toolName);
                                          const paramDisplay = extractPrimaryParam(toolName, assistantContent);
                                          
                                          return (
                                            <>
                                              {preContent && <p className="mb-2">{preContent}</p>}
                                              
                                              <button
                                                onClick={() => {
                                                  // Create a synthetic pair to match the history format
                                                  const syntheticPair = {
                                                    assistantCall: message,
                                                    userResult: { content: "", role: "user" } // Empty result
                                                  };
                                                  handleHistoricalToolClick(syntheticPair);
                                                }}
                                                className="inline-flex items-center gap-1.5 py-0.5 px-2 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors cursor-pointer border border-gray-200 mb-2"
                                              >
                                                <IconComponent className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
                                                <span className="font-mono text-xs text-gray-700">
                                                  {toolName}
                                                </span>
                                                {paramDisplay && (
                                                  <span className="ml-1 text-gray-500 truncate" title={paramDisplay}>
                                                    {paramDisplay}
                                                  </span>
                                                )}
                                              </button>
                                              
                                              {postContent && <p>{postContent}</p>}
                                            </>
                                          );
                                        }
                                      }
                                      
                                      // Default rendering for non-XML or non-assistant messages
                                      return message.content;
                                    })()}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      }

                    })}
                    {/* ---- End of Message Mapping ---- */}
                    
                    {/* ---- Rendering Logic for Streaming ---- */}
                    {streamContent && (
                      <div
                        ref={latestMessageRef}
                        className="py-2 border-t border-gray-100"
                      >
                        {/* Simplified header with logo and name */}
                        <div className="flex items-center mb-2 text-sm gap-2">
                          <div className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center overflow-hidden">
                            <Image src="/kortix-symbol.svg" alt="Suna" width={16} height={16} className="object-contain" />
                          </div>
                          <span className="text-gray-700 font-medium">Suna</span>
                        </div>
                        
                        <div className="space-y-2">
                          {toolCallData ? (
                            // Clickable Tool Tag (Streaming)
                            <div className="space-y-2">
                              {(() => { // IIFE for scope
                                const toolName = toolCallData.name;
                                const IconComponent = getToolIcon(toolName);
                                const paramDisplay = extractPrimaryParam(toolName, toolCallData.arguments);
                                return (
                                  <button
                                    className="inline-flex items-center gap-1.5 py-0.5 px-2 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors cursor-pointer border border-gray-200"
                                    onClick={() => {
                                      if (toolCallData) {
                                        setSidePanelContent(toolCallData);
                                        setIsSidePanelOpen(true);
                                      }
                                    }}
                                  >
                                    <CircleDashed className="h-3.5 w-3.5 text-gray-500 flex-shrink-0 animate-spin animation-duration-2000" />
                                    <span className="font-mono text-xs text-gray-700">
                                      {toolName}
                                    </span>
                                    {paramDisplay && (
                                      <span className="ml-1 text-gray-500 truncate" title={paramDisplay}>
                                        {paramDisplay}
                                      </span>
                                    )}
                                  </button>
                                );
                              })()}
                              <pre className="text-xs font-mono overflow-x-auto my-1 p-2 bg-gray-50 border border-gray-100 rounded-sm">
                                {toolCallData.arguments || ''}
                              </pre>
                            </div>
                          ) : (
                            // Enhanced text streaming with XML parsing
                            <div className="text-sm text-gray-800 whitespace-pre-wrap break-words max-w-[85%]">
                              {(() => {
                                const content = streamContent;
                                
                                // Tokenize the content to properly render XML and text
                                const renderStreamContent = () => {
                                  // RegExp for matching both opening and closing tags
                                  const tagRegex = /<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?(?:\/)?>/g;
                                  const closingTagRegex = /<\/([a-zA-Z\-_]+)>/g;
                                  
                                  // Build a map of tag states
                                  const openTags: Record<string, { count: number, positions: number[] }> = {};
                                  
                                  // Track all opening tags
                                  let match;
                                  while ((match = tagRegex.exec(content)) !== null) {
                                    const tagName = match[1];
                                    if (!openTags[tagName]) {
                                      openTags[tagName] = { count: 0, positions: [] };
                                    }
                                    openTags[tagName].count++;
                                    openTags[tagName].positions.push(match.index);
                                  }
                                  
                                  // Subtract all closing tags
                                  while ((match = closingTagRegex.exec(content)) !== null) {
                                    const tagName = match[1];
                                    if (openTags[tagName]) {
                                      openTags[tagName].count--;
                                    }
                                  }
                                  
                                  // Find incomplete tags (those with count > 0)
                                  const incompleteTags = Object.entries(openTags)
                                    .filter(([_, data]) => data.count > 0)
                                    .map(([tag, data]) => ({ 
                                      tag, 
                                      // Use the last position for this incomplete tag
                                      position: data.positions[data.positions.length - data.count] 
                                    }))
                                    .sort((a, b) => a.position - b.position);
                                  
                                  // If there are no incomplete tags, render normally
                                  if (incompleteTags.length === 0) {
                                    return (
                                      <div>
                                        {parseNormalXmlContent(content)}
                                        {isStreaming && (
                                          <span className="inline-block h-4 w-0.5 bg-gray-400 ml-0.5 -mb-1 animate-pulse" />
                                        )}
                                      </div>
                                    );
                                  }
                                  
                                  // Handle incomplete tags
                                  const segments = [];
                                  let lastPosition = 0;
                                  
                                  // Process each incomplete tag in sequence
                                  for (const { tag, position } of incompleteTags) {
                                    // Add content before this incomplete tag
                                    if (position > lastPosition) {
                                      const segmentContent = content.substring(lastPosition, position);
                                      segments.push(
                                        <div key={`seg-${lastPosition}`}>
                                          {parseNormalXmlContent(segmentContent)}
                                        </div>
                                      );
                                    }
                                    
                                    // Find the opening tag and extract attributes for param display
                                    const openingTagMatch = new RegExp(`<${tag}([^>]*)>`, 'g');
                                    openingTagMatch.lastIndex = position;
                                    const tagMatch = openingTagMatch.exec(content);
                                    const tagAttributes = tagMatch ? tagMatch[1] : '';
                                    
                                    // Add the incomplete tag button
                                    const IconComponent = getToolIcon(tag);
                                    const paramDisplay = extractPrimaryParam(tag, tagAttributes);
                                    
                                    segments.push(
                                      <div key={`tag-${position}`} className="space-y-2 my-2">
                                        <button
                                          className="inline-flex items-center gap-1.5 py-0.5 px-2 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors cursor-pointer border border-gray-200"
                                        >
                                          <CircleDashed className="h-3.5 w-3.5 text-gray-500 flex-shrink-0 animate-spin animation-duration-2000" />
                                          <span className="font-mono text-xs text-gray-700">
                                            {tag}
                                          </span>
                                          {paramDisplay && (
                                            <span className="ml-1 text-gray-500 truncate" title={paramDisplay}>
                                              {paramDisplay}
                                            </span>
                                          )}
                                        </button>
                                        <div className="my-1 flex items-center">
                                          <span className="inline-block h-4 w-4 text-gray-400">
                                            <CircleDashed className="h-4 w-4 animate-spin" />
                                          </span>
                                          <span className="ml-2 text-xs text-gray-500">Processing...</span>
                                        </div>
                                      </div>
                                    );
                                    
                                    // Move past this tag's position
                                    lastPosition = position + (tagMatch ? tagMatch[0].length : 0);
                                  }
                                  
                                  // Add any remaining content after the last incomplete tag
                                  if (lastPosition < content.length) {
                                    const remainingContent = content.substring(lastPosition);
                                    segments.push(
                                      <div key={`remaining-${lastPosition}`}>
                                        {parseNormalXmlContent(remainingContent)}
                                        {isStreaming && (
                                          <span className="inline-block h-4 w-0.5 bg-gray-400 ml-0.5 -mb-1 animate-pulse" />
                                        )}
                                      </div>
                                    );
                                  }
                                  
                                  return <>{segments}</>;
                                };
                                
                                // Helper to parse normal XML content (fully formed tags)
                                const parseNormalXmlContent = (text: string) => {
                                  if (!text) return null;
                                  
                                  // Find all complete XML tags
                                  const segments = [];
                                  let lastIndex = 0;
                                  
                                  // Regex for complete XML tags
                                  const completeXmlRegex = /<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?>[\s\S]*?<\/\1>|<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?\/>/g;
                                  let xmlMatch;
                                  
                                  while ((xmlMatch = completeXmlRegex.exec(text)) !== null) {
                                    // Add text before this XML
                                    if (xmlMatch.index > lastIndex) {
                                      segments.push(
                                        <span key={`text-${lastIndex}`}>
                                          {text.substring(lastIndex, xmlMatch.index)}
                                        </span>
                                      );
                                    }
                                    
                                    // Add the complete XML tag as a button
                                    const tagName = xmlMatch[1] || xmlMatch[2];
                                    const IconComponent = getToolIcon(tagName);
                                    const paramDisplay = extractPrimaryParam(tagName, xmlMatch[0]);
                                    
                                    segments.push(
                                      <button
                                        key={`xml-${xmlMatch.index}`}
                                        className="inline-flex items-center gap-1.5 py-0.5 px-2 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors cursor-pointer border border-gray-200 my-1"
                                      >
                                        <IconComponent className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
                                        <span className="font-mono text-xs text-gray-700">
                                          {tagName}
                                        </span>
                                        {paramDisplay && (
                                          <span className="ml-1 text-gray-500 truncate" title={paramDisplay}>
                                            {paramDisplay}
                                          </span>
                                        )}
                                      </button>
                                    );
                                    
                                    lastIndex = xmlMatch.index + xmlMatch[0].length;
                                  }
                                  
                                  // Add any remaining text
                                  if (lastIndex < text.length) {
                                    segments.push(
                                      <span key={`text-${lastIndex}`}>
                                        {text.substring(lastIndex)}
                                      </span>
                                    );
                                  }
                                  
                                  return segments.length > 0 ? segments : text;
                                };
                                
                                return renderStreamContent();
                              })()}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    
                    {/* Loading indicator (three dots) */}
                    {agentStatus === 'running' && !streamContent && !toolCallData && (
                      <div className="py-2 border-t border-gray-100">
                        {/* Simplified header with logo and name */}
                        <div className="flex items-center mb-2 text-sm gap-2">
                          <div className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center overflow-hidden">
                            <Image src="/kortix-symbol.svg" alt="Suna" width={16} height={16} className="object-contain" />
                          </div>
                          <span className="text-gray-700 font-medium">Suna</span>
                        </div>
                        
                        <div className="flex items-center gap-1.5 py-1">
                          <div className="h-1.5 w-1.5 rounded-full bg-gray-400/50 animate-pulse" />
                          <div className="h-1.5 w-1.5 rounded-full bg-gray-400/50 animate-pulse delay-150" />
                          <div className="h-1.5 w-1.5 rounded-full bg-gray-400/50 animate-pulse delay-300" />
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {/* Empty div for scrolling - MOVED HERE */}
                <div ref={messagesEndRef} />
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

            <div>
              <div className="mx-auto max-w-3xl px-6 py-2">
                {/* Show Todo panel above chat input when side panel is closed */}
                {/* {!isSidePanelOpen && sandboxId && (
                  <TodoPanel
                    sandboxId={sandboxId}
                    isSidePanelOpen={isSidePanelOpen}
                    className="mb-3"
                  />
                )} */}
                
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
        project={project}
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