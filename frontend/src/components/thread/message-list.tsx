'use client';

import React, { useRef, useEffect } from 'react';
import { Message } from "@/lib/api";
import { MessageDisplay, ThinkingIndicator, EmptyChat } from "@/components/thread/message-display";
import { motion, AnimatePresence } from "motion/react";

interface MessageListProps {
  messages: Message[];
  streamContent?: string;
  isStreaming?: boolean;
  isAgentRunning?: boolean;
  agentName?: string;
}

export function MessageList({
  messages,
  streamContent = "",
  isStreaming = false,
  isAgentRunning = false,
  agentName = "AI assistant"
}: MessageListProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamContent]);
  
  // Filter out invalid messages and tool results
  const filteredMessages = messages.filter(message => 
    message && 
    message.content && 
    message.role && 
    !message.content.includes("ToolResult(")
  );
  
  // If no messages and not streaming, show empty state
  if (filteredMessages.length === 0 && !streamContent && !isAgentRunning) {
    return <EmptyChat agentName={agentName} />;
  }
  
  return (
    <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden p-4 pb-32">
      {/* Regular messages */}
      <AnimatePresence initial={false}>
        {filteredMessages.map((message, index) => (
          <motion.div
            key={index}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ 
              duration: 0.3, 
              ease: [0.25, 0.1, 0.25, 1],
              delay: 0.1
            }}
          >
            <MessageDisplay
              content={message.content}
              role={message.role as 'user' | 'assistant'}
            />
          </motion.div>
        ))}
      </AnimatePresence>
      
      {/* Streaming message */}
      {streamContent && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <MessageDisplay
            content={streamContent}
            role="assistant"
            isStreaming={isStreaming}
          />
        </motion.div>
      )}
      
      {/* Loading indicator when agent is running but no stream yet */}
      {isAgentRunning && !streamContent && (
        <ThinkingIndicator />
      )}
      
      {/* Element to scroll to */}
      <div ref={messagesEndRef} />
    </div>
  );
} 