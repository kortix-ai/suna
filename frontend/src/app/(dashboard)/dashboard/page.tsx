"use client";

import React, { useState, Suspense, useEffect } from 'react';
import { Skeleton } from "@/components/ui/skeleton";
import { useRouter } from 'next/navigation';
import { ChatInput } from '@/components/thread/chat-input';
import { createProject, addUserMessage, startAgent, createThread } from "@/lib/api";
import { generateThreadName } from "@/lib/actions/threads";

// Constant for localStorage key to ensure consistency
const PENDING_PROMPT_KEY = 'pendingAgentPrompt';

function DashboardContent() {
  const [inputValue, setInputValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(false);
  const router = useRouter();

  const handleSubmit = async (message: string, options?: { model_name?: string; enable_thinking?: boolean }) => {
    if (!message.trim() || isSubmitting) return;
    
    setIsSubmitting(true);
    
    try {
      // Generate a name for the project using GPT
      const projectName = await generateThreadName(message);
      
      // 1. Create a new project with the GPT-generated name
      const newAgent = await createProject({
        name: projectName,
        description: "",
      });
      
      // 2. Create a new thread for this project
      const thread = await createThread(newAgent.id);
      
      // 3. Add the user message to the thread
      await addUserMessage(thread.thread_id, message.trim());
      
      // 4. Start the agent with the thread ID
      const agentRun = await startAgent(thread.thread_id, {
        model_name: options?.model_name,
        enable_thinking: options?.enable_thinking,
        stream: true
      });
      
      // If successful, clear the pending prompt
      localStorage.removeItem(PENDING_PROMPT_KEY);
      
      // 5. Navigate to the new agent's thread page
      router.push(`/agents/${thread.thread_id}`);
    } catch (error) {
      console.error("Error creating agent:", error);
      setIsSubmitting(false);
    }
  };

  // Check for pending prompt in localStorage on mount
  useEffect(() => {
    // Use a small delay to ensure we're fully mounted
    const timer = setTimeout(() => {
      const pendingPrompt = localStorage.getItem(PENDING_PROMPT_KEY);
      
      if (pendingPrompt) {
        setInputValue(pendingPrompt);
        setAutoSubmit(true); // Flag to auto-submit after mounting
      }
    }, 200);
    
    return () => clearTimeout(timer);
  }, []);

  // Auto-submit the form if we have a pending prompt
  useEffect(() => {
    if (autoSubmit && inputValue && !isSubmitting) {
      const timer = setTimeout(() => {
        handleSubmit(inputValue);
        setAutoSubmit(false);
      }, 500);
      
      return () => clearTimeout(timer);
    }
  }, [autoSubmit, inputValue, isSubmitting, handleSubmit]);

  return (
    <div className="flex flex-col items-center justify-center h-full w-full">
      <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-[560px] max-w-[90%]">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-medium text-foreground mb-2">Hey </h1>
          <h2 className="text-2xl text-muted-foreground">What would you like Suna to do today?</h2>
        </div>
        
        <ChatInput 
          onSubmit={handleSubmit} 
          loading={isSubmitting}
          placeholder="Describe what you need help with..."
          value={inputValue}
          onChange={setInputValue}
        />
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={
      <div className="flex flex-col items-center justify-center h-full w-full">
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-[560px] max-w-[90%]">
          <div className="flex flex-col items-center text-center mb-10">
            <Skeleton className="h-10 w-40 mb-2" />
            <Skeleton className="h-7 w-56" />
          </div>
          
          <Skeleton className="w-full h-[100px] rounded-xl" />
          <div className="flex justify-center mt-3">
            <Skeleton className="h-5 w-16" />
          </div>
        </div>
      </div>
    }>
      <DashboardContent />
    </Suspense>
  );
}
