import { Button } from "@/components/ui/button";
import { X, Package, Info, Terminal, CheckCircle, SkipBack, SkipForward, MonitorPlay, FileSymlink, FileDiff, FileEdit, Search, Globe, ExternalLink, Database, Code, ListFilter, Rocket, Laptop, Command, ArrowUpCircle, AlertTriangle, FileText, FilePlus } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Project } from "@/lib/api";
import { getToolIcon } from "@/components/thread/utils";
import React from "react";

// Define the structure for LIVE tool call data (from streaming)
export interface ToolCallData {
  id?: string;
  name?: string;
  arguments?: string;
  index?: number;
}

// Define the structure for HISTORICAL tool call pairs
export interface HistoricalToolPair {
  type: 'historical';
  assistantCall: { content?: string; name?: string }; // Include name from parsed content if needed
  userResult: { content?: string; name?: string };
}

// Union type for side panel content
export type SidePanelContent = ToolCallData | HistoricalToolPair;

// Type guard to check if content is a HistoricalToolPair
function isHistoricalPair(content: SidePanelContent | null): content is HistoricalToolPair {
  return content !== null && 'type' in content && content.type === 'historical';
}

interface ToolCallSidePanelProps {
  isOpen: boolean;
  onClose: () => void;
  content: SidePanelContent | null;
  currentIndex: number | null;
  totalPairs: number;
  onNavigate: (newIndex: number) => void;
  project?: Project; // Add project prop to access sandbox data
}


// Simplified function to extract XML content
function extractToolContent(content: string | undefined): { name?: string; arguments?: any; result?: string } {
  if (!content) return {};
  
  try {
    // For JSON-parsed content
    if (typeof content === 'string' && content.startsWith('{')) {
      try {
        const parsedContent = JSON.parse(content);
        if (parsedContent?.name) {
          return parsedContent;
        }
        
        // Check for content within the JSON
        if (parsedContent?.content) {
          // If content is an XML string, extract from it
          if (typeof parsedContent.content === 'string' && 
              (parsedContent.content.startsWith('<') || parsedContent.content.includes('<tool_result>'))) {
            const xmlResult = extractXmlFromString(parsedContent.content);
            if (xmlResult.name) return xmlResult;
          }
          return { result: parsedContent.content };
        }
    } catch (e) {
        // If JSON parsing fails, continue to XML parsing
        console.log('JSON parsing failed, trying XML', e);
      }
    }
    
    // For XML content
    return extractXmlFromString(content);
  } catch (e) {
    console.error('Error parsing tool content:', e);
    return {};
  }
}

// Helper to extract from XML strings
function extractXmlFromString(content: string): { name?: string; arguments?: any; result?: string } {
  if (!content || typeof content !== 'string') return {};

  // First, check for escaped JSON with XML content
  if (content.includes('\\n') && content.includes('\\\"')) {
    // Try to clean and parse the escaped content
    try {
      const unescaped = content.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      // Recursively try to extract from the unescaped content
      const result = extractXmlFromString(unescaped);
      if (result.name) return result;
    } catch (e) {
      // Continue with normal parsing if unescaping fails
    }
  }
  
  // Extract from tool_result format
  const toolResultMatch = content.match(/<tool_result>([\s\S]*?)<\/tool_result>/i);
  if (toolResultMatch) {
    const innerContent = toolResultMatch[1].trim();
    
    // Extract tool name and content - look for first XML tag
    const toolMatch = innerContent.match(/<([a-zA-Z\-_]+)>([\s\S]*?)<\/\1>/i);
    if (toolMatch) {
      return {
        name: toolMatch[1],
        result: toolMatch[2].trim()
      };
    }
    
    // Check for self-closing tags
    const selfClosingMatch = innerContent.match(/<([a-zA-Z\-_]+)(?:\s+([^>]*))?\/>/i);
    if (selfClosingMatch) {
      const attributes = selfClosingMatch[2] ? parseXmlAttributes(selfClosingMatch[2]) : {};
      return {
        name: selfClosingMatch[1],
        arguments: attributes
      };
    }
    
    return { result: innerContent };
  }
  
  // Handle common XML-inside-JSON patterns (assistant messages often contain these)
  if (content.includes('"content":')) {
    const contentMatch = content.match(/"content":\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
    if (contentMatch && contentMatch[1]) {
      try {
        // Unescape the content string
        const unescapedContent = JSON.parse(`"${contentMatch[1]}"`);
        if (unescapedContent.includes('<') && unescapedContent.includes('>')) {
          // Recursively extract from the content field
          const result = extractXmlFromString(unescapedContent);
          if (result.name) return result;
        }
      } catch (e) {
        // Continue with normal parsing if unescaping fails
      }
    }
  }
  
  // Extract from create-file or other similar XML patterns
  const createFileMatch = content.match(/<create-file\s+file_path=["']([^"']+)["']>([\s\S]*?)<\/create-file>/i);
  if (createFileMatch) {
    return {
      name: 'create-file',
      arguments: { file_path: createFileMatch[1] },
      result: createFileMatch[2].trim()
    };
  }
  
  // Extract from execute-command pattern
  const executeCommandMatch = content.match(/<execute-command(?:\s+[^>]*)?>([\s\S]*?)<\/execute-command>/i);
  if (executeCommandMatch) {
    return {
      name: 'execute-command',
      result: executeCommandMatch[1].trim()
    };
  }
  
  // Extract from standalone XML tag with content
  const xmlMatch = content.match(/<([a-zA-Z\-_]+)(?:\s+([^>]*))?>([\s\S]*?)<\/\1>/i);
  if (xmlMatch) {
    // Parse attributes if available
    const attributes = xmlMatch[2] ? parseXmlAttributes(xmlMatch[2]) : {};
    return {
      name: xmlMatch[1],
      arguments: attributes,
      result: xmlMatch[3].trim()
    };
  }
  
  // Extract from self-closing XML tag
  const selfClosingMatch = content.match(/<([a-zA-Z\-_]+)(?:\s+([^>]*))?\/>/i);
  if (selfClosingMatch) {
    const attributes = selfClosingMatch[2] ? parseXmlAttributes(selfClosingMatch[2]) : {};
                return {
      name: selfClosingMatch[1],
      arguments: attributes
    };
  }
  
  // Handle ToolResult format
  if (content.includes('ToolResult')) {
    const successMatch = content.match(/success=(True|False)/i);
    const outputMatch = content.match(/output=["']([^"']*)["']/i);
                
                return {
      result: outputMatch ? outputMatch[1] : content,
      arguments: { success: successMatch ? successMatch[1] === 'True' : undefined }
    };
  }
  
  return {};
}

// Helper to parse XML attributes into an object
function parseXmlAttributes(attributesString: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /(\w+)=["']([^"']*)["']/g;
  let match;
  
  while ((match = regex.exec(attributesString)) !== null) {
    result[match[1]] = match[2];
  }
  
  return result;
}

// Simplified generic tool view
function GenericToolView({ name, assistantContent, userContent }: { 
  name?: string; 
  assistantContent?: string; 
  userContent?: string 
}) {
  const extractedAssistant = assistantContent ? extractToolContent(assistantContent) : {};
  const extractedUser = userContent ? extractToolContent(userContent) : {};
  
  // Get the best tool name from the provided data
  const getDisplayToolName = (): string => {
    // Explicitly provided name has highest priority
    if (name) return name;
    
    // Next check the extracted assistant content
    if (extractedAssistant.name) return extractedAssistant.name;
    
    // Try to extract tool name from XML in assistant content
    if (typeof assistantContent === 'string') {
      // Look for XML tags like <create-file> or <execute-command>
      const xmlTagMatch = assistantContent.match(/<([a-zA-Z\-_]+)(?:\s|>)/);
      if (xmlTagMatch && xmlTagMatch[1]) {
        return xmlTagMatch[1];
      }
    }
    
    // Fallback to extracted user content name
    if (extractedUser.name) return extractedUser.name;
    
    return 'Unknown Tool';
  };
  
  const toolName = getDisplayToolName();
  
  // Get the file path if available
  const getFilePath = (): string | undefined => {
    // Check extracted arguments first
    if (extractedAssistant.arguments?.file_path) {
      return extractedAssistant.arguments.file_path;
    }
    
    // Try to extract from raw assistant content
    if (typeof assistantContent === 'string') {
      const filePathMatch = assistantContent.match(/file_path=["']([^"']+)["']/);
      if (filePathMatch && filePathMatch[1]) {
        return filePathMatch[1];
      }
    }
    
    return undefined;
  };
  
  const filePath = getFilePath();
  
  const args = extractedAssistant.arguments ? 
    (typeof extractedAssistant.arguments === 'string' ? 
      extractedAssistant.arguments : 
      JSON.stringify(extractedAssistant.arguments, null, 2)) : 
    assistantContent;
  
  const result = extractedUser.result || userContent;
  
  // Determine if the tool operation was successful
  const isSuccess = result && 
    (result.includes('success=True') || 
     result.includes('Successfully') || 
     result.includes('created successfully') ||
     !result.includes('error') && 
     !result.includes('failed') && 
     !result.includes('failure'));
  
  // For debugging - extract message IDs if available
  const getMessageIds = (): { assistantId?: string, toolResultId?: string } => {
    try {
      // Try to extract the assistant message ID
      if (typeof assistantContent === 'string') {
        // Look for message_id in JSON
        const messageIdMatch = assistantContent.match(/"message_id":\s*"([^"]+)"/);
        if (messageIdMatch && messageIdMatch[1]) {
          return { assistantId: messageIdMatch[1] };
        }
      }
      
      // Try to extract the assistant_message_id from tool result metadata
      if (typeof userContent === 'string') {
        // Look for assistant_message_id in metadata
        const metadataMatch = userContent.match(/"assistant_message_id":\s*"([^"]+)"/);
        if (metadataMatch && metadataMatch[1]) {
          return { toolResultId: metadataMatch[1] };
        }
        
        // Look for metadata in JSON
        const jsonMatch = userContent.match(/"metadata":\s*({[^}]+})/);
        if (jsonMatch && jsonMatch[1]) {
          try {
            const metadata = JSON.parse(jsonMatch[1].replace(/\\"/g, '"'));
            if (metadata.assistant_message_id) {
              return { toolResultId: metadata.assistant_message_id };
        }
      } catch (e) {
            // Silently fail if JSON parsing fails
          }
        }
      }
      
      return {};
    } catch (e) {
      return {};
    }
  };
  
  const ids = getMessageIds();
  
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
            {React.createElement(getToolIcon(toolName), { className: "h-4 w-4" })}
        </div>
          <div>
            <h4 className="text-sm font-medium">{toolName}</h4>
            {filePath && (
              <p className="text-xs text-muted-foreground">
                {filePath}
              </p>
        )}
      </div>
    </div>
        
        {userContent && (
          <div className={`px-2 py-1 rounded-full text-xs ${
            isSuccess ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
          }`}>
            {isSuccess ? 'Success' : 'Failed'}
        </div>
        )}
      </div>
      
      {/* Tool input */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium text-muted-foreground">Input</div>
          {ids.assistantId && (
            <div className="text-xs text-muted-foreground/50">ID: {ids.assistantId.substring(0, 8)}</div>
        )}
      </div>
        <div className="rounded-md border bg-muted/50 p-3">
          <pre className="text-xs overflow-auto whitespace-pre-wrap break-words">{args}</pre>
        </div>
      </div>
      
      {/* Tool result */}
      {userContent && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted-foreground">Result</div>
            {ids.toolResultId && (
              <div className="text-xs text-muted-foreground/50">Links to: {ids.toolResultId.substring(0, 8)}</div>
        )}
      </div>
          <div className={`rounded-md border p-3 ${isSuccess ? 'bg-muted/50' : 'bg-red-50'}`}>
            <pre className="text-xs overflow-auto whitespace-pre-wrap break-words">{result}</pre>
    </div>
        </div>
      )}
    </div>
  );
}

export function ToolCallSidePanel({
  isOpen,
  onClose,
  content,
  currentIndex,
  totalPairs,
  onNavigate,
  project
}: ToolCallSidePanelProps) {
  if (!isOpen) return null;
  
  // Get base URL for VNC preview if available
  const vncPreviewUrl = project?.sandbox?.vnc_preview || '';

  const renderContent = () => {
    if (!content) {
  return (
        <div className="flex items-center justify-center h-full">
          <p className="text-sm text-muted-foreground">No tool call selected</p>
              </div>
      );
    }
    
    if (isHistoricalPair(content)) {
      // For historical tool calls
      return (
        <GenericToolView 
          name={content.assistantCall.name}
          assistantContent={content.assistantCall.content}
          userContent={content.userResult.content}
        />
      );
    } else {
      // For active tool calls
      return (
        <GenericToolView 
          name={content.name}
          assistantContent={content.arguments}
          userContent={undefined}
        />
      );
    }
  };
  
  return (
    <div className="fixed inset-y-0 right-0 w-96 bg-background border-l shadow-lg flex flex-col z-10">
      <div className="p-4 border-b flex items-center justify-between">
        <h3 className="text-sm font-medium">Tool Details</h3>
        <Button variant="ghost" size="icon" onClick={onClose}>
                  <X className="h-4 w-4" />
                </Button>
                      </div>

      <div className="flex-1 overflow-auto">
        {renderContent()}
                  </div>
                  
      {totalPairs > 1 && (
        <div className="p-4 border-t flex items-center justify-between">
                  <Button 
            variant="outline" 
            size="sm" 
            onClick={() => onNavigate(currentIndex! - 1)} 
                    disabled={currentIndex === 0}
                  >
            <SkipBack className="h-4 w-4 mr-2" /> Previous
                  </Button>
          <span className="text-xs text-muted-foreground">
            {currentIndex! + 1} of {totalPairs}
          </span>
                  <Button 
            variant="outline" 
            size="sm" 
            onClick={() => onNavigate(currentIndex! + 1)}
                    disabled={currentIndex === totalPairs - 1}
                  >
            Next <SkipForward className="h-4 w-4 ml-2" />
                  </Button>
                  </div>
      )}
    </div>
  );
} 