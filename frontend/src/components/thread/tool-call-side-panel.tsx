import { Button } from "@/components/ui/button";
import { X, SkipBack, SkipForward } from "lucide-react";
import { Project } from "@/lib/api";
import { getToolIcon } from "@/components/thread/utils";
import React from "react";
import { Slider } from "@/components/ui/slider";

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

// Helper function to format timestamp
function formatTimestamp(isoString?: string): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    return isNaN(date.getTime()) ? 'Invalid date' : date.toLocaleString();
  } catch (e) {
    return 'Invalid date';
  }
}

// Simplified generic tool view
function GenericToolView({ 
  name, 
  assistantContent, 
  toolContent, 
  isSuccess = true, 
  assistantTimestamp, 
  toolTimestamp 
}: { 
  name?: string; 
  assistantContent?: string; 
  toolContent?: string;
  isSuccess?: boolean;
  assistantTimestamp?: string;
  toolTimestamp?: string;
}) {
  const toolName = name || 'Unknown Tool';
  
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
            {React.createElement(getToolIcon(toolName), { className: "h-4 w-4" })}
          </div>
          <div>
            <h4 className="text-sm font-medium">{toolName}</h4>
          </div>
        </div>
        
        {toolContent && (
          <div className={`px-2 py-1 rounded-full text-xs ${
            isSuccess ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
          }`}>
            {isSuccess ? 'Success' : 'Failed'}
          </div>
        )}
      </div>
      
      {/* Assistant Message */}
      <div className="space-y-1">
        <div className="flex justify-between items-center">
          <div className="text-xs font-medium text-muted-foreground">Assistant Message</div>
          {assistantTimestamp && (
            <div className="text-xs text-muted-foreground">{formatTimestamp(assistantTimestamp)}</div>
          )}
        </div>
        <div className="rounded-md border bg-muted/50 p-3">
          <pre className="text-xs overflow-auto whitespace-pre-wrap break-words">{assistantContent}</pre>
        </div>
      </div>
      
      {/* Tool Result */}
      {toolContent && (
        <div className="space-y-1">
          <div className="flex justify-between items-center">
            <div className="text-xs font-medium text-muted-foreground">Tool Result</div>
            {toolTimestamp && (
              <div className="text-xs text-muted-foreground">{formatTimestamp(toolTimestamp)}</div>
            )}
          </div>
          <div className={`rounded-md border p-3 ${isSuccess ? 'bg-muted/50' : 'bg-red-50'}`}>
            <pre className="text-xs overflow-auto whitespace-pre-wrap break-words">{toolContent}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

interface ToolCallSidePanelProps {
  isOpen: boolean;
  onClose: () => void;
  toolCalls: ToolCallInput[];
  currentIndex: number;
  onNavigate: (newIndex: number) => void;
  project?: Project;
}

export function ToolCallSidePanel({
  isOpen,
  onClose,
  toolCalls,
  currentIndex,
  onNavigate,
  project
}: ToolCallSidePanelProps) {
  if (!isOpen) return null;
  
  const currentToolCall = toolCalls[currentIndex];
  const totalCalls = toolCalls.length;
  const currentToolName = currentToolCall?.assistantCall?.name || 'Tool Call';
  const CurrentToolIcon = getToolIcon(currentToolName === 'Tool Call' ? 'unknown' : currentToolName);
  
  const renderContent = () => {
    if (!currentToolCall) {
      return (
        <div className="flex items-center justify-center h-full p-4">
          <p className="text-sm text-muted-foreground text-center">No tool call details available.</p>
        </div>
      );
    }
    
    return (
      <GenericToolView 
        name={currentToolCall.assistantCall.name}
        assistantContent={currentToolCall.assistantCall.content}
        assistantTimestamp={currentToolCall.assistantCall.timestamp}
        toolContent={currentToolCall.toolResult?.content}
        isSuccess={currentToolCall.toolResult?.isSuccess ?? true}
        toolTimestamp={currentToolCall.toolResult?.timestamp}
      />
    );
  };
  
  return (
    <div className="fixed inset-y-0 right-0 w-[90%] sm:w-[450px] md:w-[500px] lg:w-[550px] xl:w-[600px] bg-background border-l flex flex-col z-10">
      <div className="p-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Tool Details</h3>
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
                 {currentToolName}
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