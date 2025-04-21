'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  ArrowDown, CheckCircle, CircleDashed, AlertTriangle, Info, File, ChevronRight
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
import { Markdown } from '@/components/ui/markdown';
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";

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

// Render Markdown content while preserving XML tags that should be displayed as tool calls
function renderMarkdownContent(content: string, handleToolClick: (assistantMessageId: string | null, toolName: string) => void, messageId: string | null, fileViewerHandler?: (filePath?: string) => void) {
  const xmlRegex = /<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?>(?:[\s\S]*?)<\/\1>|<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?\/>/g;
  let lastIndex = 0;
  const contentParts: React.ReactNode[] = [];
  let match;

  // If no XML tags found, just return the full content as markdown
  if (!content.match(xmlRegex)) {
    return <Markdown className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words">{content}</Markdown>;
  }

  while ((match = xmlRegex.exec(content)) !== null) {
    // Add text before the tag as markdown
    if (match.index > lastIndex) {
      const textBeforeTag = content.substring(lastIndex, match.index);
      contentParts.push(
        <Markdown key={`md-${lastIndex}`} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none inline-block mr-1 break-words">{textBeforeTag}</Markdown>
      );
    }

    const rawXml = match[0];
    const toolName = match[1] || match[2];
    const IconComponent = getToolIcon(toolName);
    const paramDisplay = extractPrimaryParam(toolName, rawXml);
    const toolCallKey = `tool-${match.index}`;

    if (toolName === 'ask') {
      // Extract attachments from the XML attributes
      const attachmentsMatch = rawXml.match(/attachments=["']([^"']*)["']/i);
      const attachments = attachmentsMatch 
        ? attachmentsMatch[1].split(',').map(a => a.trim())
        : [];
      
      // Extract content from the ask tag
      const contentMatch = rawXml.match(/<ask[^>]*>([\s\S]*?)<\/ask>/i);
      const askContent = contentMatch ? contentMatch[1] : '';

      // Render <ask> tag content with attachment UI
      contentParts.push(
        <div key={`ask-${match.index}`} className="space-y-3">
          <Markdown className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words [&>:first-child]:mt-0 prose-headings:mt-3">{askContent}</Markdown>
          
          {attachments.length > 0 && (
            <div className="mt-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {attachments.map((attachment, idx) => {
                  const extension = attachment.split('.').pop()?.toLowerCase();
                  const filename = attachment.split('/').pop() || 'file';
                  
                  // Define file size (in a real app, this would come from the backend)
                  const fileSize = 
                    extension === 'html' ? '52.68 KB' : 
                    attachment.includes('itinerary') ? '4.14 KB' :
                    attachment.includes('proposal') ? '6.20 KB' :
                    attachment.includes('todo') ? '1.89 KB' :
                    attachment.includes('research') ? '3.75 KB' :
                    `${(Math.random() * 5 + 1).toFixed(2)} KB`;
                  
                  // Get file type display
                  const fileType = extension === 'html' ? 'Code' : 'Text';
                  
                  return (
                    <button
                      key={`attachment-${idx}`}
                      onClick={() => fileViewerHandler?.(attachment)}
                      className="group flex items-center gap-3 p-4 rounded-md bg-muted/10 hover:bg-muted/20 transition-colors"
                    >
                      <div className="flex items-center justify-center">
                        <File className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <div className="text-sm font-medium text-foreground truncate">
                          {filename}
                        </div>
                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                          <span>{fileType}</span>
                          <span>·</span>
                          <span>{fileSize}</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      );
    } else {
      // Render tool button as a clickable element
      contentParts.push(
        <button                                                  
          key={toolCallKey} 
          onClick={() => handleToolClick(messageId, toolName)}
          className="inline-flex items-center gap-1.5 py-1 px-2.5 my-1 text-xs text-muted-foreground bg-muted hover:bg-muted/80 rounded-md transition-colors cursor-pointer border border-border"
        >
          <IconComponent className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          <span className="font-mono text-xs text-foreground">{toolName}</span>
          {paramDisplay && <span className="ml-1 text-muted-foreground truncate max-w-[200px]" title={paramDisplay}>{paramDisplay}</span>}
        </button>
      );
    }
    lastIndex = xmlRegex.lastIndex;
  }

  // Add text after the last tag
  if (lastIndex < content.length) {
    contentParts.push(
      <Markdown key={`md-${lastIndex}`} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none break-words">{content.substring(lastIndex)}</Markdown>
    );
  }

  return contentParts;
}

export default function ThreadPage({ params }: { params: Promise<ThreadParams> }) {
  const unwrappedParams = React.use(params);
  const threadId = unwrappedParams.threadId;
  const isMobile = useIsMobile();
  
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
  const [autoOpenedPanel, setAutoOpenedPanel] = useState(false);
  const [initialPanelOpenAttempted, setInitialPanelOpenAttempted] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const latestMessageRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [userHasScrolled, setUserHasScrolled] = useState(false);
  const hasInitiallyScrolled = useRef<boolean>(false);

  const [project, setProject] = useState<Project | null>(null);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [fileViewerOpen, setFileViewerOpen] = useState(false);
  const [projectName, setProjectName] = useState<string>('');
  const [fileToView, setFileToView] = useState<string | null>(null);

  const initialLoadCompleted = useRef<boolean>(false);
  const messagesLoadedRef = useRef(false);
  const agentRunsCheckedRef = useRef(false);

  const handleProjectRenamed = useCallback((newName: string) => {
    setProjectName(newName);
  }, []);

  const { state: leftSidebarState, setOpen: setLeftSidebarOpen } = useSidebar();
  const initialLayoutAppliedRef = useRef(false);

  const userClosedPanelRef = useRef(false);

  // Replace both useEffect hooks with a single one that respects user closing
  useEffect(() => {
    if (initialLoadCompleted.current && !initialPanelOpenAttempted) {
      // Only attempt to open panel once on initial load
      setInitialPanelOpenAttempted(true);
      
      // Open the panel with tool calls if available
      if (toolCalls.length > 0) {
        setIsSidePanelOpen(true);
        setCurrentToolIndex(toolCalls.length - 1);
      } else {
        // Only if there are messages but no tool calls yet
        if (messages.length > 0) {
          setIsSidePanelOpen(true);
        }
      }
    }
  }, [initialPanelOpenAttempted, messages, toolCalls]);

  const toggleSidePanel = useCallback(() => {
    setIsSidePanelOpen(prevIsOpen => {
      const newState = !prevIsOpen;
      if (!newState) {
        userClosedPanelRef.current = true;
      }
      if (newState) {
        // Close left sidebar when opening side panel
        setLeftSidebarOpen(false);
      }
      return newState;
    });
  }, [setLeftSidebarOpen]);

  const handleSidePanelNavigate = useCallback((newIndex: number) => {
    setCurrentToolIndex(newIndex);
  }, []);

  useEffect(() => {
    if (!initialLayoutAppliedRef.current) {
      setLeftSidebarOpen(false);
      initialLayoutAppliedRef.current = true;
    }
  }, [setLeftSidebarOpen]);

  // Update keyboard shortcut handlers to manage both panels
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // CMD+I for ToolCall SidePanel
      if ((event.metaKey || event.ctrlKey) && event.key === 'i') {
        event.preventDefault();
        // If side panel is already open, just close it
        if (isSidePanelOpen) {
          setIsSidePanelOpen(false);
          userClosedPanelRef.current = true;
        } else {
          // Open side panel and ensure left sidebar is closed
          setIsSidePanelOpen(true);
          setLeftSidebarOpen(false);
        }
      }
      
      // CMD+B for Left Sidebar
      if ((event.metaKey || event.ctrlKey) && event.key === 'b') {
        event.preventDefault();
        // If left sidebar is expanded, collapse it
        if (leftSidebarState === 'expanded') {
          setLeftSidebarOpen(false);
        } else {
          // Otherwise expand the left sidebar and close the side panel
          setLeftSidebarOpen(true);
          if (isSidePanelOpen) {
            setIsSidePanelOpen(false);
            userClosedPanelRef.current = true;
          }
        }
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleSidePanel, isSidePanelOpen, leftSidebarState, setLeftSidebarOpen]);

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

    // If we received a tool message, refresh the tool panel
    if (message.type === 'tool') {
      setAutoOpenedPanel(false);
    }
  }, []);

  const handleStreamStatusChange = useCallback((hookStatus: string) => {
    console.log(`[PAGE] Hook status changed: ${hookStatus}`);
    switch(hookStatus) {
      case 'idle':
      case 'completed':
      case 'stopped':
      case 'agent_not_running':
      case 'error':
      case 'failed':
        setAgentStatus('idle');
        setAgentRunId(null);
        // Reset auto-opened state when agent completes to trigger tool detection
        setAutoOpenedPanel(false);
        
        // After terminal states, we should scroll to bottom to show latest messages
        // The hook will already have refetched messages by this point
        if (['completed', 'stopped', 'agent_not_running', 'error', 'failed'].includes(hookStatus)) {
          scrollToBottom('smooth');
        }
        break;
      case 'connecting':
        setAgentStatus('connecting');
        break;
      case 'streaming':
        setAgentStatus('running');
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
  }, threadId, setMessages);

  useEffect(() => {
    if (agentRunId && agentRunId !== currentHookRunId) {
      console.log(`[PAGE] Target agentRunId set to ${agentRunId}, initiating stream...`);
      startStreaming(agentRunId);
    }
  }, [agentRunId, startStreaming, currentHookRunId]);

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
        
        console.log('[PAGE] Thread data loaded:', threadData);
        
        if (threadData?.project_id) {
          console.log('[PAGE] Getting project data for project_id:', threadData.project_id);
          const projectData = await getProject(threadData.project_id);
          if (isMounted && projectData) {
            console.log('[PAGE] Project data loaded:', projectData);
            console.log('[PAGE] Project ID:', projectData.id);
            console.log('[PAGE] Project sandbox data:', projectData.sandbox);
            
            // Set project data
            setProject(projectData);
            
            // Make sure sandbox ID is set correctly
            if (typeof projectData.sandbox === 'string') {
              setSandboxId(projectData.sandbox);
            } else if (projectData.sandbox?.id) {
              setSandboxId(projectData.sandbox.id);
            }
            
            setProjectName(projectData.name || '');
          }
        }

        if (!messagesLoadedRef.current) {
          const messagesData = await getMessages(threadId);
          if (isMounted) {
            // Log raw messages fetched from API
            console.log('[PAGE] Raw messages fetched:', messagesData);
            
            // Map API message type to UnifiedMessage type
            const unifiedMessages = (messagesData || [])
              .filter(msg => msg.type !== 'status')
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
            console.log('[PAGE] Loaded Messages (excluding status, keeping browser_state):', unifiedMessages.length)
            
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
    
    // First stop the streaming and let the hook handle refetching
    await stopStreaming();
    
    // We don't need to refetch messages here since the hook will do that
    // The centralizing of refetching in the hook simplifies this logic
  }, [stopStreaming]);

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
  }, [messages, agentStatus, userHasScrolled, scrollToBottom]);

  useEffect(() => {
    if (!latestMessageRef.current || messages.length === 0) return;
    const observer = new IntersectionObserver(
      ([entry]) => setShowScrollButton(!entry?.isIntersecting),
      { root: messagesContainerRef.current, threshold: 0.1 }
    );
    observer.observe(latestMessageRef.current);
    return () => observer.disconnect();
  }, [messages, streamingTextContent, streamingToolCall, setShowScrollButton]);

  const handleScrollButtonClick = () => {
    scrollToBottom('smooth');
    setUserHasScrolled(false);
  };

  useEffect(() => {
    console.log(`[PAGE] 🔄 Page AgentStatus: ${agentStatus}, Hook Status: ${streamHookStatus}, Target RunID: ${agentRunId || 'none'}, Hook RunID: ${currentHookRunId || 'none'}`);
    
    // If the stream hook reports completion/stopping but our UI hasn't updated
    if ((streamHookStatus === 'completed' || streamHookStatus === 'stopped' || 
         streamHookStatus === 'agent_not_running' || streamHookStatus === 'error') && 
        (agentStatus === 'running' || agentStatus === 'connecting')) {
      console.log('[PAGE] Detected hook completed but UI still shows running, updating status');
      setAgentStatus('idle');
      setAgentRunId(null);
      setAutoOpenedPanel(false);
    }
  }, [agentStatus, streamHookStatus, agentRunId, currentHookRunId]);

  const handleOpenFileViewer = useCallback((filePath?: string) => {
    if (filePath) {
      setFileToView(filePath);
    } else {
      setFileToView(null);
    }
    setFileViewerOpen(true);
  }, []);

  // Automatically detect and populate tool calls from messages
  useEffect(() => {
    // Calculate historical tool pairs regardless of panel state
    const historicalToolPairs: ToolCallInput[] = [];
    const assistantMessages = messages.filter(m => m.type === 'assistant' && m.message_id);
    
    assistantMessages.forEach(assistantMsg => {
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
        // Determine tool name from assistant message content
        let toolName = 'unknown';
        try {
          // Try to extract tool name from content
          const xmlMatch = assistantMsg.content.match(/<([a-zA-Z\-_]+)(?:\s+[^>]*)?>|<([a-zA-Z\-_]+)(?:\s+[^>]*)?\/>/);
          if (xmlMatch) {
            toolName = xmlMatch[1] || xmlMatch[2] || 'unknown';
          } else {
            // Fallback to checking for tool_calls JSON structure
            const assistantContentParsed = safeJsonParse<{ tool_calls?: { name: string }[] }>(assistantMsg.content, {});
            if (assistantContentParsed.tool_calls && assistantContentParsed.tool_calls.length > 0) {
              toolName = assistantContentParsed.tool_calls[0].name || 'unknown';
            }
          }
        } catch {}

        // Skip adding <ask> tags to the tool calls
        if (toolName === 'ask' || toolName === 'complete') {
          return;
        }

        let isSuccess = true;
        try {
          const toolContent = resultMessage.content?.toLowerCase() || '';
          isSuccess = !(toolContent.includes('failed') || 
                         toolContent.includes('error') || 
                         toolContent.includes('failure'));
        } catch {}

        historicalToolPairs.push({
          assistantCall: {
            name: toolName,
            content: assistantMsg.content,
            timestamp: assistantMsg.created_at
          },
          toolResult: {
            content: resultMessage.content,
            isSuccess: isSuccess,
            timestamp: resultMessage.created_at
          }
        });
      }
    });

    // Always update the toolCalls state
    setToolCalls(historicalToolPairs);
    
    // Logic to open/update the panel index
    if (historicalToolPairs.length > 0) {
      // If the panel is open (or was just auto-opened) and the user didn't close it
      if (isSidePanelOpen && !userClosedPanelRef.current) {
          // Always jump to the latest tool call index
          setCurrentToolIndex(historicalToolPairs.length - 1);
      } else if (!isSidePanelOpen && !autoOpenedPanel && !userClosedPanelRef.current) {
          // Auto-open the panel only the first time tools are detected
          setCurrentToolIndex(historicalToolPairs.length - 1);
          setIsSidePanelOpen(true);
          setAutoOpenedPanel(true); 
      }
    }
  }, [messages, isSidePanelOpen, autoOpenedPanel]); // Rerun when messages or panel state changes

  // Reset auto-opened state when panel is closed
  useEffect(() => {
    if (!isSidePanelOpen) {
      setAutoOpenedPanel(false);
    }
  }, [isSidePanelOpen]);

  // Process the assistant call data
  const toolViewAssistant = useCallback((assistantContent?: string, toolContent?: string) => {
    // This needs to stay simple as it's meant for the side panel tool call view
    if (!assistantContent) return null;
    
    return (
      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">Assistant Message</div>
        <div className="rounded-md border bg-muted/50 p-3">
          <Markdown className="text-xs prose prose-xs dark:prose-invert chat-markdown max-w-none">{assistantContent}</Markdown>
        </div>
      </div>
    );
  }, []);

  // Process the tool result data
  const toolViewResult = useCallback((toolContent?: string, isSuccess?: boolean) => {
    if (!toolContent) return null;
    
    return (
      <div className="space-y-1">
        <div className="flex justify-between items-center">
          <div className="text-xs font-medium text-muted-foreground">Tool Result</div>
          <div className={`px-2 py-0.5 rounded-full text-xs ${
            isSuccess 
              ? 'bg-green-50 text-green-700 dark:bg-green-900 dark:text-green-300' 
              : 'bg-red-50 text-red-700 dark:bg-red-900 dark:text-red-300'
          }`}>
            {isSuccess ? 'Success' : 'Failed'}
          </div>
        </div>
        <div className="rounded-md border bg-muted/50 p-3">
          <Markdown className="text-xs prose prose-xs dark:prose-invert chat-markdown max-w-none">{toolContent}</Markdown>
        </div>
      </div>
    );
  }, []);

  // Update handleToolClick to respect user closing preference and navigate correctly
  const handleToolClick = useCallback((clickedAssistantMessageId: string | null, clickedToolName: string) => {
    // Explicitly ignore ask tags from opening the side panel
    if (clickedToolName === 'ask') {
      return;
    }
    
    if (!clickedAssistantMessageId) {
      console.warn("Clicked assistant message ID is null. Cannot open side panel.");
      toast.warning("Cannot view details: Assistant message ID is missing.");
      return;
    }

    // Reset user closed state when explicitly clicking a tool
    userClosedPanelRef.current = false;

    console.log("[PAGE] Tool Click Triggered. Assistant Message ID:", clickedAssistantMessageId, "Tool Name:", clickedToolName);

    // Find the index of the tool call associated with the clicked assistant message
    const toolIndex = toolCalls.findIndex(tc => {
      // Check if the assistant message ID matches the one stored in the tool result's metadata
      if (!tc.toolResult?.content || tc.toolResult.content === "STREAMING") return false; // Skip streaming or incomplete calls

      // Directly compare assistant message IDs if available in the structure
      // Find the original assistant message based on the ID
      const assistantMessage = messages.find(m => m.message_id === clickedAssistantMessageId && m.type === 'assistant');
      if (!assistantMessage) return false;

      // Find the corresponding tool message using metadata
      const toolMessage = messages.find(m => {
        if (m.type !== 'tool' || !m.metadata) return false;
        try {
          const metadata = safeJsonParse<ParsedMetadata>(m.metadata, {});
          return metadata.assistant_message_id === assistantMessage.message_id;
        } catch {
          return false;
        }
      });
      
      // Check if the current toolCall 'tc' corresponds to this assistant/tool message pair
      return tc.assistantCall?.content === assistantMessage.content &&
             tc.toolResult?.content === toolMessage?.content;
    });


    if (toolIndex !== -1) {
      console.log(`[PAGE] Found tool call at index ${toolIndex} for assistant message ${clickedAssistantMessageId}`);
      setCurrentToolIndex(toolIndex);
      setIsSidePanelOpen(true); // Explicitly open the panel
    } else {
      console.warn(`[PAGE] Could not find matching tool call in toolCalls array for assistant message ID: ${clickedAssistantMessageId}`);
      toast.info("Could not find details for this tool call.");
      // Optionally, still open the panel but maybe at the last index or show a message?
      // setIsSidePanelOpen(true);
    }
  }, [messages, toolCalls]); // Add toolCalls as a dependency

  // Handle streaming tool calls
  const handleStreamingToolCall = useCallback((toolCall: StreamingToolCall | null) => {
    if (!toolCall) return;
    
    const toolName = toolCall.name || toolCall.xml_tag_name || 'Unknown Tool';
    
    // Skip <ask> tags from showing in the side panel during streaming
    if (toolName === 'ask' || toolName === 'complete') {
      return;
    }
    
    console.log("[STREAM] Received tool call:", toolName);
    
    // If user explicitly closed the panel, don't reopen it for streaming calls
    if (userClosedPanelRef.current) return;
    
    // Create a properly formatted tool call input for the streaming tool
    // that matches the format of historical tool calls
    const toolArguments = toolCall.arguments || '';
    
    // Format the arguments in a way that matches the expected XML format for each tool
    // This ensures the specialized tool views render correctly
    let formattedContent = toolArguments;
    if (toolName.toLowerCase().includes('command') && !toolArguments.includes('<execute-command>')) {
      formattedContent = `<execute-command>${toolArguments}</execute-command>`;
    } else if (toolName.toLowerCase().includes('file') && !toolArguments.includes('<create-file>')) {
      // For file operations, wrap with appropriate tag if not already wrapped
      const fileOpTags = ['create-file', 'delete-file', 'full-file-rewrite'];
      const matchingTag = fileOpTags.find(tag => toolName.toLowerCase().includes(tag));
      if (matchingTag && !toolArguments.includes(`<${matchingTag}>`)) {
        formattedContent = `<${matchingTag}>${toolArguments}</${matchingTag}>`;
      }
    }
    
    const newToolCall: ToolCallInput = {
      assistantCall: {
        name: toolName,
        content: formattedContent,
        timestamp: new Date().toISOString()
      },
      // For streaming tool calls, provide empty content that indicates streaming
      toolResult: {
        content: "STREAMING",
        isSuccess: true, 
        timestamp: new Date().toISOString()
      }
    };
    
    // Update the tool calls state to reflect the streaming tool
    setToolCalls(prev => {
      // If the same tool is already being streamed, update it instead of adding a new one
      if (prev.length > 0 && prev[0].assistantCall.name === toolName) {
        return [{
          ...prev[0],
          assistantCall: {
            ...prev[0].assistantCall,
            content: formattedContent
          }
        }];
      }
      return [newToolCall];
    });
    
    setCurrentToolIndex(0);
    setIsSidePanelOpen(true);
  }, []);

  // SEO title update
  useEffect(() => {
    if (projectName) {
      // Update document title when project name changes
      document.title = `${projectName} | Kortix Suna`;
      
      // Update meta tags for SEO
      const metaDescription = document.querySelector('meta[name="description"]');
      if (metaDescription) {
        metaDescription.setAttribute('content', `${projectName} - Interactive agent conversation powered by Kortix Suna`);
      }
      
      // Update OpenGraph tags if they exist
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) {
        ogTitle.setAttribute('content', `${projectName} | Kortix Suna`);
      }
      
      const ogDescription = document.querySelector('meta[property="og:description"]');
      if (ogDescription) {
        ogDescription.setAttribute('content', `Interactive AI conversation for ${projectName}`);
      }
    }
  }, [projectName]);

  // Add another useEffect to ensure messages are refreshed when agent status changes to idle
  useEffect(() => {
    if (agentStatus === 'idle' && streamHookStatus !== 'streaming' && streamHookStatus !== 'connecting') {
      console.log('[PAGE] Agent status changed to idle, ensuring messages are up to date');
      // Only do this if we're not in the initial loading state
      if (!isLoading && initialLoadCompleted.current) {
        // Double-check messages after a short delay to ensure we have latest content
        const timer = setTimeout(() => {
          getMessages(threadId).then(messagesData => {
            if (messagesData) {
              console.log(`[PAGE] Backup refetch completed with ${messagesData.length} messages`);
              // Map API message type to UnifiedMessage type
              const unifiedMessages = (messagesData || [])
                .filter(msg => msg.type !== 'status') 
                .map((msg: ApiMessageType) => ({
                  message_id: msg.message_id || null, 
                  thread_id: msg.thread_id || threadId,
                  type: (msg.type || 'system') as UnifiedMessage['type'], 
                  is_llm_message: Boolean(msg.is_llm_message),
                  content: msg.content || '',
                  metadata: msg.metadata || '{}',
                  created_at: msg.created_at || new Date().toISOString(),
                  updated_at: msg.updated_at || new Date().toISOString()
                }));
              
              setMessages(unifiedMessages);
              // Reset auto-opened panel to allow tool detection with fresh messages
              setAutoOpenedPanel(false);
              scrollToBottom('smooth');
            }
          }).catch(err => {
            console.error('Error in backup message refetch:', err);
          });
        }, 1000);
        
        return () => clearTimeout(timer);
      }
    }
  }, [agentStatus, threadId, isLoading, streamHookStatus]);

  if (isLoading && !initialLoadCompleted.current) {
    return (
      <div className="flex h-screen">
        <div className={`flex flex-col flex-1 overflow-hidden transition-all duration-200 ease-in-out ${isSidePanelOpen ? 'mr-[90%] sm:mr-[450px] md:mr-[500px] lg:mr-[550px] xl:mr-[650px]' : ''}`}>
          {/* Skeleton Header */}
          <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="flex h-14 items-center gap-4 px-4">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-6 w-6 rounded-full" />
                  <Skeleton className="h-5 w-40" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-8 w-8 rounded-full" />
                <Skeleton className="h-8 w-8 rounded-full" />
              </div>
            </div>
          </div>
          
          {/* Skeleton Chat Messages */}
          <div className="flex-1 overflow-y-auto px-6 py-4 pb-[5.5rem]">
            <div className="mx-auto max-w-3xl space-y-6">
              {/* User message */}
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg bg-primary/10 px-4 py-3">
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-4 w-32" />
                  </div>
                </div>
              </div>
              
              {/* Assistant response with tool usage */}
              <div>
                <div className="flex items-start gap-3">
                  <Skeleton className="flex-shrink-0 w-5 h-5 mt-2 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <div className="max-w-[90%] w-full rounded-lg bg-muted px-4 py-3">
                      <div className="space-y-3">
                        <div>
                          <Skeleton className="h-4 w-full max-w-[360px] mb-2" />
                          <Skeleton className="h-4 w-full max-w-[320px] mb-2" />
                          <Skeleton className="h-4 w-full max-w-[290px]" />
                        </div>
                        
                        {/* Tool call button skeleton */}
                        <div className="py-1">
                          <Skeleton className="h-6 w-32 rounded-md" />
                        </div>
                        
                        <div>
                          <Skeleton className="h-4 w-full max-w-[340px] mb-2" />
                          <Skeleton className="h-4 w-full max-w-[280px]" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              
              {/* User message */}
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg bg-primary/10 px-4 py-3">
                  <Skeleton className="h-4 w-36" />
                </div>
              </div>
              
              {/* Assistant thinking state */}
              <div>
                <div className="flex items-start gap-3">
                  <Skeleton className="flex-shrink-0 w-5 h-5 mt-2 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-1.5 py-1">
                      <div className="h-1.5 w-1.5 rounded-full bg-gray-400/50 animate-pulse" />
                      <div className="h-1.5 w-1.5 rounded-full bg-gray-400/50 animate-pulse delay-150" />
                      <div className="h-1.5 w-1.5 rounded-full bg-gray-400/50 animate-pulse delay-300" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          {/* Skeleton Chat Input */}
          <div className="border-t p-4">
            <div className="mx-auto max-w-3xl">
              <div className="relative">
                <Skeleton className="h-10 w-full rounded-md" />
                <div className="absolute right-2 top-2">
                  <Skeleton className="h-6 w-6 rounded-full" />
                </div>
              </div>
            </div>
          </div>
        </div>
        
        {/* Skeleton Side Panel (closed state) */}
        <div className={`hidden ${isSidePanelOpen ? 'block' : ''}`}>
          <div className="h-screen w-[450px] border-l">
            <div className="p-4">
              <Skeleton className="h-8 w-32 mb-4" />
              <Skeleton className="h-20 w-full rounded-md mb-4" />
              <Skeleton className="h-40 w-full rounded-md" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen">
        <div className={`flex flex-col flex-1 overflow-hidden transition-all duration-200 ease-in-out ${isSidePanelOpen ? 'mr-[90%] sm:mr-[450px] md:mr-[500px] lg:mr-[550px] xl:mr-[650px]' : ''}`}>
          <SiteHeader 
            threadId={threadId} 
            projectName={projectName}
            projectId={project?.id || ""}
            onViewFiles={handleOpenFileViewer} 
            onToggleSidePanel={toggleSidePanel}
            isMobileView={isMobile}
          />
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-lg border bg-card p-6 text-center">
              <h2 className="text-lg font-semibold text-destructive">Error</h2>
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" onClick={() => router.push(`/projects/${project?.id || ''}`)}>
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
          project={project || undefined}
          agentStatus="error"
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <div className={`flex flex-col flex-1 overflow-hidden transition-all duration-200 ease-in-out ${isSidePanelOpen ? 'mr-[90%] sm:mr-[450px] md:mr-[500px] lg:mr-[550px] xl:mr-[650px]' : ''}`}>
        <SiteHeader 
          threadId={threadId} 
          projectName={projectName}
          projectId={project?.id || ""}
          onViewFiles={handleOpenFileViewer} 
          onToggleSidePanel={toggleSidePanel}
          onProjectRenamed={handleProjectRenamed}
          isMobileView={isMobile}
        />
        <div 
          ref={messagesContainerRef}
          className="flex-1 overflow-y-auto px-6 py-4 pb-24 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60"
          onScroll={handleScroll}
        >
          <div className="mx-auto max-w-3xl">
            {messages.length === 0 && !streamingTextContent && !streamingToolCall && agentStatus === 'idle' ? (
              <div className="flex h-full items-center justify-center">
                <div className="text-center text-muted-foreground">Send a message to start.</div>
              </div>
            ) : (
              <div className="space-y-8">
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
                    } else if (messageType === 'assistant' || messageType === 'tool' || messageType === 'browser_state') {
                      if (currentGroup && currentGroup.type === 'assistant_group') {
                        currentGroup.messages.push(message);
                      } else {
                        if (currentGroup) {
                          groupedMessages.push(currentGroup);
                        }
                        currentGroup = { type: 'assistant_group', messages: [message], key };
                      }
                    } else if (messageType !== 'status') {
                      if (currentGroup) {
                        groupedMessages.push(currentGroup);
                        currentGroup = null;
                      }
                    }
                  });

                  if (currentGroup) {
                    groupedMessages.push(currentGroup);
                  }
                  
                  return groupedMessages.map((group, groupIndex) => {
                    if (group.type === 'user') {
                      const message = group.messages[0];
                      const messageContent = (() => {
                        try {
                          const parsed = safeJsonParse<ParsedContent>(message.content, { content: message.content });
                          return parsed.content || message.content;
                        } catch {
                          return message.content;
                        }
                      })();
                      
                      // Extract attachments from the message content
                      const attachmentsMatch = messageContent.match(/\[Uploaded File: (.*?)\]/g);
                      const attachments = attachmentsMatch 
                        ? attachmentsMatch.map(match => {
                            const pathMatch = match.match(/\[Uploaded File: (.*?)\]/);
                            return pathMatch ? pathMatch[1] : null;
                          }).filter(Boolean)
                        : [];
                      
                      // Remove attachment info from the message content
                      const cleanContent = messageContent.replace(/\[Uploaded File: .*?\]/g, '').trim();
                      
                      return (
                        <div key={group.key} className="flex justify-end">
                          <div className="inline-flex max-w-[85%] rounded-lg bg-primary/10 px-4 py-3">
                            <div className="space-y-3">
                              {cleanContent && (
                                <Markdown className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3">{cleanContent}</Markdown>
                              )}
                              
                              {attachments.length > 0 && (
                                <div className="mt-6">
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    {attachments.map((attachment, idx) => {
                                      const extension = attachment.split('.').pop()?.toLowerCase();
                                      const filename = attachment.split('/').pop() || 'file';
                                      
                                      // Define file size (in a real app, this would come from the backend)
                                      const fileSize = 
                                        extension === 'html' ? '52.68 KB' : 
                                        attachment.includes('itinerary') ? '4.14 KB' :
                                        attachment.includes('proposal') ? '6.20 KB' :
                                        attachment.includes('todo') ? '1.89 KB' :
                                        attachment.includes('research') ? '3.75 KB' :
                                        `${(Math.random() * 5 + 1).toFixed(2)} KB`;
                                      
                                      // Get file type display
                                      const fileType = extension === 'html' ? 'Code' : 'Text';
                                      
                                      return (
                                        <button
                                          key={`attachment-${idx}`}
                                          onClick={() => handleOpenFileViewer(attachment)}
                                          className="group flex items-center gap-3 p-4 rounded-md bg-muted/10 hover:bg-muted/20 transition-colors"
                                        >
                                          <div className="flex items-center justify-center">
                                            <File className="h-5 w-5 text-muted-foreground" />
                                          </div>
                                          <div className="flex-1 min-w-0 text-left">
                                            <div className="text-sm font-medium text-foreground truncate">
                                              {filename}
                                            </div>
                                            <div className="text-xs text-muted-foreground flex items-center gap-1">
                                              <span>{fileType}</span>
                                              <span>·</span>
                                              <span>{fileSize}</span>
                                            </div>
                                          </div>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    } else if (group.type === 'assistant_group') {
                      return (
                        <div key={group.key} ref={groupIndex === groupedMessages.length - 1 ? latestMessageRef : null}>
                          <div className="flex items-start gap-3">
                            <div className="flex-shrink-0 w-5 h-5 mt-2 rounded-md flex items-center justify-center overflow-hidden ml-auto mr-2">
                              <Image src="/kortix-symbol.svg" alt="Kortix" width={14} height={14} className="object-contain invert dark:invert-0 opacity-70" />
                            </div>
                            <div className="flex-1">
                              <div className="inline-flex max-w-[90%] rounded-lg bg-muted/5 px-4 py-3 text-sm">
                                <div className="space-y-2">
                                  {(() => {
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

                                        if (!parsedContent.content) return;

                                        const renderedContent = renderMarkdownContent(
                                          parsedContent.content, 
                                          handleToolClick, 
                                          message.message_id,
                                          handleOpenFileViewer
                                        );

                                        elements.push(
                                          <div key={msgKey} className={msgIndex > 0 ? "mt-2" : ""}>
                                            <div className="prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3">
                                              {renderedContent}
                                            </div>
                                          </div>
                                        );
                                      }
                                    });

                                    return elements;
                                  })()}

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
                                                <Markdown className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3">{textBeforeTag}</Markdown>
                                              )}
                                              {showCursor && (
                                                <span className="inline-block h-4 w-0.5 bg-primary ml-0.5 -mb-1 animate-pulse" />
                                              )}

                                              {detectedTag && (
                                                <div className="mt-2 mb-1">
                                                  <button
                                                    className="inline-flex items-center gap-1.5 py-1 px-2.5 text-xs font-medium text-primary bg-primary/10 hover:bg-primary/20 rounded-md transition-colors cursor-pointer border border-primary/20"
                                                  >
                                                    <CircleDashed className="h-3.5 w-3.5 text-primary flex-shrink-0 animate-spin animation-duration-2000" />
                                                    <span className="font-mono text-xs text-primary">{detectedTag}</span>
                                                  </button>
                                                </div>
                                              )}

                                              {streamingToolCall && !detectedTag && (
                                                <div className="mt-2 mb-1">
                                                  {(() => {
                                                    const toolName = streamingToolCall.name || streamingToolCall.xml_tag_name || 'Tool';
                                                    const IconComponent = getToolIcon(toolName);
                                                    const paramDisplay = extractPrimaryParam(toolName, streamingToolCall.arguments || '');
                                                    return (
                                                      <button
                                                        className="inline-flex items-center gap-1.5 py-1 px-2.5 text-xs font-medium text-primary bg-primary/10 hover:bg-primary/20 rounded-md transition-colors cursor-pointer border border-primary/20"
                                                      >
                                                        <CircleDashed className="h-3.5 w-3.5 text-primary flex-shrink-0 animate-spin animation-duration-2000" />
                                                        <span className="font-mono text-xs text-primary">{toolName}</span>
                                                        {paramDisplay && <span className="ml-1 text-primary/70 truncate max-w-[200px]" title={paramDisplay}>{paramDisplay}</span>}
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
                    return null;
                  });
                })()}
                {(agentStatus === 'running' || agentStatus === 'connecting') && 
                  (messages.length === 0 || messages[messages.length - 1].type === 'user') && (
                    <div ref={latestMessageRef}>
                      <div className="flex items-start gap-3">
                        <div className="flex-shrink-0 w-5 h-5 rounded-md flex items-center justify-center overflow-hidden bg-primary/10">
                          <Image src="/kortix-symbol.svg" alt="Suna" width={14} height={14} className="object-contain"/>
                        </div>
                        <div className="flex-1 space-y-2">
                          <div className="max-w-[90%] px-4 py-3 text-sm">
                            <div className="flex items-center gap-1.5 py-1">
                              <div className="h-1.5 w-1.5 rounded-full bg-primary/50 animate-pulse" />
                              <div className="h-1.5 w-1.5 rounded-full bg-primary/50 animate-pulse delay-150" />
                              <div className="h-1.5 w-1.5 rounded-full bg-primary/50 animate-pulse delay-300" />
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
        </div>
      </div>

      <div className={cn(
        "fixed bottom-0 z-10 bg-gradient-to-t from-background via-background/90 to-transparent px-4 pt-8 transition-all duration-200 ease-in-out",
        leftSidebarState === 'expanded' ? 'left-[72px] lg:left-[256px]' : 'left-[72px]',
        isSidePanelOpen ? 'right-[90%] sm:right-[450px] md:right-[500px] lg:right-[550px] xl:right-[650px]' : 'right-0',
        isMobile ? 'left-0 right-0' : ''
      )}>
        <div className={cn(
          "mx-auto",
          isMobile ? "w-full px-4" : "max-w-3xl"
        )}>
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

      <ToolCallSidePanel 
        isOpen={isSidePanelOpen} 
        onClose={() => {
          setIsSidePanelOpen(false);
          userClosedPanelRef.current = true;
          setAutoOpenedPanel(true);
        }}
        toolCalls={toolCalls}
        messages={messages as ApiMessageType[]}
        agentStatus={agentStatus}
        currentIndex={currentToolIndex}
        onNavigate={handleSidePanelNavigate}
        project={project || undefined}
        renderAssistantMessage={toolViewAssistant}
        renderToolResult={toolViewResult}
      />

      {sandboxId && (
        <FileViewerModal
          open={fileViewerOpen}
          onOpenChange={setFileViewerOpen}
          sandboxId={sandboxId}
          initialFilePath={fileToView}
          project={project || undefined}
        />
      )}
    </div>
  );
}

