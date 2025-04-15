'use client';

import React, { useState, useEffect, useCallback, useRef, useContext } from "react";
import { getProject, getMessages, getThread, addUserMessage, startAgent, stopAgent, getAgentRuns, streamAgent, type Message, type Project, type Thread, type AgentRun } from "@/lib/api";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Square, Send, User, Plus } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { SUPPORTED_XML_TAGS, ParsedTag } from "@/lib/types/tool-calls";
import { ToolCallsContext } from "@/app/providers";
import { getComponentForTag } from "@/components/chat/tool-components";
import { BillingErrorAlert } from "@/components/billing/BillingErrorAlert";
import { useBillingError } from "@/hooks/useBillingError";

interface AgentPageProps {
  params: {
    threadId: string;
  };
}

// Parse XML tags in content
function parseXMLTags(content: string): { parts: (string | ParsedTag)[], openTags: Record<string, ParsedTag> } {
  const parts: (string | ParsedTag)[] = [];
  const openTags: Record<string, ParsedTag> = {};
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
      const parsedTag: ParsedTag = {
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
          const openTag = parts[openTagIndex] as ParsedTag;
          
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

// Simple component to handle message formatting with XML tag support
function MessageContent({ content }: { content: string }) {
  const { parts, openTags } = parseXMLTags(content);
  
  return (
    <div className="whitespace-pre-wrap">
      {parts.map((part, index) => {
        if (typeof part === 'string') {
          return (
            <React.Fragment key={index}>
              {part.split('\n').map((line, i) => (
                <React.Fragment key={i}>
                  {line}
                  {i < part.split('\n').length - 1 && <br />}
                </React.Fragment>
              ))}
            </React.Fragment>
          );
        } else {
          // Render specialized tool component based on tag type
          const ToolComponent = getComponentForTag(part);
          return <ToolComponent key={index} tag={part} mode="compact" />;
        }
      })}
    </div>
  );
}

export default function AgentPage({ params }: AgentPageProps) {
  const { threadId } = params;
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialMessage = searchParams.get('message');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamCleanupRef = useRef<(() => void) | null>(null);
  
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
    
    console.log(`[TOOLS] Processing ${allContent.length} content items for tool calls`);
    
    // Create a new array of tags with a better deduplication strategy
    const extractedTags: ParsedTag[] = [];
    const seenTagIds = new Set<string>();
    
    allContent.forEach((content, idx) => {
      console.log(`[TOOLS] Extracting from content #${idx}, length: ${content.length}`);
      const { parts, openTags } = parseXMLTags(content);
      
      let tagsFound = 0;
      
      // Mark tool calls vs results based on position and sender
      const isUserMessage = idx % 2 === 0; // Assuming alternating user/assistant messages
      
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
            console.log(`[TOOLS] Adding VNC preview from sandbox to browser tool ${part.tagName}`);
            part.vncPreview = agent.sandbox.vnc_preview + "/vnc_lite.html?password=" + agent.sandbox.pass;
          }
          
          // Use ID for deduplication
          if (!seenTagIds.has(part.id)) {
            seenTagIds.add(part.id);
            extractedTags.push(part);
            tagsFound++;
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
          console.log(`[TOOLS] Adding VNC preview from sandbox to browser tool ${tag.tagName}`);
          tag.vncPreview = agent.sandbox.vnc_preview + "/vnc_lite.html?password=" + agent.sandbox.pass;
        }
        
        // Use ID for deduplication
        if (!seenTagIds.has(tag.id)) {
          seenTagIds.add(tag.id);
          extractedTags.push(tag);
          tagsFound++;
        }
      });
      
      console.log(`[TOOLS] Found ${tagsFound} tags in content #${idx}`);
    });
    
    console.log(`[TOOLS] Extracted ${extractedTags.length} total tools`);
    
    // Sort the tools by timestamp (oldest first)
    extractedTags.sort((a, b) => {
      if (a.timestamp && b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return 0;
    });
    
    // Try to pair tool calls with their results
    const pairedTags: ParsedTag[] = [];
    const callsByTagName: Record<string, ParsedTag[]> = {};
    
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
    
    console.log(`[TOOLS] Paired ${pairedTags.length} tools, ${pairedTags.filter(t => t.isPaired).length} were paired`);
    
    // Update tool calls in the shared context
    setToolCalls(pairedTags);
  }, [messages, streamContent, setToolCalls, agent]);
  
  // Scroll to bottom of messages
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);
  
  // Load initial data
  useEffect(() => {
    async function loadData() {
      setIsLoading(true);
      setError(null);
      
      try {
        // Check if we're creating a new conversation or using an existing one
        if (threadId === 'new') {
          try {
            // For new threads, we need a project ID - we could redirect to project selection
            // or use a default project (future enhancement)
            router.push('/dashboard');
            return;
          } catch (err) {
            console.error("Failed to create new thread:", err);
            setError("Failed to create a new conversation");
          }
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
        console.log("[PAGE] Cleaning up stream on unmount");
        streamCleanupRef.current();
        streamCleanupRef.current = null;
      }
    };
  }, [threadId, initialMessage, router]);
  
  // Scroll to bottom when messages change
  useEffect(() => {
    scrollToBottom();
  }, [messages, streamContent, scrollToBottom]);
  
  // Handle streaming agent responses
  const handleStreamAgent = useCallback((agentRunId: string) => {
    // Clean up any existing stream first
    if (streamCleanupRef.current) {
      console.log("[PAGE] Cleaning up existing stream before starting new one");
      streamCleanupRef.current();
      streamCleanupRef.current = null;
    }
    
    setIsStreaming(true);
    setStreamContent("");
    
    console.log(`[PAGE] Setting up stream for agent run ${agentRunId}`);
    
    const cleanup = streamAgent(agentRunId, {
      onMessage: (rawData: string) => {
        try {
          console.log(`[PAGE] Raw message data:`, rawData);
          
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
                console.log("[PAGE] Detected billing limit status event");
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
                  }).catch(err => console.error("[PAGE] Failed to update after billing limit:", err));
                }
                
                return;
              }
              
              if (jsonData?.status === 'completed') {
                console.log("[PAGE] Detected completion status event");
                
                // Reset streaming on completion
                setIsStreaming(false);
                
                // Fetch updated messages
                if (threadId) {
                  getMessages(threadId)
                    .then(updatedMsgs => {
                      console.log("[PAGE] Updated messages:");
                      console.log(updatedMsgs);
                      setMessages(updatedMsgs);
                      setStreamContent("");
                      
                      // Also update agent runs
                      return getAgentRuns(threadId);
                    })
                    .then(updatedRuns => {
                      setAgentRuns(updatedRuns);
                      setCurrentAgentRunId(null);
                    })
                    .catch(err => console.error("[PAGE] Failed to update after completion:", err));
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
            console.warn("[PAGE] Failed to parse as JSON:", e);
          }
          
          // If we couldn't parse as special format, just append the raw data
          if (!jsonData) {
            setStreamContent(prev => prev + processedData);
          }
        } catch (error) {
          console.warn("[PAGE] Failed to process message:", error);
        }
      },
      onError: (error: Error | string) => {
        console.error("[PAGE] Streaming error:", error);
        setIsStreaming(false);
        setCurrentAgentRunId(null);
      },
      onClose: async () => {
        console.log("[PAGE] Stream connection closed");
        
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
          console.error("[PAGE] Error checking final status:", err);
          
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
  const handleSendMessage = async () => {
    if (!userMessage.trim() || isSending) return;
    if (!conversation) return;
    
    setIsSending(true);
    setError(null); // Clear any previous errors
    clearBillingError(); // Clear any previous billing errors
    
    try {
      // Add user message optimistically to UI
      const userMsg: Message = {
        type: 'user',
        role: 'user',
        content: userMessage,
      };
      setMessages(prev => [...prev, userMsg]);
      
      // Clear the input
      setUserMessage("");
      
      // Add user message to API and start agent
      await addUserMessage(conversation.thread_id, userMessage);
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
      
      if (runningAgentId) {
        // Clean up stream first
        if (streamCleanupRef.current) {
          console.log("[PAGE] Cleaning up stream before stopping agent");
          streamCleanupRef.current();
          streamCleanupRef.current = null;
        }
        
        // Then stop the agent
        await stopAgent(runningAgentId);
        setIsStreaming(false);
        setCurrentAgentRunId(null);
        
        // Refresh agent runs
        if (conversation) {
          const updatedAgentRuns = await getAgentRuns(conversation.thread_id);
          setAgentRuns(updatedAgentRuns);
          
          // Also refresh messages to get any partial responses
          const updatedMessages = await getMessages(conversation.thread_id);
          setMessages(updatedMessages);
          
          // Clear streaming content
          setStreamContent("");
        }
      }
    } catch (err) {
      console.error("Error stopping agent:", err);
      setError(err instanceof Error ? err.message : "Failed to stop agent");
    }
  };
  
  // Check if agent is running either from agent runs list or streaming state
  const isAgentRunning = isStreaming || currentAgentRunId !== null || agentRuns.some(run => run.status === "running");
  
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
        <div className="flex flex-col h-[calc(100vh-10rem)] max-h-[calc(100vh-10rem)] overflow-hidden">
          <div className="flex-1 overflow-y-auto p-4 pb-[120px] space-y-4" id="messages-container">
            {messages.length === 0 && !streamContent ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <h3 className="text-lg font-medium">Start a conversation</h3>
                  <p className="text-sm text-muted-foreground mt-2 mb-4">
                    Send a message to start talking with {agent?.name || "the AI agent"}
                  </p>
                </div>
              </div>
            ) : (
              <>
                {messages.map((message, index) => {
                  // Skip messages containing "ToolResult("
                  if (!message || !message?.content || !message?.role) {
                    return null;
                  }

                  if (message.content.includes("ToolResult(")) {
                    return null;
                  }
                  
                  return (
                    <div
                      key={index}
                      className={`flex ${
                        message.role === "user" ? "justify-end" : "justify-start"
                      }`}
                    >
                      <div
                        className={`max-w-[80%] p-4 rounded-lg ${
                          message.role === "user"
                            ? "bg-[#f0efe7] text-foreground flex items-start"
                            : ""
                        }`}
                      >
                        {message.role === "user" && (
                          <User className="h-5 w-5 mr-2 shrink-0 mt-0.5" />
                        )}
                        <MessageContent content={message.content} />
                      </div>
                    </div>
                  );
                })}
                
                {/* Show streaming content if available */}
                {streamContent && (
                  <div className="flex justify-start">
                    <div className="max-w-[80%] p-4">
                      <div className="whitespace-pre-wrap">
                        <MessageContent content={streamContent} />
                        {isStreaming && (
                          <span 
                            className="inline-block h-4 w-0.5 bg-foreground/50 mx-px"
                            style={{ 
                              opacity: 0.7,
                              animation: 'cursorBlink 1s ease-in-out infinite',
                            }}
                          />
                        )}
                        <style jsx global>{`
                          @keyframes cursorBlink {
                            0%, 100% { opacity: 1; }
                            50% { opacity: 0; }
                          }
                        `}</style>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Show a loading indicator if the agent is running but no stream yet */}
                {isAgentRunning && !streamContent && (
                  <div className="flex justify-start">
                    <div className="max-w-[80%] p-4">
                      <div className="flex items-center space-x-2">
                        <div className="h-2 w-2 bg-foreground rounded-full animate-pulse"></div>
                        <div className="h-2 w-2 bg-foreground rounded-full animate-pulse delay-150"></div>
                        <div className="h-2 w-2 bg-foreground rounded-full animate-pulse delay-300"></div>
                        <span className="text-sm text-muted-foreground ml-2">AI is thinking...</span>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
            <div ref={messagesEndRef} id="messages-end"></div>
          </div>
          
          <div className="absolute bottom-0 left-0 right-0 z-10 bg-background pb-6">
            <div className="relative bg-white border border-gray-200 rounded-2xl p-2 mx-4">
              <Textarea
                value={userMessage}
                onChange={(e) => setUserMessage(e.target.value)}
                placeholder="Type your message..."
                className="resize-none min-h-[100px] pr-12 border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                disabled={isAgentRunning || isSending || !conversation}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.shiftKey === false) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
              />
              <div className="absolute bottom-3 right-3 flex space-x-2">
                <Button 
                  variant="outline"
                  className="h-10 w-10 p-0 rounded-2xl border border-gray-200"
                  disabled={isAgentRunning || isSending || !conversation}
                >
                  <Plus className="h-4 w-4" />
                </Button>
                <Button 
                  onClick={isAgentRunning ? handleStopAgent : handleSendMessage}
                  className="h-10 w-10 p-0 rounded-2xl" 
                  disabled={(!userMessage.trim() && !isAgentRunning) || isSending || !conversation}
                >
                  {isAgentRunning ? (
                    <Square className="h-4 w-4" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }
  
  if (error) {
    return (
      <div className="max-w-2xl mx-auto py-8 space-y-6">
        {typeof error === 'string' ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          error
        )}
        <div className="flex space-x-4">
          <Button variant="outline" onClick={() => router.push(`/dashboard/agents`)}>
            Back to Agents
          </Button>
          <Button variant="outline" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      </div>
    );
  }
  
  if (isLoading || (!agent && threadId !== 'new')) {
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-5 w-64 mt-2" />
          </div>
        </div>
        
        <div className="space-y-4 mt-8">
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
          <Skeleton className="h-12 w-full mt-4" />
        </div>
      </div>
    );
  }
  
  return (
    <div className="flex flex-col h-[calc(100vh-10rem)] max-h-[calc(100vh-10rem)] overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4 pb-[120px] space-y-4" id="messages-container">
        {messages.length === 0 && !streamContent ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <h3 className="text-lg font-medium">Start a conversation</h3>
              <p className="text-sm text-muted-foreground mt-2 mb-4">
                Send a message to start talking with {agent?.name || "the AI agent"}
              </p>
            </div>
          </div>
        ) : (
          <>
            {messages.map((message, index) => {
              // Skip messages containing "ToolResult("
              if (!message || !message?.content || !message?.role) {
                return null;
              }
              if (message.content.includes("ToolResult(")) {
                return null;
              }
              
              return (
                <div
                  key={index}
                  className={`flex ${
                    message.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div
                    className={`max-w-[80%] p-4 rounded-lg ${
                      message.role === "user"
                        ? "bg-[#f0efe7] text-foreground flex items-start"
                        : ""
                    }`}
                  >
                    {message.role === "user" && (
                      <User className="h-5 w-5 mr-2 shrink-0 mt-0.5" />
                    )}
                    <MessageContent content={message.content} />
                  </div>
                </div>
              );
            })}
            
            {/* Show streaming content if available */}
            {streamContent && (
              <div className="flex justify-start">
                <div className="max-w-[80%] p-4">
                  <div className="whitespace-pre-wrap">
                    <MessageContent content={streamContent} />
                    {isStreaming && (
                      <span 
                        className="inline-block h-4 w-0.5 bg-foreground/50 mx-px"
                        style={{ 
                          opacity: 0.7,
                          animation: 'cursorBlink 1s ease-in-out infinite',
                        }}
                      />
                    )}
                    <style jsx global>{`
                      @keyframes cursorBlink {
                        0%, 100% { opacity: 1; }
                        50% { opacity: 0; }
                      }
                    `}</style>
                  </div>
                </div>
              </div>
            )}
            
            {/* Show a loading indicator if the agent is running but no stream yet */}
            {isAgentRunning && !streamContent && (
              <div className="flex justify-start">
                <div className="max-w-[80%] p-4">
                  <div className="flex items-center space-x-2">
                    <div className="h-2 w-2 bg-foreground rounded-full animate-pulse"></div>
                    <div className="h-2 w-2 bg-foreground rounded-full animate-pulse delay-150"></div>
                    <div className="h-2 w-2 bg-foreground rounded-full animate-pulse delay-300"></div>
                    <span className="text-sm text-muted-foreground ml-2">AI is thinking...</span>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} id="messages-end"></div>
      </div>
      
      <div className="absolute bottom-0 left-0 right-0 z-10 bg-background pb-6">
        <div className="relative bg-white border border-gray-200 rounded-2xl p-2 mx-4">
          <Textarea
            value={userMessage}
            onChange={(e) => setUserMessage(e.target.value)}
            placeholder="Type your message..."
            className="resize-none min-h-[100px] pr-12 border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
            disabled={isAgentRunning || isSending || !conversation}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.shiftKey === false) {
                e.preventDefault();
                handleSendMessage();
              }
            }}
          />
          <div className="absolute bottom-3 right-3 flex space-x-2">
            <Button 
              variant="outline"
              className="h-10 w-10 p-0 rounded-2xl border border-gray-200"
              disabled={isAgentRunning || isSending || !conversation}
            >
              <Plus className="h-4 w-4" />
            </Button>
            <Button 
              onClick={isAgentRunning ? handleStopAgent : handleSendMessage}
              className="h-10 w-10 p-0 rounded-2xl" 
              disabled={(!userMessage.trim() && !isAgentRunning) || isSending || !conversation}
            >
              {isAgentRunning ? (
                <Square className="h-4 w-4" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}