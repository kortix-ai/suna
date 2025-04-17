'use client';

import React, { useEffect, useState } from 'react';
import { getSandboxFileContent } from '@/lib/api';
import { Skeleton } from "@/components/ui/skeleton";
import { Check, RefreshCw, ChevronDown, ChevronUp, Circle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';

interface TodoPanelProps {
  sandboxId: string | null;
  isSidePanelOpen: boolean;
  className?: string;
}

interface TodoTask {
  text: string;
  completed: boolean;
}

export function TodoPanel({ sandboxId, isSidePanelOpen, className = '' }: TodoPanelProps) {
  const [tasks, setTasks] = useState<TodoTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [isCollapsed, setIsCollapsed] = useState(true);

  const fetchTodoContent = async () => {
    if (!sandboxId) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const content = await getSandboxFileContent(sandboxId, '/workspace/todo.md');
      
      if (typeof content === 'string') {
        parseTasks(content);
      } else if (content instanceof Blob) {
        // Handle blob content (convert to text)
        const text = await content.text();
        parseTasks(text);
      } else {
        throw new Error('Unexpected content format');
      }
    } catch (err) {
      console.error('Failed to load todo.md:', err);
      // Don't show error toast when file doesn't exist yet, as this is expected initially
      if (err instanceof Error && !err.message.includes('404')) {
        setError('Tasks will show up shortly');
        // toast.error('Failed to load todo file');
      } else {
        setTasks([]);
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Extract just the task items from todo.md content
  const parseTasks = (content: string) => {
    if (!content) {
      setTasks([]);
      return;
    }

    const lines = content.split('\n');
    const extractedTasks: TodoTask[] = [];

    lines.forEach(line => {
      const trimmedLine = line.trim();
      
      // Only look for task items with checkbox
      const taskMatch = trimmedLine.match(/^\s*[-*]\s+\[([ x])\]\s+(.+)$/);
      if (taskMatch) {
        extractedTasks.push({
          text: taskMatch[2].trim(),
          completed: taskMatch[1] === 'x'
        });
      }
    });
    
    setTasks(extractedTasks);
  };

  // Fetch the todo.md file when component mounts or sandboxId changes
  useEffect(() => {
    if (sandboxId) {
      fetchTodoContent();
    }
  }, [sandboxId, lastRefreshed]);

  // Set up periodic refresh (every 10 seconds)
  useEffect(() => {
    const intervalId = setInterval(() => {
      fetchTodoContent();
    }, 10000);
    
    return () => clearInterval(intervalId);
  }, [sandboxId]);

  const handleRefresh = () => {
    setLastRefreshed(new Date());
  };

  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed);
  };

  // Only get incomplete tasks
  const incompleteTasks = tasks.filter(task => !task.completed);
  const completedTasks = tasks.filter(task => task.completed);
  
  // Get first incomplete task
  const firstIncompleteTask = incompleteTasks.length > 0 ? incompleteTasks[0] : null;

  // Styling based on whether the side panel is open
  const containerClasses = isSidePanelOpen
    ? 'border-t p-2 bg-sidebar' // At bottom of side panel
    : 'border rounded-md shadow-sm mb-2 bg-card'; // Above chat input

  const heightClasses = isSidePanelOpen
    ? isCollapsed ? 'h-[70px]' : 'h-[200px]' // Fixed height in side panel
    : isCollapsed ? 'max-h-[70px]' : 'max-h-[200px]'; // Max height above chat input

  return (
    <div className={cn(
      `${containerClasses} ${heightClasses} transition-all duration-300 ease-out`,
      className
    )}>
      {isLoading ? (
        <div className="space-y-2 p-1">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : error ? (
        <div className="flex items-center justify-center h-10">
          <p className="text-xs text-muted-foreground">{error}</p>
        </div>
      ) : tasks.length === 0 ? (
        <div className="flex items-center justify-center h-10 text-xs text-muted-foreground">
          Tasks will show up shortly
        </div>
      ) : (
        <>
          {/* Display tasks based on collapsed state */}
          {isCollapsed ? (
            <div className="px-1 pt-1">
              {firstIncompleteTask ? (
                <div className="flex items-start gap-2">
                  <div className="mt-0.5 relative flex-shrink-0">
                    <Circle className="h-3.5 w-3.5 text-secondary" />
                    {/* Pulse animation inside circle */}
                    <span className="absolute inset-1 rounded-full bg-secondary/30 animate-ping opacity-75"></span>
                  </div>
                  <span className="text-sm">{firstIncompleteTask.text}</span>
                  <div className="flex items-center gap-1 ml-auto">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={handleRefresh}
                      title="Refresh todo list"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={toggleCollapse}
                      title={isCollapsed ? "Expand" : "Collapse"}
                    >
                      {isCollapsed ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronUp className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center h-8 px-1 text-sm">
                  <Check className="h-4 w-4 mr-2" />
                  All tasks completed!
                  <div className="flex items-center gap-1 ml-auto">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={handleRefresh}
                      title="Refresh todo list"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={toggleCollapse}
                      title={isCollapsed ? "Expand" : "Collapse"}
                    >
                      {isCollapsed ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronUp className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between px-1 mb-1">
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={handleRefresh}
                    title="Refresh todo list"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={toggleCollapse}
                    title={isCollapsed ? "Expand" : "Collapse"}
                  >
                    {isCollapsed ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronUp className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              </div>
              <ScrollArea className="h-[calc(100%-30px)]">
                <div className="space-y-1.5 px-1">
                  {/* Incomplete tasks first */}
                  {incompleteTasks.map((task, index) => (
                    <div key={`incomplete-${index}`} className="flex items-start gap-2">
                      <div className="mt-0.5 flex-shrink-0">
                        <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                      <span className="text-sm leading-tight">{task.text}</span>
                    </div>
                  ))}
                  
                  {/* Show completed tasks after incomplete ones */}
                  {completedTasks.length > 0 && (
                    <>
                      {incompleteTasks.length > 0 && <div className="border-t my-2 border-border/40"></div>}
                      
                      {completedTasks.map((task, index) => (
                        <div key={`complete-${index}`} className="flex items-start gap-2 opacity-60">
                          <div className="mt-0.5 flex-shrink-0">
                            <Check className="h-3.5 w-3.5 text-green-500" />
                          </div>
                          <span className="text-sm text-muted-foreground line-through leading-tight">{task.text}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </ScrollArea>
            </>
          )}
        </>
      )}
    </div>
  );
} 