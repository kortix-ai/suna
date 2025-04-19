import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { Project } from "@/lib/api";
import { getToolIcon } from "@/components/thread/utils";
import React from "react";
import { Slider } from "@/components/ui/slider";

// Import tool view components from the tool-views directory
import { CommandToolView } from "./tool-views/CommandToolView";
import { StrReplaceToolView } from "./tool-views/StrReplaceToolView";
import { GenericToolView } from "./tool-views/GenericToolView";
import { FileOperationToolView } from "./tool-views/FileOperationToolView";
import { BrowserToolView } from "./tool-views/BrowserToolView";
import { WebSearchToolView } from "./tool-views/WebSearchToolView";
import { WebCrawlToolView } from "./tool-views/WebCrawlToolView";

// Simple input interface
export interface ToolCallInput {
  assistantCall: {
    content?: string;
    name?: string;
    timestamp?: string;
  };
  toolResult?: {
    content?: string;
    isSuccess?: boolean;
    timestamp?: string;
  };
}

// Get the specialized tool view component based on the tool name
function getToolView(
  toolName: string | undefined, 
  assistantContent: string | undefined, 
  toolContent: string | undefined,
  assistantTimestamp: string | undefined,
  toolTimestamp: string | undefined,
  isSuccess: boolean = true,
  project?: Project
) {
  if (!toolName) return null;
  
  const normalizedToolName = toolName.toLowerCase();
  
  switch (normalizedToolName) {
    case 'execute-command':
      return (
        <CommandToolView 
          assistantContent={assistantContent}
          toolContent={toolContent}
          assistantTimestamp={assistantTimestamp}
          toolTimestamp={toolTimestamp}
          isSuccess={isSuccess}
        />
      );
    case 'str-replace':
      return (
        <StrReplaceToolView
          assistantContent={assistantContent}
          toolContent={toolContent}
          assistantTimestamp={assistantTimestamp}
          toolTimestamp={toolTimestamp}
          isSuccess={isSuccess}
        />
      );
    case 'create-file':
    case 'full-file-rewrite':
    case 'delete-file':
      return (
        <FileOperationToolView 
          assistantContent={assistantContent}
          toolContent={toolContent}
          assistantTimestamp={assistantTimestamp}
          toolTimestamp={toolTimestamp}
          isSuccess={isSuccess}
          name={normalizedToolName}
        />
      );
    case 'browser-navigate':
    case 'browser-click':
    case 'browser-extract':
    case 'browser-fill':
    case 'browser-wait':
      return (
        <BrowserToolView
          name={normalizedToolName}
          assistantContent={assistantContent}
          toolContent={toolContent}
          assistantTimestamp={assistantTimestamp}
          toolTimestamp={toolTimestamp}
          isSuccess={isSuccess}
          project={project}
        />
      );
    case 'web-search':
      return (
        <WebSearchToolView
          assistantContent={assistantContent}
          toolContent={toolContent}
          assistantTimestamp={assistantTimestamp}
          toolTimestamp={toolTimestamp}
          isSuccess={isSuccess}
        />
      );
    case 'web-crawl':
      return (
        <WebCrawlToolView
          assistantContent={assistantContent}
          toolContent={toolContent}
          assistantTimestamp={assistantTimestamp}
          toolTimestamp={toolTimestamp}
          isSuccess={isSuccess}
        />
      );
    default:
      // Check if it's a browser operation
      if (normalizedToolName.startsWith('browser-')) {
        return (
          <BrowserToolView
            name={toolName}
            assistantContent={assistantContent}
            toolContent={toolContent}
            assistantTimestamp={assistantTimestamp}
            toolTimestamp={toolTimestamp}
            isSuccess={isSuccess}
            project={project}
          />
        );
      }
      
      // Fallback to generic view
      return (
        <GenericToolView 
          name={toolName}
          assistantContent={assistantContent}
          toolContent={toolContent}
          assistantTimestamp={assistantTimestamp}
          toolTimestamp={toolTimestamp}
          isSuccess={isSuccess}
        />
      );
  }
}

interface ToolCallSidePanelProps {
  isOpen: boolean;
  onClose: () => void;
  toolCalls: ToolCallInput[];
  currentIndex: number;
  onNavigate: (newIndex: number) => void;
  project?: Project;
  renderAssistantMessage?: (assistantContent?: string, toolContent?: string) => React.ReactNode;
  renderToolResult?: (toolContent?: string, isSuccess?: boolean) => React.ReactNode;
}

export function ToolCallSidePanel({
  isOpen,
  onClose,
  toolCalls,
  currentIndex,
  onNavigate,
  project,
  renderAssistantMessage,
  renderToolResult
}: ToolCallSidePanelProps) {
  if (!isOpen) return null;
  
  const currentToolCall = toolCalls[currentIndex];
  const totalCalls = toolCalls.length;
  const currentToolName = currentToolCall?.assistantCall?.name || 'Tool Call';
  const CurrentToolIcon = getToolIcon(currentToolName === 'Tool Call' ? 'unknown' : currentToolName);
  
  // Determine if this is a streaming tool call
  const isStreaming = currentToolCall?.toolResult?.content === "STREAMING";
  
  // Set up a pulse animation for streaming
  const [dots, setDots] = React.useState('');
  
  React.useEffect(() => {
    if (!isStreaming) return;
    
    // Create a loading animation with dots
    const interval = setInterval(() => {
      setDots(prev => {
        if (prev === '...') return '';
        return prev + '.';
      });
    }, 500);
    
    return () => clearInterval(interval);
  }, [isStreaming]);
  
  const renderContent = () => {
    if (!currentToolCall) {
      return (
        <div className="flex items-center justify-center h-full p-4">
          <p className="text-sm text-muted-foreground text-center">No tool call details available.</p>
        </div>
      );
    }
    
    // Get the specific tool view based on the tool name
    return getToolView(
      currentToolCall.assistantCall.name,
      currentToolCall.assistantCall.content,
      currentToolCall.toolResult?.content,
      currentToolCall.assistantCall.timestamp,
      currentToolCall.toolResult?.timestamp,
      isStreaming ? true : (currentToolCall.toolResult?.isSuccess ?? true),
      project
    );
  };
  
  return (
    <div className="fixed inset-y-0 right-0 w-[90%] sm:w-[450px] md:w-[500px] lg:w-[550px] xl:w-[600px] bg-background border-l flex flex-col z-10">
      <div className="p-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          {isStreaming 
            ? `Suna's Computer (Running${dots})` 
            : "Suna's Computer"}
        </h3>
        <Button variant="ghost" size="icon" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        {renderContent()}
      </div>
      {totalCalls > 1 && (
        <div className="p-4 border-t bg-muted/30 space-y-3">
          <div className="flex justify-between items-center gap-4">
             <div className="flex items-center gap-2 min-w-0">
               <CurrentToolIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
               <span className="text-xs font-medium text-foreground truncate" title={currentToolName}>
                 {currentToolName} {isStreaming && `(Running${dots})`}
               </span>
             </div>
            <span className="text-xs text-muted-foreground flex-shrink-0">
              Step {currentIndex + 1} of {totalCalls}
            </span>
          </div>
          <Slider
            min={0}
            max={totalCalls - 1}
            step={1}
            value={[currentIndex]}
            onValueChange={([newValue]) => onNavigate(newValue)}
            className="w-full [&>span:first-child]:h-1.5 [&>span:first-child>span]:h-1.5"
          />
        </div>
      )}
    </div>
  );
} 