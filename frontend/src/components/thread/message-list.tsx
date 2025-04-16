'use client';

import React, { useRef, useEffect } from 'react';
import { Message } from "@/lib/api";
import { MessageDisplay, ThinkingIndicator, EmptyChat } from "@/components/thread/message-display";
import { motion, AnimatePresence } from "motion/react";

type MessageRole = 'user' | 'assistant' | 'tool';

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
  agentName = "Suna"
}: MessageListProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamContent]);
  
  // Filter out invalid messages
  const filteredMessages = messages.filter(message => 
    message && 
    message.content && 
    message.role &&
    (message.role === 'user' || message.role === 'assistant' || message.role === 'tool')
  );
  
  // If no messages and not streaming, show empty state
  if (filteredMessages.length === 0 && !streamContent && !isAgentRunning) {
    return <EmptyChat agentName={agentName} />;
  }
  
  return (
    <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden bg-background">
      <div className="w-full">
        <AnimatePresence initial={false}>
          {filteredMessages.map((message, index) => {
            const prevMessage = index > 0 ? filteredMessages[index - 1] : null;
            const nextMessage = index < filteredMessages.length - 1 ? filteredMessages[index + 1] : null;
            
            // Show identifier if this is an AI/tool message that follows a user message
            const showIdentifier = message.role !== 'user' && 
              (!prevMessage || prevMessage.role === 'user');
            
            // Part of a chain if:
            // 1. Current message is tool/assistant AND
            // 2. Previous message was also tool/assistant
            const isPartOfChain = message.role !== 'user' && 
              prevMessage?.role !== 'user';
            
            return (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ 
                  duration: 0.2,
                  ease: [0.25, 0.1, 0.25, 1],
                  delay: 0.05
                }}
              >
                <MessageDisplay
                  content={message.content}
                  role={message.role as MessageRole}
                  showIdentifier={showIdentifier}
                  isPartOfChain={isPartOfChain}
                />
              </motion.div>
            );
          })}
        </AnimatePresence>
        
        {streamContent && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
          >
            <MessageDisplay
              content={streamContent}
              role="assistant"
              isStreaming={isStreaming}
              showIdentifier={filteredMessages.length === 0 || filteredMessages[filteredMessages.length - 1].role === 'user'}
              isPartOfChain={filteredMessages.length > 0 && filteredMessages[filteredMessages.length - 1].role !== 'user'}
            />
          </motion.div>
        )}
        
        {isAgentRunning && !streamContent && (
          <ThinkingIndicator />
        )}
        
        <div ref={messagesEndRef} className="h-24" />
      </div>
    </div>
  );
} 