'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  ArrowDown, CircleDashed, Info, File, ChevronRight, Play, Pause
} from 'lucide-react';
import { getMessages, getProject, getThread, Project, Message as BaseApiMessageType } from '@/lib/api';
import { toast } from 'sonner';
import { Skeleton } from "@/components/ui/skeleton";
import { FileViewerModal } from '@/components/thread/file-viewer-modal';

import { ToolCallSidePanel, ToolCallInput } from "@/components/thread/tool-call-side-panel";
import { useAgentStream } from '@/hooks/useAgentStream';
import { Markdown } from '@/components/ui/markdown';
import { cn } from "@/lib/utils";

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
  // Generate a unique timestamp for this render to avoid key conflicts
  const timestamp = Date.now();

  // If no XML tags found, just return the full content as markdown
  if (!content.match(xmlRegex)) {
    return <Markdown className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none">{content}</Markdown>;
  }

  while ((match = xmlRegex.exec(content)) !== null) {
    // Add text before the tag as markdown
    if (match.index > lastIndex) {
      const textBeforeTag = content.substring(lastIndex, match.index);
      contentParts.push(
        <Markdown key={`md-${lastIndex}-${timestamp}`} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none inline-block mr-1">{textBeforeTag}</Markdown>
      );
    }

    const rawXml = match[0];
    const toolName = match[1] || match[2];
    const IconComponent = getToolIcon(toolName);
    const paramDisplay = extractPrimaryParam(toolName, rawXml);
    const toolCallKey = `tool-${match.index}-${timestamp}`;

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
        <div key={`ask-${match.index}-${timestamp}`} className="space-y-3">
          <Markdown className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3">{askContent}</Markdown>
          
          {attachments.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Attachments:</div>
              <div className="flex flex-wrap gap-2">
                {attachments.map((attachment, idx) => {
                  const extension = attachment.split('.').pop()?.toLowerCase();
                  const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(extension || '');
                  const isPdf = extension === 'pdf';
                  const isMd = extension === 'md';
                  const isCode = ['js', 'jsx', 'ts', 'tsx', 'py', 'html', 'css', 'json'].includes(extension || '');
                  
                  let icon = <File className="h-3.5 w-3.5 text-muted-foreground" />;
                  if (isImage) icon = <File className="h-3.5 w-3.5 text-purple-500" />;
                  if (isPdf) icon = <File className="h-3.5 w-3.5 text-red-500" />;
                  if (isMd) icon = <File className="h-3.5 w-3.5 text-blue-500" />;
                  if (isCode) icon = <File className="h-3.5 w-3.5 text-emerald-500" />;
                  
                  return (
                    <button
                      key={`attachment-${idx}-${timestamp}`}
                      onClick={() => fileViewerHandler?.(attachment)}
                      className="group inline-flex items-center gap-2 rounded-md border bg-muted/5 px-2.5 py-1.5 text-sm transition-colors hover:bg-muted/10"
                    >
                      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border bg-background">
                        {icon}
                      </div>
                      <div className="flex-1 overflow-hidden">
                        <div className="font-medium truncate max-w-[120px]">
                          {attachment.split('/').pop()}
                        </div>
                      </div>
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
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
      <Markdown key={`md-${lastIndex}-${timestamp}`} className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none">{content.substring(lastIndex)}</Markdown>
    );
  }

  return contentParts;
}

export default function ThreadPage({ params }: { params: Promise<ThreadParams> }) {
  const unwrappedParams = React.use(params);
  const threadId = unwrappedParams.threadId;
  
  const router = useRouter();
  const [messages, setMessages] = useState<UnifiedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agentRunId, setAgentRunId] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<'idle' | 'running' | 'connecting' | 'error'>('idle');
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(true);
  const [toolCalls, setToolCalls] = useState<ToolCallInput[]>([]);
  const [currentToolIndex, setCurrentToolIndex] = useState<number>(0);
  const [autoOpenedPanel, setAutoOpenedPanel] = useState(false);
  
  // Playback control states
  const [visibleMessages, setVisibleMessages] = useState<UnifiedMessage[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMessageIndex, setCurrentMessageIndex] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(0.5); // reduced from 2 to 0.5 seconds between messages
  const [toolPlaybackIndex, setToolPlaybackIndex] = useState(-1);
  const [streamingText, setStreamingText] = useState("");
  const [isStreamingText, setIsStreamingText] = useState(false);
  const [currentToolCall, setCurrentToolCall] = useState<StreamingToolCall | null>(null);

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

  const userClosedPanelRef = useRef(false);
  
  // Initialize as if user already closed panel to prevent auto-opening
  useEffect(() => {
    userClosedPanelRef.current = true;
    // Initially hide the side panel
    setIsSidePanelOpen(false);
  }, []);

  // Define togglePlayback and resetPlayback functions explicitly
  const togglePlayback = useCallback(() => {
    setIsPlaying(prev => {
      if (!prev) {
        // When starting playback, show the side panel
        setIsSidePanelOpen(true);
      }
      return !prev;
    });
  }, []);

  const resetPlayback = useCallback(() => {
    setIsPlaying(false);
    setCurrentMessageIndex(0);
    setVisibleMessages([]);
    setToolPlaybackIndex(-1);
    setStreamingText("");
    setIsStreamingText(false);
    setCurrentToolCall(null);
    // Hide the side panel when resetting
    setIsSidePanelOpen(false);
  }, []);

  const toggleSidePanel = useCallback(() => {
    setIsSidePanelOpen(prev => !prev);
  }, []);

  const handleSidePanelNavigate = useCallback((newIndex: number) => {
    setCurrentToolIndex(newIndex);
    console.log(`Tool panel manually set to index ${newIndex}`);
  }, []);

  const handleNewMessageFromStream = useCallback((message: UnifiedMessage) => {
    // Log the ID of the message received from the stream
    console.log(`[STREAM HANDLER] Received message: ID=${message.message_id}, Type=${message.type}`);
    if (!message.message_id) {
        console.warn(`[STREAM HANDLER] Received message is missing ID: Type=${message.type}, Content=${message.content?.substring(0, 50)}...`);
    }
    
    setMessages(prev => {
      // First check if the message already exists
      const messageExists = prev.some(m => m.message_id === message.message_id);
      if (messageExists) {
        // If it exists, update it instead of adding a new one
        return prev.map(m => m.message_id === message.message_id ? message : m);
      } else {
        // If it's a new message, add it to the end
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
        setAgentStatus('idle');
        setAgentRunId(null);
        // Reset auto-opened state when agent completes to trigger tool detection
        setAutoOpenedPanel(false);
        
        // Refetch messages to ensure we have the final state after completion OR stopping
        if (hookStatus === 'completed' || hookStatus === 'stopped') {
          getMessages(threadId).then(messagesData => {
            if (messagesData) {
              console.log(`[PAGE] Refetched messages after ${hookStatus}:`, messagesData.length);
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
              scrollToBottom('smooth');
            }
          }).catch(err => {
            console.error(`Error refetching messages after ${hookStatus}:`, err);
          });
        }
        break;
      case 'connecting':
        setAgentStatus('connecting');
        break;
      case 'streaming':
        setAgentStatus('running');
        break;
      case 'error':
        setAgentStatus('error');
        // Handle errors by going back to idle state after a short delay
        setTimeout(() => {
          setAgentStatus('idle');
          setAgentRunId(null);
        }, 3000);
        break;
    }
  }, [threadId]);

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

  // Streaming text function
  const streamText = useCallback((text: string, onComplete: () => void) => {
    if (!text || !isPlaying) {
      onComplete();
      return () => {};
    }
    
    setIsStreamingText(true);
    setStreamingText("");
    
    // Define regex to find tool calls in text
    const toolCallRegex = /<([a-zA-Z\-_]+)(?:\s+[^>]*)?>(?:[\s\S]*?)<\/\1>|<([a-zA-Z\-_]+)(?:\s+[^>]*)?\/>/g;
    
    // Split text into chunks (handling tool calls as special chunks)
    const chunks: { text: string; isTool: boolean; toolName?: string }[] = [];
    let lastIndex = 0;
    let match;
    
    while ((match = toolCallRegex.exec(text)) !== null) {
      // Add text before the tool call
      if (match.index > lastIndex) {
        chunks.push({
          text: text.substring(lastIndex, match.index),
          isTool: false
        });
      }
      
      // Add the tool call
      const toolName = match[1] || match[2];
      chunks.push({
        text: match[0],
        isTool: true,
        toolName
      });
      
      lastIndex = toolCallRegex.lastIndex;
    }
    
    // Add any remaining text after the last tool call
    if (lastIndex < text.length) {
      chunks.push({
        text: text.substring(lastIndex),
        isTool: false
      });
    }
    
    let currentIndex = 0;
    let chunkIndex = 0;
    let currentText = '';
    let isPaused = false;
    
    const processNextCharacter = () => {
      if (!isPlaying || isPaused) {
        setTimeout(processNextCharacter, 100); // Check again after a short delay
        return;
      }
      
      if (chunkIndex >= chunks.length) {
        // All chunks processed, we're done
        setIsStreamingText(false);
        
        // Update visible messages with the complete message
        const currentMessage = messages[currentMessageIndex];
        setVisibleMessages(prev => {
          const lastMessage = prev[prev.length - 1];
          if (lastMessage?.message_id === currentMessage.message_id) {
            // Replace the streaming message with the complete one
            return [...prev.slice(0, -1), currentMessage];
          } else {
            // Add the complete message
            return [...prev, currentMessage];
          }
        });
        
        onComplete();
        return;
      }
      
      const currentChunk = chunks[chunkIndex];
      
      // If this is a tool call chunk and we're at the start of it
      if (currentChunk.isTool && currentIndex === 0) {
        // For tool calls, check if they should be hidden during streaming
        if (currentChunk.toolName && HIDE_STREAMING_XML_TAGS.has(currentChunk.toolName)) {
          // Instead of showing the XML, create a tool call object
          const toolCall: StreamingToolCall = {
            name: currentChunk.toolName,
            arguments: currentChunk.text,
            xml_tag_name: currentChunk.toolName
          };
          
          setCurrentToolCall(toolCall);
          setIsSidePanelOpen(true);
          setCurrentToolIndex(toolPlaybackIndex + 1);
          setToolPlaybackIndex(prev => prev + 1);
          
          // Pause streaming briefly while showing the tool
          isPaused = true;
          setTimeout(() => {
            isPaused = false;
            setCurrentToolCall(null);
            chunkIndex++; // Move to next chunk
            currentIndex = 0; // Reset index for next chunk
            processNextCharacter();
          }, 500); // Reduced from 1500ms to 500ms pause for tool display
          
          return;
        }
      }
      
      // Handle normal text streaming for non-tool chunks or visible tool chunks
      if (currentIndex < currentChunk.text.length) {
        // Dynamically adjust typing speed for a more realistic effect
        const baseDelay = 5; // Reduced from 15ms to 5ms
        let typingDelay = baseDelay;
        
        // Add more delay for punctuation to make it feel more natural
        const char = currentChunk.text[currentIndex];
        if (".!?,;:".includes(char)) {
          typingDelay = baseDelay + Math.random() * 100 + 50; // Reduced from 300+100 to 100+50ms pause after punctuation
        } else {
          const variableDelay = Math.random() * 5; // Reduced from 15 to 5ms
          typingDelay = baseDelay + variableDelay; // 5-10ms for normal typing
        }
        
        // Add the next character
        currentText += currentChunk.text[currentIndex];
        setStreamingText(currentText);
        currentIndex++;
        
        // Process next character with dynamic delay
        setTimeout(processNextCharacter, typingDelay);
      } else {
        // Move to the next chunk
        chunkIndex++;
        currentIndex = 0;
        processNextCharacter();
      }
    };
    
    processNextCharacter();
    
    // Return cleanup function
    return () => {
      setIsStreamingText(false);
      setStreamingText("");
      isPaused = true; // Stop processing
    };
  }, [isPlaying, messages, currentMessageIndex]);
  
  // Main playback function
  useEffect(() => {
    if (!isPlaying || messages.length === 0) return;
    
    let playbackTimeout: NodeJS.Timeout;
    
    const playbackNextMessage = async () => {
      // Ensure we're within bounds
      if (currentMessageIndex >= messages.length) {
        setIsPlaying(false);
        return;
      }
      
      const currentMessage = messages[currentMessageIndex];
      console.log(`Playing message ${currentMessageIndex}:`, currentMessage.type, currentMessage.message_id);
      
      // If it's an assistant message, stream it
      if (currentMessage.type === 'assistant') {
        try {
          // Parse the content if it's JSON
          let content = currentMessage.content;
          try {
            const parsed = JSON.parse(content);
            if (parsed.content) {
              content = parsed.content;
            }
          } catch (e) {
            // Not JSON, use as is
          }
          
          // Stream the message content
          await new Promise<void>((resolve) => {
            const cleanupFn = streamText(content, resolve);
            return cleanupFn;
          });
        } catch (error) {
          console.error('Error streaming message:', error);
        }
      } else {
        // For non-assistant messages, just add them to visible messages
        setVisibleMessages(prev => [...prev, currentMessage]);
        
        // Wait a moment before showing the next message
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      // Move to the next message
      setCurrentMessageIndex(prevIndex => prevIndex + 1);
    };
    
    // Start playback with a small delay
    playbackTimeout = setTimeout(playbackNextMessage, 500);
    
    return () => {
      clearTimeout(playbackTimeout);
    };
  }, [isPlaying, currentMessageIndex, messages, streamText]);

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

        // Fetch the thread to check if it's public
        const threadData = await getThread(threadId).catch(err => { 
          // If it fails with 404, we'll catch it here
          throw new Error('Failed to load thread data: ' + err.message); 
        });
        
        if (!isMounted) return;
        
        // Make sure the thread is public
        // if (!(threadData as any).is_public) {
        //   throw new Error('This thread is not available for public viewing.');
        // }
        
        if (threadData?.project_id) {
          try {
            const projectData = await getProject(threadData.project_id);
            if (isMounted && projectData) {
              console.log('[SHARE] Project data loaded:', projectData);
              
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
          } catch (projectError) {
            // Don't throw an error if project can't be loaded
            // Just log it and continue with the thread
            console.warn('[SHARE] Could not load project data:', projectError);
            // Set a generic name if we couldn't load the project
            setProjectName('Shared Conversation');
          }
        }

        // Fetch all messages for the thread
        const messagesData = await getMessages(threadId);
        if (isMounted) {
          // Log raw messages fetched from API
          console.log('[SHARE] Raw messages fetched:', messagesData);
          
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
          
          // Calculate historical tool pairs
          const historicalToolPairs: ToolCallInput[] = [];
          const assistantMessages = unifiedMessages.filter(m => m.type === 'assistant' && m.message_id);
          
          console.log('Building tool calls from', assistantMessages.length, 'assistant messages');
          
          // Map to track which assistant messages have tool results
          const assistantToolMap = new Map<string, UnifiedMessage>();
          
          // First build a map of assistant message IDs to tool messages
          unifiedMessages.forEach(msg => {
            if (msg.type === 'tool' && msg.metadata) {
              try {
                const metadata = JSON.parse(msg.metadata);
                if (metadata.assistant_message_id) {
                  assistantToolMap.set(metadata.assistant_message_id, msg);
                }
              } catch (e) {
                // Ignore parsing errors
              }
            }
          });
          
          console.log('Found', assistantToolMap.size, 'tool messages with assistant IDs');
          
          // Now process each assistant message
          assistantMessages.forEach((assistantMsg, index) => {
            // Get message ID
            const messageId = assistantMsg.message_id;
            if (!messageId) return;
            
            console.log(`Processing assistant message ${index}:`, messageId);
            
            // Find corresponding tool message
            const toolMessage = assistantToolMap.get(messageId);
            
            // Check for tool calls in the assistant message content
            let assistantContent: any;
            try {
              assistantContent = JSON.parse(assistantMsg.content);
            } catch (e) {
              assistantContent = { content: assistantMsg.content };
            }
            
            const assistantMessageText = assistantContent.content || assistantMsg.content;
            
            // Use a regex to find tool calls in the message content
            const toolCalls = extractToolCallsFromMessage(assistantMessageText);
            console.log(`Found ${toolCalls.length} tool calls in message ${messageId}`);
            
            if (toolCalls.length > 0 && toolMessage) {
              // For each tool call in the message, create a pair
              toolCalls.forEach((toolCall, callIndex) => {
                console.log(`Adding tool call ${callIndex}:`, toolCall.name, 'for message', messageId);
                
                let toolContent: any;
                try {
                  toolContent = JSON.parse(toolMessage.content);
                } catch (e) {
                  toolContent = { content: toolMessage.content };
                }
                
                historicalToolPairs.push({
                  assistantCall: {
                    name: toolCall.name,
                    content: `${toolCall.fullMatch}<!-- messageId:${messageId} -->`,
                    timestamp: assistantMsg.created_at
                  },
                  toolResult: {
                    content: toolContent.content || toolMessage.content,
                    isSuccess: true,
                    timestamp: toolMessage.created_at
                  }
                });
              });
            }
          });
          
          // Sort the tool calls chronologically by timestamp
          historicalToolPairs.sort((a, b) => {
            const timeA = new Date(a.assistantCall.timestamp || '').getTime();
            const timeB = new Date(b.assistantCall.timestamp || '').getTime();
            return timeA - timeB;
          });
          
          console.log('Created', historicalToolPairs.length, 'total tool calls');
          
          setToolCalls(historicalToolPairs);
          
          // When loading is complete, prepare for playback
          initialLoadCompleted.current = true;
        }
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

  // Auto-scroll when new messages appear during playback
  useEffect(() => {
    if (visibleMessages.length > 0 && !userHasScrolled) {
      scrollToBottom('smooth');
    }
  }, [visibleMessages, userHasScrolled]);

  // Scroll button visibility
  useEffect(() => {
    if (!latestMessageRef.current || visibleMessages.length === 0) return;
    const observer = new IntersectionObserver(
      ([entry]) => setShowScrollButton(!entry?.isIntersecting),
      { root: messagesContainerRef.current, threshold: 0.1 }
    );
    observer.observe(latestMessageRef.current);
    return () => observer.disconnect();
  }, [visibleMessages, streamingText, currentToolCall]);

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
        if (toolName === 'ask') {
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
    if (toolName === 'ask') {
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
      document.title = `${projectName} | Shared Thread`;
      
      const metaDescription = document.querySelector('meta[name="description"]');
      if (metaDescription) {
        metaDescription.setAttribute('content', `${projectName} - Public AI conversation shared from Kortix Suna`);
      }
      
      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) {
        ogTitle.setAttribute('content', `${projectName} | Shared AI Conversation`);
      }
      
      const ogDescription = document.querySelector('meta[property="og:description"]');
      if (ogDescription) {
        ogDescription.setAttribute('content', `Public AI conversation of ${projectName}`);
      }
    }
  }, [projectName]);

  useEffect(() => {
    if (streamingTextContent && streamHookStatus === 'streaming' && messages.length > 0) {
      // Find the last assistant message to update with streaming content
      const lastAssistantIndex = messages.findIndex(m => 
        m.type === 'assistant' && m.message_id === messages[currentMessageIndex]?.message_id);
      
      if (lastAssistantIndex >= 0) {
        const assistantMessage = {...messages[lastAssistantIndex]};
        assistantMessage.content = streamingTextContent;
        
        // Update the message in the messages array
        const updatedMessages = [...messages];
        updatedMessages[lastAssistantIndex] = assistantMessage;
        
        // Only show the streaming message if we're not already streaming and we're in play mode
        if (!isStreamingText && isPlaying) {
          const cleanup = streamText(streamingTextContent, () => {
            // When streaming completes, update the visible messages
            setVisibleMessages(prev => {
              const messageExists = prev.some(m => m.message_id === assistantMessage.message_id);
              if (messageExists) {
                // Replace the existing message
                return prev.map(m => m.message_id === assistantMessage.message_id ? assistantMessage : m);
              } else {
                // Add as a new message
                return [...prev, assistantMessage];
              }
            });
          });
          
          return cleanup;
        }
      }
    }
  }, [streamingTextContent, streamHookStatus, messages, isStreamingText, isPlaying, currentMessageIndex, streamText]);

  // Create a message-to-tool-index map for faster lookups
  const [messageToToolIndex, setMessageToToolIndex] = useState<Record<string, number>>({});
  
  // Build the message-to-tool-index map when tool calls change
  useEffect(() => {
    if (!toolCalls.length) return;
    
    const mapBuilder: Record<string, number> = {};
    
    toolCalls.forEach((tool, index) => {
      const content = tool.assistantCall?.content || '';
      const match = content.match(/<!-- messageId:([\w-]+) -->/);
      if (match && match[1]) {
        mapBuilder[match[1]] = index;
        console.log(`Mapped message ID ${match[1]} to tool index ${index}`);
      }
    });
    
    setMessageToToolIndex(mapBuilder);
  }, [toolCalls]);
  
  // Very direct approach to update the tool index during message playback
  useEffect(() => {
    if (!isPlaying || currentMessageIndex <= 0 || !messages.length) return;
    
    // Check if current message is a tool message
    const currentMsg = messages[currentMessageIndex - 1]; // Look at previous message that just played
    
    if (currentMsg?.type === 'tool' && currentMsg.metadata) {
      try {
        const metadata = safeJsonParse<ParsedMetadata>(currentMsg.metadata, {});
        const assistantId = metadata.assistant_message_id;
        
        if (assistantId && messageToToolIndex[assistantId] !== undefined) {
          const toolIndex = messageToToolIndex[assistantId];
          console.log(`Direct mapping: Setting tool index to ${toolIndex} for message ${assistantId}`);
          setCurrentToolIndex(toolIndex);
        }
      } catch (e) {
        console.error('Error in direct tool mapping:', e);
      }
    }
  }, [currentMessageIndex, isPlaying, messages, messageToToolIndex]);

  // Add a helper function to extract tool calls from message content
  const extractToolCallsFromMessage = (content: string) => {
    const toolCallRegex = /<([a-zA-Z\-_]+)(?:\s+[^>]*)?>(?:[\s\S]*?)<\/\1>|<([a-zA-Z\-_]+)(?:\s+[^>]*)?\/>/g;
    const results = [];
    let match;
    
    while ((match = toolCallRegex.exec(content)) !== null) {
      const toolName = match[1] || match[2];
      results.push({
        name: toolName,
        fullMatch: match[0]
      });
    }
    
    return results;
  };

  // Force an explicit update to the tool panel based on the current message index
  useEffect(() => {
    // Skip if not playing or no messages
    if (!isPlaying || messages.length === 0 || currentMessageIndex <= 0) return;
    
    // Get all messages up to the current index 
    const currentMessages = messages.slice(0, currentMessageIndex);
    
    // Find the most recent tool message to determine which panel to show
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      const msg = currentMessages[i];
      if (msg.type === 'tool' && msg.metadata) {
        try {
          const metadata = safeJsonParse<ParsedMetadata>(msg.metadata, {});
          const assistantId = metadata.assistant_message_id;
          
          if (assistantId) {
            console.log(`Looking for tool panel for assistant message ${assistantId}`);
            
            // Scan for matching tool call
            for (let j = 0; j < toolCalls.length; j++) {
              const content = toolCalls[j].assistantCall?.content || '';
              if (content.includes(assistantId)) {
                console.log(`Found matching tool call at index ${j}, updating panel`);
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

  // Add a special button to each tool call to show its debug info
  // This replaces the existing ToolCallSidePanel component with a wrapper that adds debug info
  const ToolCallPanelWithDebugInfo = React.useMemo(() => {
    const WrappedPanel = (props: any) => {
      const { isOpen, onClose, toolCalls, currentIndex, onNavigate, ...rest } = props;
      
      // Add a function to show debug info for the current tool call
      const showDebugInfo = useCallback(() => {
        if (toolCalls && toolCalls.length > 0 && currentIndex >= 0 && currentIndex < toolCalls.length) {
          const tool = toolCalls[currentIndex];
          console.log('Current tool call debug info:', {
            name: tool.assistantCall?.name,
            content: tool.assistantCall?.content,
            messageIdMatches: tool.assistantCall?.content?.match(/<!-- messageId:([\w-]+) -->/),
            toolResult: tool.toolResult
          });
        }
      }, [toolCalls, currentIndex]);
      
      return (
        <div>
          <ToolCallSidePanel 
            isOpen={isOpen} 
            onClose={onClose}
            toolCalls={toolCalls}
            currentIndex={currentIndex}
            onNavigate={onNavigate}
            {...rest}
          />
          
          {/* Add debug button */}
          {isOpen && toolCalls && toolCalls.length > 0 && (
            <div className="fixed bottom-4 right-4 z-50">
              <Button 
                variant="outline" 
                size="sm" 
                className="h-8 w-8 rounded-full p-0 bg-background/50 backdrop-blur"
                onClick={showDebugInfo}
              >
                <span className="sr-only">Debug</span>
                <Info className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      );
    };
    
    return WrappedPanel;
  }, []);

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
            </div>
          </div>
        </div>
        
        {/* Skeleton Side Panel (closed state) */}
        <div className={`hidden sm:block ${isSidePanelOpen ? 'block' : ''}`}>
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
          <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="flex h-14 items-center gap-4 px-4">
              <div className="flex-1">
                <span className="text-foreground font-medium">Shared Conversation</span>
              </div>
            </div>
          </div>
          <div className="flex flex-1 items-center justify-center p-4">
            <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-lg border bg-card p-6 text-center">
              <h2 className="text-lg font-semibold text-destructive">Error</h2>
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" onClick={() => router.push(`/`)}>
                Back to Home
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <div className={`flex flex-col flex-1 overflow-hidden transition-all duration-200 ease-in-out ${isSidePanelOpen ? 'mr-[90%] sm:mr-[450px] md:mr-[500px] lg:mr-[550px] xl:mr-[650px]' : ''}`}>
        {/* Header with playback controls */}
        <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="flex h-14 items-center gap-4 px-4">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <div className="flex items-center justify-center w-6 h-6 rounded-md overflow-hidden bg-primary/10">
                  <Image src="/kortix-symbol.svg" alt="Kortix" width={16} height={16} className="object-contain"/>
                </div>
                <span className="font-medium text-foreground">{projectName || 'Shared Conversation'}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleOpenFileViewer()}
                className="h-8 w-8"
                aria-label="View Files"
              >
                <File className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={togglePlayback}
                className="h-8 w-8"
                aria-label={isPlaying ? "Pause Replay" : "Play Replay"}
              >
                {isPlaying ? 
                  <Pause className="h-4 w-4" /> : 
                  <Play className="h-4 w-4" />
                }
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={resetPlayback}
                className="h-8 w-8"
                aria-label="Restart Replay"
              >
                <ArrowDown className="h-4 w-4 rotate-90" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleSidePanel}
                className={cn("h-8 w-8", isSidePanelOpen && "text-primary")}
                aria-label="Toggle Tool Panel"
              >
                <Info className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
        <div 
          ref={messagesContainerRef}
          className="flex-1 overflow-y-auto px-6 py-4 pb-8 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60"
          onScroll={handleScroll}
        >
          <div className="mx-auto max-w-3xl">
            {visibleMessages.length === 0 && !streamingText && !currentToolCall ? (
              <div className="fixed inset-0 flex flex-col items-center justify-center">
                {/* Gradient overlay */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent dark:from-black/90 dark:via-black/50 dark:to-transparent" />
                
                <div className="text-center max-w-md mx-auto relative z-10 px-4">
                  <div className="rounded-full bg-primary/10 backdrop-blur-sm w-12 h-12 mx-auto flex items-center justify-center mb-4">
                    <Play className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="text-lg font-medium mb-2 text-white">Watch this agent in action</h3>
                  <p className="text-sm text-white/80 mb-4">
                    This is a shared view-only agent run. Click play to replay the entire conversation with realistic timing.
                  </p>
                  <Button 
                    onClick={togglePlayback} 
                    className="flex items-center mx-auto bg-white/10 hover:bg-white/20 backdrop-blur-sm text-white border-white/20"
                    size="lg"
                    variant="outline"
                  >
                    <Play className="h-4 w-4 mr-2" /> 
                    Start Playback
                  </Button>
                </div>
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

                  visibleMessages.forEach((message, index) => {
                    const messageType = message.type;
                    const key = message.message_id ? `${message.message_id}-${index}` : `msg-${index}`;

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
                      
                      return (
                        <div key={group.key} className="flex justify-end">
                          <div className="inline-flex max-w-[85%] rounded-lg bg-primary/10 px-4 py-3">
                            <Markdown className="text-sm prose prose-sm dark:prose-invert chat-markdown max-w-none [&>:first-child]:mt-0 prose-headings:mt-3">{messageContent}</Markdown>
                          </div>
                        </div>
                      );
                    } else if (group.type === 'assistant_group') {
                      return (
                        <div key={group.key} ref={groupIndex === groupedMessages.length - 1 ? latestMessageRef : null}>
                          <div className="flex items-start gap-3">
                            <div className="flex-shrink-0 w-5 h-5 mt-2 rounded-md flex items-center justify-center overflow-hidden bg-primary/10">
                              <Image src="/kortix-symbol.svg" alt="Suna" width={14} height={14} className="object-contain"/>
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
                                        const msgKey = message.message_id ? `${message.message_id}-${msgIndex}` : `submsg-assistant-${msgIndex}`;

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

                                  {groupIndex === groupedMessages.length - 1 && isStreamingText && (
                                    <div className="mt-2"> 
                                      {(() => {
                                          let detectedTag: string | null = null;
                                          let tagStartIndex = -1;
                                          if (streamingText) {
                                              for (const tag of HIDE_STREAMING_XML_TAGS) {
                                                  const openingTagPattern = `<${tag}`;
                                                  const index = streamingText.indexOf(openingTagPattern);
                                                  if (index !== -1) {
                                                      detectedTag = tag;
                                                      tagStartIndex = index;
                                                      break;
                                                  }
                                              }
                                          }

                                          const textToRender = streamingText || '';
                                          const textBeforeTag = detectedTag ? textToRender.substring(0, tagStartIndex) : textToRender;
                                          const showCursor = isStreamingText && !detectedTag;

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
                
                {/* Show tool call animation if active */}
                {currentToolCall && (
                  <div ref={latestMessageRef}>
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 w-5 h-5 mt-2 rounded-md flex items-center justify-center overflow-hidden bg-primary/10">
                        <Image src="/kortix-symbol.svg" alt="Suna" width={14} height={14} className="object-contain"/>
                      </div>
                      <div className="flex-1 space-y-2">
                        <div className="inline-flex items-center gap-1.5 py-1.5 px-3 text-xs font-medium text-primary bg-primary/10 rounded-md border border-primary/20">
                          <CircleDashed className="h-3.5 w-3.5 text-primary flex-shrink-0 animate-spin animation-duration-2000" />
                          <span className="font-mono text-xs text-primary">
                            {currentToolCall.name || 'Using Tool'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Show streaming indicator if no messages yet */}
                {visibleMessages.length === 0 && isStreamingText && (
                  <div ref={latestMessageRef}>
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 w-5 h-5 mt-2 rounded-md flex items-center justify-center overflow-hidden bg-primary/10">
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
        
        {/* Floating playback controls - moved to be centered in the chat area when side panel is open */}
        {messages.length > 0 && (
          <div className={`fixed bottom-4 z-10 transform bg-background/90 backdrop-blur rounded-full border shadow-md px-3 py-1.5 transition-all duration-200 ${
            isSidePanelOpen 
              ? 'left-1/2 -translate-x-1/4 sm:left-[calc(50%-225px)] md:left-[calc(50%-250px)] lg:left-[calc(50%-275px)] xl:left-[calc(50%-325px)]' 
              : 'left-1/2 -translate-x-1/2'
          }`}>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                onClick={togglePlayback}
                className="h-8 w-8"
              >
                {isPlaying ? 
                  <Pause className="h-4 w-4" /> : 
                  <Play className="h-4 w-4" />
                }
              </Button>
              
              <div className="flex items-center text-xs text-muted-foreground">
                <span>{Math.min(currentMessageIndex + (isStreamingText ? 0 : 1), messages.length)}/{messages.length}</span>
              </div>
              
              <Button
                variant="ghost"
                size="icon"
                onClick={resetPlayback}
                className="h-8 w-8"
              >
                <ArrowDown className="h-4 w-4 rotate-90" />
              </Button>
              
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIsPlaying(false);
                  setCurrentMessageIndex(messages.length);
                  setVisibleMessages(messages);
                  setToolPlaybackIndex(toolCalls.length - 1);
                  setStreamingText("");
                  setIsStreamingText(false);
                  setCurrentToolCall(null);
                  if (toolCalls.length > 0) {
                    setCurrentToolIndex(toolCalls.length - 1);
                    setIsSidePanelOpen(true);
                  }
                }}
                className="text-xs"
              >
                Skip to end
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Scroll to bottom button */}
      {showScrollButton && (
        <Button
          variant="outline"
          size="icon"
          className="fixed bottom-20 right-6 z-10 h-8 w-8 rounded-full shadow-md"
          onClick={handleScrollButtonClick}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
      )}

      {/* Tool calls side panel - Replace with debug-enabled version */}
      <ToolCallPanelWithDebugInfo
        isOpen={isSidePanelOpen} 
        onClose={() => setIsSidePanelOpen(false)}
        toolCalls={toolCalls}
        messages={messages as ApiMessageType[]}
        agentStatus="idle"
        currentIndex={currentToolIndex}
        onNavigate={handleSidePanelNavigate}
        project={project}
        renderAssistantMessage={toolViewAssistant}
        renderToolResult={toolViewResult}
      />

      {/* Show FileViewerModal regardless of sandboxId availability */}
      <FileViewerModal
        open={fileViewerOpen}
        onOpenChange={setFileViewerOpen}
        sandboxId={sandboxId || ""}
        initialFilePath={fileToView}
        project={project}
      />
    </div>
  );
}