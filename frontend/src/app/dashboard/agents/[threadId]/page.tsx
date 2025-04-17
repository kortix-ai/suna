'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  ArrowDown, FileText, Terminal, ExternalLink, User, CheckCircle, CircleDashed,
  FileEdit, Search, Globe, Code, MessageSquare, Folder, FileX, CloudUpload, Wrench, Cog
} from 'lucide-react';
import type { ElementType } from 'react';
import { addUserMessage, getMessages, startAgent, stopAgent, getAgentStatus, streamAgent, getAgentRuns, getProject, getThread, updateProject, Project } from '@/lib/api';
import { toast } from 'sonner';
import { Skeleton } from "@/components/ui/skeleton";
import { ChatInput } from '@/components/thread/chat-input';
import { FileViewerModal } from '@/components/thread/file-viewer-modal';
import { SiteHeader } from "@/components/thread/thread-site-header"
import { ToolCallSidePanel, SidePanelContent, ToolCallData } from "@/components/thread/tool-call-side-panel";
import { useSidebar } from "@/components/ui/sidebar";
import { TodoPanel } from '@/components/thread/todo-panel';

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

// Helper function to get an icon based on tool name
const getToolIcon = (toolName: string): ElementType => {
  // Ensure we handle null/undefined toolName gracefully
  if (!toolName) return Cog;
  
  // Convert to lowercase for case-insensitive matching
  const normalizedName = toolName.toLowerCase();
  
  switch (normalizedName) {
    case 'create-file':
    case 'str-replace':
    case 'write-file':
      return FileEdit;
    case 'run_terminal_cmd':
    case 'run_command':
      return Terminal;
    case 'web_search':
      return Search;
    case 'browse_url':
      return Globe;
    case 'call_api':
      return Code;
    case 'send_message':
      return MessageSquare;
    case 'list_dir':
      return Folder;
    case 'read_file':
      return FileText;
    case 'delete_file':
      return FileX;
    case 'deploy':
      return CloudUpload;
    default:
      // Add logging for debugging unhandled tool types
      console.log(`[PAGE] Using default icon for unknown tool type: ${toolName}`);
      return Cog; // Default icon
  }
};

// Helper function to extract a primary parameter from XML/arguments
const extractPrimaryParam = (toolName: string, content: string | undefined): string | null => {
  if (!content) return null;

  try {
    // Simple regex for common parameters - adjust as needed
    let match: RegExpMatchArray | null = null;
    switch (toolName?.toLowerCase()) {
      case 'edit_file':
      case 'read_file':
      case 'delete_file':
      case 'write_file':
        match = content.match(/target_file=(?:"|')([^"|']+)(?:"|')/);
        // Return just the filename part
        return match ? match[1].split('/').pop() || match[1] : null;
      case 'run_terminal_cmd':
      case 'run_command':
        match = content.match(/command=(?:"|')([^"|']+)(?:"|')/);
        // Truncate long commands
        return match ? (match[1].length > 30 ? match[1].substring(0, 27) + '...' : match[1]) : null;
      case 'web_search':
        match = content.match(/query=(?:"|')([^"|']+)(?:"|')/);
        return match ? (match[1].length > 30 ? match[1].substring(0, 27) + '...' : match[1]) : null;
      case 'browse_url':
        match = content.match(/url=(?:"|')([^"|']+)(?:"|')/);
        return match ? match[1] : null;
      // Add more cases as needed for other tools
      default:
        return null;
    }
  } catch (e) {
    console.warn("Error parsing tool parameters:", e);
    return null;
  }
};

// Flag to control whether tool result messages are rendered
const SHOULD_RENDER_TOOL_RESULTS = false;

// Function to group consecutive assistant tool call / user tool result pairs
function groupMessages(messages: ApiMessage[]): RenderItem[] {
  const grouped: RenderItem[] = [];
  let i = 0;

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
                            className="relative group pt-4 pb-2 border-t border-gray-100"
                          >
                            {/* Simplified header with logo and name */}
                            <div className="flex items-center mb-2 text-sm gap-2">
                              <div className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center overflow-hidden">
                                <Image src="/kortix-symbol.svg" alt="Suna" width={16} height={16} className="object-contain" />
                              </div>
                              <span className="text-gray-700 font-medium">Suna</span>
                            </div>

                            {/* Container for the pairs within the sequence */}
                            <div className="space-y-4">
                              {pairs.map((pair, pairIndex) => {
                                // Parse assistant message content
                                const assistantContent = pair.assistantCall.content || '';
                                const xmlRegex = /<([a-zA-Z\-_]+)(?:\s+[^>]*)?>[\s\S]*?<\/\1>/;
                                const xmlMatch = assistantContent.match(xmlRegex);
                                const toolName = xmlMatch ? xmlMatch[1] : 'Tool';
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
                            className={`${message.role === 'user' ? 'text-right py-1' : 'py-2'} ${index > 0 ? 'border-t border-gray-100' : ''}`} // Add top border between messages
                          >
                            {/* Avatar (User = Right, Assistant/Tool = Left) */}
                            {message.role === 'user' ? (
                              // User bubble comes first in flex-end
                              <div className="max-w-[85%] ml-auto text-sm text-gray-800 whitespace-pre-wrap break-words">
                                {message.content}
                              </div>
                            ) : (
                              // Assistant / Tool bubble on the left
                              <div>
                                {/* Simplified header with logo and name */}
                                <div className="flex items-center mb-2 text-sm gap-2">
                                  <div className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center overflow-hidden">
                                    <Image src="/kortix-symbol.svg" alt="Suna" width={16} height={16} className="object-contain" />
                                  </div>
                                  <span className="text-gray-700 font-medium">Suna</span>
                                </div>

                                {/* Message content */}
                                {message.type === 'tool_call' && message.tool_call ? (
                                  // Clickable Tool Tag (Live)
                                  <div className="space-y-2">
                                    {(() => { // IIFE for scope
                                      const toolName = message.tool_call.function.name;
                                      const IconComponent = getToolIcon(toolName);
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
                                          <IconComponent className="h-3.5 w-3.5 text-gray-500 flex-shrink-0 animate-spin animation-duration-2000" />
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
                                    {message.content}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      }
                    })}
                    {/* ---- End of Message Mapping ---- */}
                    
                    {streamContent && (
                      <div 
                        ref={latestMessageRef} 
                        className="py-2 border-t border-gray-100" // Assistant streaming style
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
                            // Simple text streaming
                            <div className="text-sm text-gray-800 whitespace-pre-wrap break-words max-w-[85%]">
                              {streamContent}
                              {isStreaming && (
                                <span className="inline-block h-4 w-0.5 bg-gray-400 ml-0.5 -mb-1 animate-pulse" />
                              )}
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
                {/* Show Todo panel above chat input when side panel is closed */}
                {!isSidePanelOpen && sandboxId && (
                  <TodoPanel
                    sandboxId={sandboxId}
                    isSidePanelOpen={isSidePanelOpen}
                    className="mb-3"
                  />
                )}
                
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