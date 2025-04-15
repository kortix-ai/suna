"use client";

import React, { useState, Suspense } from 'react';
import { Skeleton } from "@/components/ui/skeleton";
import { useRouter } from 'next/navigation';
import { ChatInput } from '@/components/thread/chat-input';
import { createProject, addUserMessage, startAgent, createThread } from "@/lib/api";

function DashboardContent() {
  const [inputValue, setInputValue] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const router = useRouter();

  const handleSubmit = async (message: string) => {
    if (!message.trim() || isSubmitting) return;
    
    setIsSubmitting(true);
    
    try {
      // 1. Create a new project with the message as the name
      const newAgent = await createProject({
        name: message.trim().length > 50 
          ? message.trim().substring(0, 47) + "..." 
          : message.trim(),
        description: "",
      });
      
      // 2. Create a new thread for this project
      const thread = await createThread(newAgent.id);
      
      // 3. Add the user message to the thread
      await addUserMessage(thread.thread_id, message.trim());
      
      // 4. Start the agent with the thread ID
      const agentRun = await startAgent(thread.thread_id);
      
      // 5. Navigate to the new agent's thread page
      router.push(`/dashboard/agents/${thread.thread_id}`);
    } catch (error) {
      console.error("Error creating agent:", error);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full w-full">
      <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-[560px] max-w-[90%]">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-medium text-foreground mb-2">Hello.</h1>
          <h2 className="text-2xl text-muted-foreground">What can I help with?</h2>
        </div>
        
        <ChatInput 
          onSubmit={handleSubmit} 
          loading={isSubmitting}
          placeholder="Ask anything..."
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