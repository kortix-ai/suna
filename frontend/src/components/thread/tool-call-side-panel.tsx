import { Button } from "@/components/ui/button";
import { X, SkipBack, SkipForward } from "lucide-react";
import { Project } from "@/lib/api";
import { getToolIcon } from "@/components/thread/utils";
import React from "react";

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
  if (!isoString) return 'No timestamp';
  try {
    return new Date(isoString).toLocaleString();
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
  
  const renderContent = () => {
    if (!currentToolCall) {
      return (
        <div className="flex items-center justify-center h-full">
          <p className="text-sm text-muted-foreground">No tool call selected</p>
        </div>
      );
    }
    
    return (
      <GenericToolView 
        name={currentToolCall.assistantCall.name}
        assistantContent={currentToolCall.assistantCall.content}
        assistantTimestamp={currentToolCall.assistantCall.timestamp}
        toolContent={currentToolCall.toolResult?.content}
        isSuccess={currentToolCall.toolResult?.isSuccess}
        toolTimestamp={currentToolCall.toolResult?.timestamp}
      />
    );
  };
  
  return (
    <div className="fixed inset-y-0 right-0 w-[90%] sm:w-[450px] md:w-[500px] lg:w-[550px] xl:w-[600px] bg-background border-l flex flex-col z-10">
      <div className="p-4 flex items-center justify-between">
        <h3 className="text-sm font-medium">Tool Details</h3>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto">
        {renderContent()}
      </div>
      {totalCalls > 1 && (
        <div className="p-4 border-t flex items-center justify-between">
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => onNavigate(currentIndex - 1)} 
            disabled={currentIndex === 0}
          >
            <SkipBack className="h-4 w-4 mr-2" /> Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            {currentIndex + 1} of {totalCalls}
          </span>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => onNavigate(currentIndex + 1)}
            disabled={currentIndex === totalCalls - 1}
          >
            Next <SkipForward className="h-4 w-4 ml-2" />
          </Button>
        </div>
      )}
    </div>
  );
} 