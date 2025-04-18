import React from "react";
import { ToolViewProps } from "./types";
import { formatTimestamp } from "./utils";
import { getToolIcon } from "../utils";

export function GenericToolView({ 
  name, 
  assistantContent, 
  toolContent, 
  isSuccess = true, 
  assistantTimestamp, 
  toolTimestamp 
}: ToolViewProps & { name?: string }) {
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