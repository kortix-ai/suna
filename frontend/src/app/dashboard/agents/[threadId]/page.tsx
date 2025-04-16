'use client';

import React, { useState, useEffect, useCallback, useRef, useContext } from "react";
import { getProject, getMessages, getThread, addUserMessage, startAgent, stopAgent, getAgentRuns, streamAgent, type Message, type Project, type Thread, type AgentRun } from "@/lib/api";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SUPPORTED_XML_TAGS } from "@/lib/types/tool-calls";
import { ToolCallsContext } from "@/app/providers";
import { BillingErrorAlert } from "@/components/billing/BillingErrorAlert";
import { useBillingError } from "@/hooks/useBillingError";
import { MessageList } from "@/components/thread/message-list";
import { ChatInput } from "@/components/thread/chat-input";

interface AgentPageProps {
  params: {
    threadId: string;
  };
}

// Parse XML tags in content
function parseXMLTags(content: string): { parts: any[], openTags: Record<string, any> } {
  const parts: any[] = [];
  const openTags: Record<string, any> = {};
  const tagStack: Array<{tagName: string, position: number}> = [];
  
  // Find all opening and closing tags
  let currentPosition = 0;
  
  // Match opening tags with attributes like <tag-name attr="value">
  const openingTagRegex = new RegExp(`<(${SUPPORTED_XML_TAGS.join('|')})\\s*([^>]*)>`, 'g');
  // Match closing tags like </tag-name>
  const closingTagRegex = new RegExp(`</(${SUPPORTED_XML_TAGS.join('|')})>`, 'g');
  
  let match: RegExpExecArray | null;
  let matches: { regex: RegExp, match: RegExpExecArray, isOpening: boolean, position: number }[] = [];
  
  // Find all opening tags
  while ((match = openingTagRegex.exec(content)) !== null) {
    matches.push({ 
      regex: openingTagRegex, 
      match, 
      isOpening: true, 
      position: match.index 
    });
  }
  
  // Find all closing tags
  while ((match = closingTagRegex.exec(content)) !== null) {
    matches.push({ 
      regex: closingTagRegex, 
      match, 
      isOpening: false, 
      position: match.index 
    });
  }
  
  // Sort matches by their position in the content
  matches.sort((a, b) => a.position - b.position);
  
  // Process matches in order
  for (const { match, isOpening, position } of matches) {
    const tagName = match[1];
    const matchEnd = position + match[0].length;
    
    // Add text before this tag if needed
    if (position > currentPosition) {
      parts.push(content.substring(currentPosition, position));
    }
    
    if (isOpening) {
      // Parse attributes for opening tags
      const attributesStr = match[2]?.trim();
      const attributes: Record<string, string> = {};
      
      if (attributesStr) {
        // Match attributes in format: name="value" or name='value'
        const attrRegex = /(\w+)=["']([^"']*)["']/g;
        let attrMatch;
        while ((attrMatch = attrRegex.exec(attributesStr)) !== null) {
          attributes[attrMatch[1]] = attrMatch[2];
        }
      }
      
      // Create tag object with unique ID
      const parsedTag: any = {
        tagName,
        attributes,
        content: '',
        isClosing: false,
        id: `${tagName}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        rawMatch: match[0]
      };
      
      // Add timestamp if not present
      if (!parsedTag.timestamp) {
        parsedTag.timestamp = Date.now();
      }
      
      // Push to parts and track in stack
      parts.push(parsedTag);
      tagStack.push({ tagName, position: parts.length - 1 });
      openTags[tagName] = parsedTag;
      
    } else {
      // Handle closing tag
      // Find the corresponding opening tag in the stack (last in, first out)
      let foundOpeningTag = false;
      
      for (let i = tagStack.length - 1; i >= 0; i--) {
        if (tagStack[i].tagName === tagName) {
          const openTagIndex = tagStack[i].position;
          const openTag = parts[openTagIndex] as any;
          
          // Get content between this opening and closing tag pair
          const contentStart = position;
          let tagContentStart = openTagIndex + 1;
          let tagContentEnd = parts.length;
          
          // Mark that we need to capture content between these positions
          let contentToCapture = '';
          
          // Collect all content parts between the opening and closing tags
          for (let j = tagContentStart; j < tagContentEnd; j++) {
            if (typeof parts[j] === 'string') {
              contentToCapture += parts[j];
            }
          }
          
          // Try getting content directly from original text (most reliable approach)
          const openTagMatch = openTag.rawMatch || '';
          const openTagPosition = content.indexOf(openTagMatch, Math.max(0, openTagIndex > 0 ? currentPosition - 200 : 0));
          if (openTagPosition >= 0) {
            const openTagEndPosition = openTagPosition + openTagMatch.length;
            // Only use if the positions make sense
            if (openTagEndPosition > 0 && position > openTagEndPosition) {
              // Get content and clean up excessive whitespace but preserve formatting
              let extractedContent = content.substring(openTagEndPosition, position);
              
              // Trim leading newline if present
              if (extractedContent.startsWith('\n')) {
                extractedContent = extractedContent.substring(1);
              }
              
              // Trim trailing newline if present
              if (extractedContent.endsWith('\n')) {
                extractedContent = extractedContent.substring(0, extractedContent.length - 1);
              }
              
              contentToCapture = extractedContent;
              
              // Debug info in development
              console.log(`[XML Parse] Extracted content for ${tagName}:`, contentToCapture);
            }
          }
          
          // Update opening tag with collected content
          openTag.content = contentToCapture;
          openTag.isClosing = true;
          
          // Remove all parts between the opening tag and this position
          // because they're now captured in the tag's content
          if (tagContentStart < tagContentEnd) {
            parts.splice(tagContentStart, tagContentEnd - tagContentStart);
          }
          
          // Remove this tag from the stack
          tagStack.splice(i, 1);
          // Remove from openTags
          delete openTags[tagName];
          
          foundOpeningTag = true;
          break;
        }
      }
      
      // If no corresponding opening tag found, add closing tag as text
      if (!foundOpeningTag) {
        parts.push(match[0]);
      }
    }
    
    currentPosition = matchEnd;
  }
  
  // Add any remaining text
  if (currentPosition < content.length) {
    parts.push(content.substring(currentPosition));
  }
  
  return { parts, openTags };
}

// Chat container component to reduce duplication
function ChatContainer({ 
  children, 
  messages, 
  streamContent, 
  isStreaming, 
  isAgentRunning, 
  agent, 
  onSendMessage, 
  isSending, 
  conversation, 
  onStopAgent,
  userMessage,
  setUserMessage 
}: {
  children?: React.ReactNode;
  messages: Message[];
  streamContent: string;
  isStreaming: boolean;
  isAgentRunning: boolean;
  agent: Project | null;
  onSendMessage: (message: string) => void;
  isSending: boolean;
  conversation: Thread | null;
  onStopAgent: () => void;
  userMessage: string;
  setUserMessage: (message: string) => void;
}) {
  return (
    <div className="flex flex-col h-[calc(100vh-5.5rem)] overflow-hidden">
      {children}
      <MessageList
        messages={messages}
        streamContent={streamContent}
        isStreaming={isStreaming}
        isAgentRunning={isAgentRunning}
        agentName={agent?.name}
      />
      
      <div className="sticky bottom-0 w-full bg-background/80 backdrop-blur-sm pt-2 pb-3 border-t border-zinc-200 dark:border-zinc-800">
        <div className="w-full max-w-3xl mx-auto px-4">
          <ChatInput
            onSubmit={onSendMessage}
            loading={isSending}
            disabled={!conversation}
            isAgentRunning={isAgentRunning}
            onStopAgent={onStopAgent}
            value={userMessage}
            onChange={setUserMessage}
          />
        </div>
      </div>
    </div>
  );
}

export default function AgentPage({ params }: AgentPageProps) {
  const resolvedParams = React.use(params as any) as { threadId: string };
  const { threadId } = resolvedParams;
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialMessage = searchParams.get('message');
  const streamCleanupRef = useRef<(() => void) | null>(null);
  
  // State
  const [agent, setAgent] = useState<Project | null>(null);
  const [conversation, setConversation] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<React.ReactNode | null>(null);
  const [userMessage, setUserMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState("");
  const [currentAgentRunId, setCurrentAgentRunId] = useState<string | null>(null);
  
  // Get tool calls context
  const { toolCalls, setToolCalls } = useContext(ToolCallsContext);
  const { billingError, handleBillingError, clearBillingError } = useBillingError();
  
  // Process messages and stream for tool calls
  useEffect(() => {
    // Extract tool calls from all messages
    const allContent = [...messages.map(msg => msg.content), streamContent].filter(Boolean);
    
    // Create a new array of tags with a better deduplication strategy
    const extractedTags: any[] = [];
    const seenTagIds = new Set<string>();
    
    // Process content to extract tools
    allContent.forEach((content, idx) => {
      const { parts, openTags } = parseXMLTags(content);
      
      // Mark tool calls vs results based on position and sender
      const isUserMessage = idx % 2 === 0;
      
      // Process all parts to mark as tool calls or results
      parts.forEach(part => {
        if (typeof part !== 'string') {
          // Create a unique ID for this tag if not present
          if (!part.id) {
            part.id = `${part.tagName}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
          }
          
          // Add timestamp if not present
          if (!part.timestamp) {
            part.timestamp = Date.now();
          }
          
          // Mark as tool call or result
          part.isToolCall = !isUserMessage;
          part.status = part.isClosing ? 'completed' : 'running';
          
          // Check if this is a browser-related tool and add VNC preview
          if (part.tagName.includes('browser') && agent?.sandbox?.vnc_preview) {
            part.vncPreview = agent.sandbox.vnc_preview + "/vnc_lite.html?password=" + agent.sandbox.pass;
          }
          
          // Use ID for deduplication
          if (!seenTagIds.has(part.id)) {
            seenTagIds.add(part.id);
            extractedTags.push(part);
          }
        }
      });
      
      // Also add any open tags
      Object.values(openTags).forEach(tag => {
        // Create a unique ID for this tag if not present
        if (!tag.id) {
          tag.id = `${tag.tagName}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        }
        
        // Add timestamp if not present
        if (!tag.timestamp) {
          tag.timestamp = Date.now();
        }
        
        // Mark as tool call or result
        tag.isToolCall = !isUserMessage;
        tag.status = tag.isClosing ? 'completed' : 'running';
        
        // Check if this is a browser-related tool and add VNC preview
        if (tag.tagName.includes('browser') && agent?.sandbox?.vnc_preview) {
          tag.vncPreview = agent.sandbox.vnc_preview + "/vnc_lite.html?password=" + agent.sandbox.pass;
        }
        
        // Use ID for deduplication
        if (!seenTagIds.has(tag.id)) {
          seenTagIds.add(tag.id);
          extractedTags.push(tag);
        }
      });
    });
    
    // Sort the tools by timestamp (oldest first)
    extractedTags.sort((a, b) => {
      if (a.timestamp && b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return 0;
    });
    
    // Try to pair tool calls with their results
    const pairedTags: any[] = [];
    const callsByTagName: Record<string, any[]> = {};
    
    // Group by tag name first
    extractedTags.forEach(tag => {
      if (!callsByTagName[tag.tagName]) {
        callsByTagName[tag.tagName] = [];
      }
      callsByTagName[tag.tagName].push(tag);
    });
    
    // For each tag type, try to pair calls with results
    Object.values(callsByTagName).forEach(tagGroup => {
      const toolCalls = tagGroup.filter(tag => tag.isToolCall);
      const toolResults = tagGroup.filter(tag => !tag.isToolCall);
      
      // Try to match each tool call with a result
      toolCalls.forEach(toolCall => {
        // Find the nearest matching result (by timestamp)
        const matchingResult = toolResults.find(result => 
          !result.isPaired && result.attributes && 
          Object.keys(toolCall.attributes).every(key => 
            toolCall.attributes[key] === result.attributes[key]
          )
        );
        
        if (matchingResult) {
          // Pair them
          toolCall.resultTag = matchingResult;
          toolCall.isPaired = true;
          toolCall.status = 'completed';
          matchingResult.isPaired = true;
          
          // Add to paired list
          pairedTags.push(toolCall);
        } else {
          // No result yet, tool call is still running
          toolCall.status = 'running';
          pairedTags.push(toolCall);
        }
      });
      
      // Add any unpaired results
      toolResults.filter(result => !result.isPaired).forEach(result => {
        pairedTags.push(result);
      });
    });
    
    // Update tool calls in the shared context
    setToolCalls(pairedTags);
  }, [messages, streamContent, setToolCalls, agent]);
  
  // Load initial data
  useEffect(() => {
    async function loadData() {
      setIsLoading(true);
      setError(null);
      
      try {
        // Check if we're creating a new conversation or using an existing one
        if (threadId === 'new') {
          router.push('/dashboard');
          return;
        } else {
          // Load existing conversation (thread) data
          const conversationData = await getThread(threadId);
          setConversation(conversationData);
          
          if (conversationData && conversationData.project_id) {
            // Load agent (project) data
            const agentData = await getProject(conversationData.project_id);
            setAgent(agentData);
            
            // Only load messages and agent runs if we have a valid thread
            const messagesData = await getMessages(threadId);
            setMessages(messagesData);
            
            const agentRunsData = await getAgentRuns(threadId);
            setAgentRuns(agentRunsData);
            
            // Check if there's a running agent run
            const runningAgent = agentRunsData.find(run => run.status === "running");
            if (runningAgent) {
              setCurrentAgentRunId(runningAgent.id);
              handleStreamAgent(runningAgent.id);
            }
          }
        }
      } catch (err: any) {
        console.error("Error loading conversation data:", err);
        
        // Handle permission errors specifically
        if (err.code === '42501' && err.message?.includes('has_role_on_account')) {
          setError("You don't have permission to access this conversation");
        } else {
          setError(err instanceof Error ? err.message : "An error occurred loading the conversation");
        }
      } finally {
        setIsLoading(false);
      }
    }
    
    loadData();
    
    // Clean up streaming on component unmount
    return () => {
      if (streamCleanupRef.current) {
        streamCleanupRef.current();
        streamCleanupRef.current = null;
      }
    };
  }, [threadId, initialMessage, router]);
  
  // Handle streaming agent responses
  const handleStreamAgent = useCallback((agentRunId: string) => {
    // Clean up any existing stream first
    if (streamCleanupRef.current) {
      streamCleanupRef.current();
      streamCleanupRef.current = null;
    }
    
    setIsStreaming(true);
    setStreamContent("");
    
    const cleanup = streamAgent(agentRunId, {
      onMessage: (rawData: string) => {
        try {
          // Handle data: prefix format (SSE standard)
          let processedData = rawData;
          let jsonData: {
            type?: string;
            status?: string;
            content?: string;
            message?: string;
          } | null = null;
          
          if (rawData.startsWith('data: ')) {
            processedData = rawData.substring(6).trim();
          }
          
          // Try to parse as JSON
          try {
            jsonData = JSON.parse(processedData);
            
            // Handle status messages
            if (jsonData?.type === 'status') {
              // Handle billing limit reached
              if (jsonData?.status === 'stopped' && jsonData?.message?.includes('Billing limit reached')) {
                setIsStreaming(false);
                setCurrentAgentRunId(null);
                
                // Use the billing error hook
                handleBillingError({
                  status: 402,
                  data: {
                    detail: {
                      message: jsonData.message
                    }
                  }
                });
                
                // Update agent runs and messages
                if (threadId) {
                  Promise.all([
                    getMessages(threadId),
                    getAgentRuns(threadId)
                  ]).then(([updatedMsgs, updatedRuns]) => {
                    setMessages(updatedMsgs);
                    setAgentRuns(updatedRuns);
                    setStreamContent("");
                  }).catch(err => console.error("Failed to update after billing limit:", err));
                }
                
                return;
              }
              
              if (jsonData?.status === 'completed') {
                // Reset streaming on completion
                setIsStreaming(false);
                
                // Fetch updated messages
                if (threadId) {
                  getMessages(threadId)
                    .then(updatedMsgs => {
                      setMessages(updatedMsgs);
                      setStreamContent("");
                      
                      // Also update agent runs
                      return getAgentRuns(threadId);
                    })
                    .then(updatedRuns => {
                      setAgentRuns(updatedRuns);
                      setCurrentAgentRunId(null);
                    })
                    .catch(err => console.error("Failed to update after completion:", err));
                }
                
                return;
              }
              return; // Don't process other status messages further
            }
            
            // Handle content messages
            if (jsonData?.type === 'content' && jsonData?.content) {
              setStreamContent(prev => prev + jsonData?.content);
              return;
            }
          } catch (e) {
            // If not valid JSON, just append the raw data
          }
          
          // If we couldn't parse as special format, just append the raw data
          if (!jsonData) {
            setStreamContent(prev => prev + processedData);
          }
        } catch (error) {
          console.warn("Failed to process message:", error);
        }
      },
      onError: (error: Error | string) => {
        console.error("Streaming error:", error);
        setIsStreaming(false);
        setCurrentAgentRunId(null);
      },
      onClose: async () => {
        // Set UI state to not streaming
        setIsStreaming(false);
        
        try {
          // Update messages and agent runs
          if (threadId) {
            const updatedMessages = await getMessages(threadId);
            setMessages(updatedMessages);
            
            const updatedAgentRuns = await getAgentRuns(threadId);
            setAgentRuns(updatedAgentRuns);
            
            // Reset current agent run
            setCurrentAgentRunId(null);
            
            // Clear streaming content after a short delay
            setTimeout(() => {
              setStreamContent("");
            }, 50);
          }
        } catch (err) {
          console.error("Error checking final status:", err);
          
          // If there was streaming content, add it as a message
          if (streamContent) {
            const assistantMessage: Message = {
              type: 'assistant',
              role: 'assistant',
              content: streamContent + "\n\n[Connection to agent lost]",
            };
            setMessages(prev => [...prev, assistantMessage]);
            setStreamContent("");
          }
        }
        
        // Clear cleanup reference
        streamCleanupRef.current = null;
      }
    });
    
    // Store cleanup function
    streamCleanupRef.current = cleanup;
  }, [threadId, conversation, handleBillingError]);
  
  // Handle sending a message
  const handleSendMessage = async (message: string) => {
    if (!message.trim() || isSending) return;
    if (!conversation) return;
    
    setIsSending(true);
    setError(null); // Clear any previous errors
    clearBillingError(); // Clear any previous billing errors
    
    try {
      // Add user message optimistically to UI
      const userMsg: Message = {
        type: 'user',
        role: 'user',
        content: message,
      };
      setMessages(prev => [...prev, userMsg]);
      
      // Clear the input
      setUserMessage("");
      
      // Add user message to API and start agent
      await addUserMessage(conversation.thread_id, message);
      const agentResponse = await startAgent(conversation.thread_id);
      
      // Set current agent run ID and start streaming
      if (agentResponse.agent_run_id) {
        setCurrentAgentRunId(agentResponse.agent_run_id);
        handleStreamAgent(agentResponse.agent_run_id);
      }
    } catch (err: any) {
      console.error("Error sending message:", err);
      
      // Handle billing errors with the hook
      if (!handleBillingError(err)) {
        // For non-billing errors, show a simpler error message
        setError(
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>
              {err instanceof Error ? err.message : "Failed to send message"}
            </AlertDescription>
          </Alert>
        );
      }
      
      // Remove the optimistically added message on error
      setMessages(prev => prev.slice(0, -1));
    } finally {
      setIsSending(false);
    }
  };
  
  // Handle stopping the agent
  const handleStopAgent = async () => {
    try {
      // Find the running agent run
      const runningAgentId = currentAgentRunId || agentRuns.find(run => run.status === "running")?.id;
      
      if (!runningAgentId) {
        console.warn("No running agent to stop");
        return;
      }

      // Clean up stream first
      if (streamCleanupRef.current) {
        streamCleanupRef.current();
        streamCleanupRef.current = null;
      }
      
      // Stop the agent
      await stopAgent(runningAgentId);
      
      // Update UI state
      setIsStreaming(false);
      setCurrentAgentRunId(null);
      
      // Refresh agent runs and messages
      if (conversation) {
        const [updatedAgentRuns, updatedMessages] = await Promise.all([
          getAgentRuns(conversation.thread_id),
          getMessages(conversation.thread_id)
        ]);
        
        setAgentRuns(updatedAgentRuns);
        setMessages(updatedMessages);
        setStreamContent("");
      }
    } catch (err) {
      console.error("Error stopping agent:", err);
      setError(err instanceof Error ? err.message : "Failed to stop agent");
    }
  };
  
  // Check if agent is running either from agent runs list or streaming state
  const isAgentRunning = isStreaming || currentAgentRunId !== null || agentRuns.some(run => run.status === "running");
  
  // Render based on state
  if (billingError) {
    return (
      <>
        <BillingErrorAlert
          message={billingError?.message}
          currentUsage={billingError?.currentUsage}
          limit={billingError?.limit}
          accountId={conversation?.account_id}
          onDismiss={clearBillingError}
          isOpen={true}
        />
        <ChatContainer
          messages={messages}
          streamContent={streamContent}
          isStreaming={isStreaming}
          isAgentRunning={isAgentRunning}
          agent={agent}
          onSendMessage={handleSendMessage}
          isSending={isSending}
          conversation={conversation}
          onStopAgent={handleStopAgent}
          userMessage={userMessage}
          setUserMessage={setUserMessage}
        />
      </>
    );
  }
  
  if (error) {
    return (
      <div className="flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center p-4">
        <div className="w-full max-w-md mx-auto space-y-4 text-center">
          <div className="p-6 rounded-xl bg-background/50 border border-border/40 shadow-[0_0_15px_rgba(0,0,0,0.03)] backdrop-blur-sm">
            <div className="flex flex-col items-center gap-4">
              <div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
                <AlertCircle className="h-6 w-6 text-destructive" />
              </div>
              
              <div className="space-y-2">
                <h3 className="text-xl font-medium">Something went wrong</h3>
                <p className="text-sm text-muted-foreground">
                  {typeof error === 'string' ? error : 'An unexpected error occurred'}
                </p>
              </div>
              
              <div className="flex items-center gap-3 pt-2">
                <Button 
                  variant="outline" 
                  onClick={() => router.push(`/dashboard/agents`)}
                  className="rounded-lg border-border/40 shadow-[0_0_15px_rgba(0,0,0,0.03)]"
                >
                  Back to Agents
                </Button>
                <Button 
                  variant="default"
                  onClick={() => setError(null)}
                  className="rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground shadow-[0_0_15px_rgba(var(--primary),0.15)]"
                >
                  Try Again
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  
  if (isLoading || (!agent && threadId !== 'new')) {
    return (
      <div className="space-y-4 mx-auto max-w-screen-lg px-4 py-6">
        <div className="flex justify-between items-center">
          <div>
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-56 mt-1.5" />
          </div>
        </div>
        
        <div className="space-y-3 mt-6">
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-10 w-full mt-4 rounded-lg" />
        </div>
      </div>
    );
  }
  
  return (
    <ChatContainer
      messages={messages}
      streamContent={streamContent}
      isStreaming={isStreaming}
      isAgentRunning={isAgentRunning}
      agent={agent}
      onSendMessage={handleSendMessage}
      isSending={isSending}
      conversation={conversation}
      onStopAgent={handleStopAgent}
      userMessage={userMessage}
      setUserMessage={setUserMessage}
    />
  );
}