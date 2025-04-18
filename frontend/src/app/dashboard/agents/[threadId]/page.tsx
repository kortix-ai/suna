'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  ArrowDown, CheckCircle, CircleDashed, AlertTriangle, Info
} from 'lucide-react';
import { addUserMessage, getMessages, startAgent, stopAgent, getAgentRuns, getProject, getThread, updateProject, Project, Message as BaseApiMessageType } from '@/lib/api';
import { toast } from 'sonner';
import { Skeleton } from "@/components/ui/skeleton";
import { ChatInput } from '@/components/thread/chat-input';
import { FileViewerModal } from '@/components/thread/file-viewer-modal';
import { SiteHeader } from "@/components/thread/thread-site-header"
import { ToolCallSidePanel, SidePanelContent, ToolCallData } from "@/components/thread/tool-call-side-panel";
import { useSidebar } from "@/components/ui/sidebar";
import { useAgentStream, AgentStreamStatus } from '@/hooks/useAgentStream';

import { UnifiedMessage, ParsedContent, ParsedMetadata, ThreadParams } from '@/components/thread/types';
import { getToolIcon, extractPrimaryParam, safeJsonParse } from '@/components/thread/utils';

// Extend the base Message type with the expected database fields
interface ApiMessageType extends BaseApiMessageType {
  id?: string;
  thread_id?: string;
  is_llm_message?: boolean;
  metadata?: string;
  created_at?: string;
  updated_at?: string;
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
  const [sidePanelContent, setSidePanelContent] = useState<SidePanelContent | null>(null);

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

  const initialLoadCompleted = useRef<boolean>(false);
  const messagesLoadedRef = useRef(false);
  const agentRunsCheckedRef = useRef(false);

  const { state: leftSidebarState, setOpen: setLeftSidebarOpen } = useSidebar();
  const initialLayoutAppliedRef = useRef(false);

  const toggleSidePanel = useCallback(() => {
    setIsSidePanelOpen(prevIsOpen => !prevIsOpen);
  }, []);

  const handleProjectRenamed = useCallback((newName: string) => {
    setProjectName(newName);
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
    setMessages(prev => {
      const messageExists = prev.some(m => m.message_id === message.message_id);
      if (messageExists) {
        return prev.map(m => m.message_id === message.message_id ? message : m);
      } else {
        return [...prev, message];
      }
    });
  }, []);

  const handleStreamStatusChange = useCallback((hookStatus: AgentStreamStatus) => {
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
            // Map API message type to UnifiedMessage type using a safe conversion function
            const unifiedMessages = (messagesData || []).map((msg: ApiMessageType) => {
              return {
                message_id: msg.id || null,
                thread_id: msg.thread_id || threadId,
                type: (msg.type || 'system') as "user" | "assistant" | "tool" | "status" | "system", 
                is_llm_message: Boolean(msg.is_llm_message),
                content: msg.content || '',
                metadata: msg.metadata || '{}',
                created_at: msg.created_at || new Date().toISOString(),
                updated_at: msg.updated_at || new Date().toISOString()
              } as UnifiedMessage;
            });
            const filteredMessages = unifiedMessages.filter(m => m.type !== 'status');
            setMessages(filteredMessages);
            console.log('[PAGE] Loaded Messages:', filteredMessages.length)
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
      content: JSON.stringify({ role: 'user', content: message }),
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
      setMessages(prev => prev.filter(m => m.message_id !== optimisticUserMessage.message_id));

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

  const handleOpenFileViewer = useCallback(() => setFileViewerOpen(true), []);

  const handleToolClick = useCallback((message: UnifiedMessage, toolInfo: { name: string, args: any, xml: string } | null) => {
    if (!toolInfo) return;

    console.log("Tool Clicked:", toolInfo.name, "Message ID:", message.message_id);
    
    // Find the corresponding tool result message that has this assistant message's ID in its metadata
    const resultMessage = messages.find(m => {
      if (m.type !== 'tool') return false;
      
      // Parse the metadata to get the assistant_message_id
      const parsedMetadata = safeJsonParse<ParsedMetadata>(m.metadata, {});
      
      // Direct matching by assistant_message_id is the most reliable way
      if (message.message_id && parsedMetadata.assistant_message_id === message.message_id) {
        return true;
      }
      
      // For XML tools, match by tool name as fallback
      if (!message.message_id && toolInfo.name) {
        const parsedContent = safeJsonParse<ParsedContent>(m.content, {});
        
        // Check if the tool result contains this tool name
        if (typeof parsedContent.content === 'string' && 
            parsedContent.content.includes(`<${toolInfo.name}>`)) {
          return true;
        }
      }
      
      return false;
    });

    if (resultMessage) {
      console.log("Found matching tool result:", resultMessage.message_id);
    } else {
      console.log("No matching tool result found for assistant message:", message.message_id);
    }

    const resultContent = resultMessage ? resultMessage.content : null;
    const parsedResultContent = resultContent ? safeJsonParse<ParsedContent>(resultContent, {}) : null;
    const displayResultContent = parsedResultContent?.content || resultContent;

    // Create HistoricalToolPair format for the side panel
    setSidePanelContent({
      type: 'historical',
      assistantCall: {
        name: toolInfo.name,
        content: toolInfo.xml || (typeof toolInfo.args === 'string' ? toolInfo.args : JSON.stringify(toolInfo.args, null, 2))
      },
      userResult: {
        name: parsedResultContent?.name || toolInfo.name,
        content: displayResultContent
      }
    });
    
    setIsSidePanelOpen(true);
  }, [messages]);

  if (isLoading && !initialLoadCompleted.current) {
    return (
      <div className="flex h-screen">
        <div className="flex-1 flex flex-col overflow-hidden">
          <SiteHeader 
            threadId={threadId} 
            projectName={projectName}
            projectId={project?.id ?? null}
            onViewFiles={handleOpenFileViewer} 
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
          onClose={() => setIsSidePanelOpen(false)}
          content={sidePanelContent}
          project={project}
          currentIndex={0}
          totalPairs={0}
          onNavigate={() => {}}
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
          content={sidePanelContent}
          project={project}
          currentIndex={0}
          totalPairs={0}
          onNavigate={() => {}}
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
          projectId={project?.id ?? null}
          onViewFiles={handleOpenFileViewer} 
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
                {messages.length === 0 && !streamingTextContent && !streamingToolCall && agentStatus === 'idle' ? (
                  <div className="flex h-full items-center justify-center">
                    <div className="text-center text-muted-foreground">Send a message to start.</div>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {messages.map((message, index) => {
                      const parsedContent = safeJsonParse<ParsedContent>(message.content, {});
                      const parsedMetadata = safeJsonParse<ParsedMetadata>(message.metadata, {});
                      const key = message.message_id || `msg-${index}`;

                      switch(message.type) {
                         case 'user':
                        return (
                             <div key={key} className="flex justify-end">
                               <div className="max-w-[85%] rounded-lg bg-primary/10 px-4 py-3 text-sm">
                                 {parsedContent.content}
                                </div>
                              </div>
                           );

                         case 'assistant':
                           const xmlRegex = /<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?>(?:[\s\S]*?)<\/\1>|<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?\/>/g;
                           let lastIndex = 0;
                           const contentParts: React.ReactNode[] = [];
                           let match;

                           if (!parsedContent.content) {
                             return parsedContent.content;
                           }

                           while ((match = xmlRegex.exec(parsedContent.content)) !== null) {
                               if (match.index > lastIndex) {
                                 contentParts.push(
                                   <span key={`text-${lastIndex}`}>
                                     {parsedContent.content.substring(lastIndex, match.index)}
                                   </span>
                                 );
                               }

                               const rawXml = match[0];
                               const toolName = match[1] || match[2];
                               const IconComponent = getToolIcon(toolName);
                               const paramDisplay = extractPrimaryParam(toolName, rawXml);
                               
                               // Extract arguments from XML
                               let toolArgs = {};
                               try {
                                 // Extract attributes as an object
                                 if (rawXml.includes(' ')) {  // Only if attributes exist
                                   const attrSection = rawXml.match(/<[^>]+\s+([^>]+)>/);
                                   if (attrSection && attrSection[1]) {
                                     const attrStr = attrSection[1].trim();
                                     const attrRegex = /(\w+)=["']([^"']*)["']/g;
                                     let attrMatch;
                                     while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
                                       toolArgs[attrMatch[1]] = attrMatch[2];
                                     }
                                   }
                                 }
                               } catch (e) {
                                 console.error("Error parsing XML attributes:", e);
                               }
                               
                               contentParts.push(
                                 <button
                                   key={`tool-${match.index}`}
                                   onClick={() => handleToolClick(message, { 
                                     name: toolName, 
                                     args: toolArgs, 
                                     xml: rawXml 
                                   })}
                                   className="inline-flex items-center gap-1.5 py-0.5 px-2 my-0.5 text-xs text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors cursor-pointer border border-gray-200"
                                 >
                                   <IconComponent className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
                                   <span className="font-mono text-xs text-gray-700">{toolName}</span>
                                   {paramDisplay && <span className="ml-1 text-gray-500 truncate" title={paramDisplay}>{paramDisplay}</span>}
                                 </button>
                               );
                               lastIndex = xmlRegex.lastIndex;
                           }

                           if (lastIndex < parsedContent.content.length) {
                             contentParts.push(
                               <span key={`text-${lastIndex}`}>
                                 {parsedContent.content.substring(lastIndex)}
                               </span>
                             );
                           }

                           return (
                             <div key={key} ref={index === messages.length - 1 ? latestMessageRef : null}>
                               <div className="flex items-start gap-3">
                                  <div className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center overflow-hidden bg-gray-200">
                                    <Image src="/kortix-symbol.svg" alt="Suna" width={14} height={14} className="object-contain"/>
                                  </div>
                                 <div className="flex-1 space-y-2">
                                   <div className="max-w-[85%] rounded-lg bg-muted px-4 py-3 text-sm">
                                      <div className="whitespace-pre-wrap break-words">
                                        {contentParts.length > 0 ? contentParts : parsedContent.content}
                              </div>
                          </div>
                          </div>
                        </div>
                            </div>
                           );

                          case 'tool':
                             const toolResultContent = safeJsonParse<ParsedContent>(message.content, {});
                             let toolNameForResult = toolResultContent.name || 'Tool';
                             
                             // Try to get the assistant message ID this result belongs to
                             const associatedAssistantId = parsedMetadata.assistant_message_id;
                             
                             // Extract content from XML format if available
                             let displayContent = '';
                             let toolSuccess = true; // Default to success
                             
                             if (typeof toolResultContent.content === 'string') {
                               if (toolResultContent.content.includes('<tool_result>')) {
                                 const toolMatch = toolResultContent.content.match(/<tool_result>([\s\S]*?)<\/tool_result>/i);
                                 if (toolMatch && toolMatch[1]) {
                                   // Further extract inner tool content
                                   const innerMatch = toolMatch[1].match(/<([a-zA-Z\-_]+)>([\s\S]*?)<\/\1>/i);
                                   if (innerMatch) {
                                     const innerToolName = innerMatch[1];
                                     displayContent = innerMatch[2].trim();
                                     
                                     // Update the tool name if we found a more specific one
                                     if (innerToolName && innerToolName !== 'tool_result') {
                                       toolNameForResult = innerToolName;
                                     }
                                   } else {
                                     displayContent = toolMatch[1].trim();
                                   }
                                 }
                               } else {
                                 // Default to raw content if not in tool_result format
                                 displayContent = toolResultContent.content;
                               }
                             }
                             
                             // Check for errors or failures in the content
                             toolSuccess = !(
                               displayContent.includes('error') || 
                               displayContent.includes('failed') || 
                               displayContent.includes('failure') ||
                               displayContent.includes('success=False')
                             );
                             
                             // Format the tool result display
                             let statusIcon = toolSuccess 
                               ? <CheckCircle className="h-3 w-3 text-green-600 flex-shrink-0" />
                               : <AlertTriangle className="h-3 w-3 text-amber-500 flex-shrink-0" />;
                               
                             let statusClass = toolSuccess 
                               ? "text-green-600" 
                               : "text-amber-500";
                               
                             // Truncate display content if it's too long
                             const maxDisplayLength = 50;
                             const truncatedContent = displayContent && displayContent.length > maxDisplayLength
                               ? `${displayContent.substring(0, maxDisplayLength)}...`
                               : displayContent;

                             return (
                               <div key={key} className="ml-8 my-2 pl-4 border-l border-dashed border-gray-300 py-1">
                                 <div className="flex items-center gap-1.5 text-xs text-gray-500">
                                   {statusIcon}
                                   <span className={`font-medium ${statusClass}`}>
                                     {toolNameForResult} {toolSuccess ? 'completed' : 'failed'}
                                   </span>
                                   {associatedAssistantId && (
                                     <span className="text-xs text-gray-400 ml-1">
                                       • linked to {associatedAssistantId.substring(0, 6)}
                                     </span>
                                   )}
                                   {truncatedContent && (
                                     <span className="text-xs text-gray-400 ml-1 truncate max-w-[200px]" title={displayContent}>
                                       {truncatedContent}
                                     </span>
                                   )}
                                 </div>
                               </div>
                             );

                          case 'status':
                              return null;

                         default:
                            console.warn("Rendering unknown message type:", message.type);
                            return (
                              <div key={key} className="text-center text-red-500 text-xs">
                                Unsupported message type: {message.type}
                                      </div>
                                    );
                      }
                    })}
                    {(streamHookStatus === 'streaming' || streamHookStatus === 'connecting') && (
                      <div ref={latestMessageRef}>
                        <div className="flex items-start gap-3">
                           <div className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center overflow-hidden bg-gray-200">
                             <Image src="/kortix-symbol.svg" alt="Suna" width={14} height={14} className="object-contain"/>
                                      </div>
                          <div className="flex-1 space-y-2">
                            <div className="max-w-[85%] rounded-lg bg-muted px-4 py-3 text-sm">
                               {streamingTextContent && (
                                 <span className="whitespace-pre-wrap break-words">
                                   {streamingTextContent}
                                        </span>
                               )}
                               {(streamHookStatus === 'streaming' || streamHookStatus === 'connecting') && <span className="inline-block h-4 w-0.5 bg-gray-400 ml-0.5 -mb-1 animate-pulse" />}

                               {streamingToolCall && (
                                  <div className="mt-2">
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
                        </div>
                      </div>
                          </div>
                        </div>
                    )}
                    {agentStatus === 'running' && !streamingTextContent && !streamingToolCall && messages.length > 0 && messages[messages.length-1].type === 'user' && (
                         <div ref={latestMessageRef}>
                             <div className="flex items-start gap-3">
                                 <div className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center overflow-hidden bg-gray-200">
                                   <Image src="/kortix-symbol.svg" alt="Suna" width={14} height={14} className="object-contain"/>
                                 </div>
                        <div className="flex items-center gap-1.5 py-1">
                          <div className="h-1.5 w-1.5 rounded-full bg-gray-400/50 animate-pulse" />
                          <div className="h-1.5 w-1.5 rounded-full bg-gray-400/50 animate-pulse delay-150" />
                          <div className="h-1.5 w-1.5 rounded-full bg-gray-400/50 animate-pulse delay-300" />
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
        </div>
      </div>

      <ToolCallSidePanel 
        isOpen={isSidePanelOpen} 
        onClose={() => setIsSidePanelOpen(false)}
        content={sidePanelContent}
        project={project}
        currentIndex={0}
        totalPairs={0}
        onNavigate={() => {}}
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
