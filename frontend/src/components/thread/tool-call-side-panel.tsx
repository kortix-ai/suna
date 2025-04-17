import { Button } from "@/components/ui/button";
import { X, Package, Info, Terminal, CheckCircle, SkipBack, SkipForward, MonitorPlay, FileSymlink, FileDiff, FileEdit, Search, Globe, ExternalLink, Database, Code, ListFilter, Rocket, Laptop, Command, ArrowUpCircle } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Project } from "@/lib/api";
import { TodoPanel } from "./todo-panel";

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
  return !!content && (content as HistoricalToolPair).type === 'historical';
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

// Extract command from execute-command content
function extractCommand(content: string | undefined): string | null {
  if (!content) return null;
  const commandMatch = content.match(/<execute-command>([\s\S]*?)<\/execute-command>/);
  return commandMatch ? commandMatch[1].trim() : null;
}

// Extract output from tool result content
function extractCommandOutput(content: string | undefined): string | null {
  if (!content) return null;
  if (!content.includes('ToolResult')) return null;
  
  // Extract the raw output string which contains the JSON-like structure
  const outputMatch = content.match(/output='([\s\S]+?)(?='\))/);
  if (!outputMatch || !outputMatch[1]) return null;
  
  try {
    // Extract just the "output" field using regex instead of trying to parse the entire JSON
    const outputContentMatch = outputMatch[1].match(/"output":\s*"([\s\S]*?)(?=",[^,]*"exit_code")/);
    if (outputContentMatch && outputContentMatch[1]) {
      // Unescape the inner content
      return outputContentMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    
    // Fallback: Return the raw match for display if we can't extract the specific field
    return outputMatch[1];
  } catch (e) {
    console.error("Failed to extract command output", e);
    return outputMatch[1]; // Return the raw match on parsing error
  }
}

// Component for handling unified execute-command tool calls
function CommandToolView({ assistantContent, userContent }: { assistantContent?: string; userContent?: string }) {
  const command = extractCommand(assistantContent);
  const output = extractCommandOutput(userContent);
  
  // Extract exit code if available
  const getExitCode = (): number | null => {
    if (!userContent) return null;
    
    try {
      const exitCodeMatch = userContent.match(/"exit_code":\s*(\d+)/);
      if (exitCodeMatch && exitCodeMatch[1]) {
        return parseInt(exitCodeMatch[1], 10);
      }
      return null;
    } catch (e) {
      return null;
    }
  };
  
  const exitCode = getExitCode();
  const isSuccessful = exitCode === 0;
  
  return (
    <div className="border rounded-md overflow-hidden">
      <div className="flex items-center p-2 bg-muted justify-between">
        <div className="flex items-center">
          <Terminal className="h-4 w-4 mr-2 text-muted-foreground" />
          <span className="text-sm font-medium">Terminal</span>
        </div>
        {exitCode !== null && (
          <span className={`text-xs flex items-center ${isSuccessful ? 'text-green-600' : 'text-red-600'}`}>
            <span className="h-1.5 w-1.5 rounded-full mr-1.5 animate-pulse bg-current"></span>
            Exit: {exitCode}
          </span>
        )}
      </div>
      
      <div className="px-4 py-2 border-t border-b bg-muted/50 flex justify-between items-center">
        {command && (
          <div className="text-xs font-mono truncate flex items-center space-x-2">
            <span className="text-muted-foreground">Command:</span>
            <span className="bg-muted px-2 py-0.5 rounded">{command}</span>
          </div>
        )}
      </div>
      
      <div className={`terminal-container overflow-auto max-h-[500px] ${output ? 'bg-muted/10' : 'bg-muted/5'}`}>
        <div className="p-4 font-mono text-sm space-y-3">
          {command && output && (
            <>
              <div className="flex items-start">
                <span className="text-emerald-600 dark:text-emerald-400 shrink-0 mr-2">$</span>
                <span className="font-semibold">{command}</span>
              </div>
              
              <div className="text-muted-foreground whitespace-pre-wrap break-all text-sm">
                {output}
              </div>
              </>
            )}
          
          {command && !output && (
            <div className="text-center p-6">
              <div className="animate-pulse flex justify-center">
                <div className="h-1 w-1 mx-0.5 bg-muted-foreground rounded-full"></div>
                <div className="h-1 w-1 mx-0.5 bg-muted-foreground rounded-full animation-delay-200"></div>
                <div className="h-1 w-1 mx-0.5 bg-muted-foreground rounded-full animation-delay-500"></div>
              </div>
              <p className="text-xs text-muted-foreground mt-2">Command running...</p>
            </div>
          )}
          
          {!command && !output && (
            <div className="text-center p-6">
              <Terminal className="h-6 w-6 mx-auto mb-2 text-muted-foreground opacity-40" />
              <p className="text-muted-foreground">No command available</p>
      </div>
          )}
        </div>
      </div>
      
      {isSuccessful && output && (
        <div className="border-t px-4 py-2 bg-green-50 dark:bg-green-950/10 flex items-center">
          <CheckCircle className="h-4 w-4 text-green-600 mr-2" />
          <span className="text-xs text-green-700 dark:text-green-400">Command completed successfully</span>
        </div>
      )}
      
      {exitCode !== null && !isSuccessful && (
        <div className="border-t px-4 py-2 bg-red-50 dark:bg-red-950/10 flex items-center">
          <X className="h-4 w-4 text-red-600 mr-2" />
          <span className="text-xs text-red-700 dark:text-red-400">Command failed with exit code {exitCode}</span>
        </div>
      )}
    </div>
  );
}

// Component for handling str-replace tool calls with diff view
function StrReplaceToolView({ assistantContent, userContent }: { assistantContent?: string; userContent?: string }) {
  if (!assistantContent) return <div>No content available</div>;
  
  // Extract old and new strings for a diff view
  const oldMatch = assistantContent.match(/<old_str>([\s\S]*?)<\/old_str>/);
  const newMatch = assistantContent.match(/<new_str>([\s\S]*?)<\/new_str>/);
  
  const oldStr = oldMatch ? oldMatch[1] : null;
  const newStr = newMatch ? newMatch[1] : null;
  
  // Extract file path from the content
  const filePathMatch = assistantContent.match(/file_path=["']([\s\S]*?)["']/);
  const filePath = filePathMatch ? filePathMatch[1] : "Unknown file";
  
  // Extract success status from user result
  const isSuccess = userContent?.includes('success=True') || userContent?.includes('Replacement successful');
  
  if (!oldStr || !newStr) {
    return <pre className="text-xs font-mono bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
      {assistantContent}
    </pre>;
  }
  
  // Generate a line-by-line diff with highlighting
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  
  // Simple diff algorithm to find line differences
  // This is a basic implementation - for a real app, consider using a library like 'diff' or 'jsdiff'
  const computeDiff = () => {
    // For unchanged sections, show as is
    // For changed lines, mark as either added/removed
    // For consecutive changes, try to highlight just the changed characters within the line
    
    type DiffLine = {
      type: 'unchanged' | 'removed' | 'added' | 'modified';
      oldIndex?: number;
      newIndex?: number;
      oldContent?: string;
      newContent?: string;
      // For modified lines, we highlight the specific changes:
      highlights?: {
        oldParts: { text: string; highlighted: boolean }[];
        newParts: { text: string; highlighted: boolean }[];
      };
      // Add a unique key for React rendering
      key: string;
    };
    
    const diff: DiffLine[] = [];
    
    // Very simple diff algorithm that identifies changed, added, removed lines
    // and tries to highlight word-level changes for modified lines
    let oldIndex = 0;
    let newIndex = 0;
    
    while (oldIndex < oldLines.length || newIndex < newLines.length) {
      const oldLine = oldIndex < oldLines.length ? oldLines[oldIndex] : null;
      const newLine = newIndex < newLines.length ? newLines[newIndex] : null;
      
      // If lines are identical, add as unchanged
      if (oldLine !== null && newLine !== null && oldLine === newLine) {
        diff.push({
          type: 'unchanged',
          oldIndex,
          newIndex,
          oldContent: oldLine,
          key: `unchanged-${oldIndex}-${newIndex}`
        });
        oldIndex++;
        newIndex++;
        continue;
      }
      
      // Check if this is a modified line (not identical but similar)
      if (oldLine !== null && newLine !== null && oldLine !== newLine) {
        // This is a naive character-level highlighter - a real implementation would use
        // a proper diff algorithm to get word-level differences
        
        // Try to identify character differences
        let i = 0;
        let j = 0;
        let oldParts: { text: string; highlighted: boolean }[] = [];
        let newParts: { text: string; highlighted: boolean }[] = [];
        
        // Find common prefix
        let prefixLength = 0;
        while (prefixLength < oldLine.length && prefixLength < newLine.length && 
              oldLine[prefixLength] === newLine[prefixLength]) {
          prefixLength++;
        }
        
        // Find common suffix
        let oldSuffixStart = oldLine.length;
        let newSuffixStart = newLine.length;
        while (oldSuffixStart > prefixLength && newSuffixStart > prefixLength &&
              oldLine[oldSuffixStart - 1] === newLine[newSuffixStart - 1]) {
          oldSuffixStart--;
          newSuffixStart--;
        }
        
        // Add parts
        if (prefixLength > 0) {
          oldParts.push({ text: oldLine.substring(0, prefixLength), highlighted: false });
          newParts.push({ text: newLine.substring(0, prefixLength), highlighted: false });
        }
        
        // Add the changed middle part
        if (oldSuffixStart > prefixLength) {
          oldParts.push({ text: oldLine.substring(prefixLength, oldSuffixStart), highlighted: true });
        }
        if (newSuffixStart > prefixLength) {
          newParts.push({ text: newLine.substring(prefixLength, newSuffixStart), highlighted: true });
        }
        
        // Add the common suffix
        if (oldSuffixStart < oldLine.length) {
          oldParts.push({ text: oldLine.substring(oldSuffixStart), highlighted: false });
          newParts.push({ text: newLine.substring(newSuffixStart), highlighted: false });
        }
        
        diff.push({
          type: 'modified',
          oldIndex,
          newIndex,
          oldContent: oldLine,
          newContent: newLine,
          highlights: {
            oldParts,
            newParts
          },
          key: `modified-${oldIndex}-${newIndex}`
        });
        
        oldIndex++;
        newIndex++;
        continue;
      }
      
      // Handle added/removed lines
      if (oldLine === null) {
        // This is a new line
        diff.push({
          type: 'added',
          newIndex,
          newContent: newLine,
          key: `added-${newIndex}`
        });
        newIndex++;
      } else if (newLine === null) {
        // This is a removed line
        diff.push({
          type: 'removed',
          oldIndex,
          oldContent: oldLine,
          key: `removed-${oldIndex}`
        });
        oldIndex++;
      } else {
        // This is a line that needs to be replaced
        // Look ahead to see if there's a better match
        let foundMatch = false;
        
        // Simple lookahead to find potentially better matches
        // (in a real implementation, you'd use a proper diff algorithm)
        const lookAheadLimit = 3; // Only look a few lines ahead
        
        for (let lookAhead = 1; lookAhead <= lookAheadLimit && newIndex + lookAhead < newLines.length; lookAhead++) {
          if (oldLine === newLines[newIndex + lookAhead]) {
            // Found a match ahead - mark intermediate lines as added
            for (let i = 0; i < lookAhead; i++) {
              diff.push({
                type: 'added',
                newIndex: newIndex + i,
                newContent: newLines[newIndex + i],
                key: `added-lookahead-${newIndex + i}`
              });
            }
            foundMatch = true;
            newIndex += lookAhead;
            break;
          }
        }
        
        if (!foundMatch) {
          for (let lookAhead = 1; lookAhead <= lookAheadLimit && oldIndex + lookAhead < oldLines.length; lookAhead++) {
            if (newLine === oldLines[oldIndex + lookAhead]) {
              // Found a match ahead - mark intermediate lines as removed
              for (let i = 0; i < lookAhead; i++) {
                diff.push({
                  type: 'removed',
                  oldIndex: oldIndex + i,
                  oldContent: oldLines[oldIndex + i],
                  key: `removed-lookahead-${oldIndex + i}`
                });
              }
              foundMatch = true;
              oldIndex += lookAhead;
              break;
            }
          }
        }
        
        if (!foundMatch) {
          // No good match found, mark as separate remove/add
          diff.push({
            type: 'removed',
            oldIndex,
            oldContent: oldLine,
            key: `removed-nomatch-${oldIndex}`
          });
          diff.push({
            type: 'added',
            newIndex,
            newContent: newLine,
            key: `added-nomatch-${newIndex}`
          });
          oldIndex++;
          newIndex++;
        }
      }
    }
    
    return diff;
  };
  
  const diffResult = computeDiff();
  
  return (
    <div className="border rounded-md overflow-hidden">
      <div className="flex items-center p-2 bg-muted justify-between">
        <div className="flex items-center">
          <FileDiff className="h-4 w-4 mr-2 text-muted-foreground" />
          <span className="text-sm font-medium">File Changes</span>
        </div>
        {isSuccess && (
          <span className="text-xs text-green-600 flex items-center">
            <CheckCircle className="h-3 w-3 mr-1" /> Applied
          </span>
        )}
      </div>
      
      <div className="px-2 py-1 border-t border-b bg-muted/50 flex justify-between items-center">
        <code className="text-xs font-mono">{filePath}</code>
        <span className="text-xs text-muted-foreground">{diffResult.filter(d => d.type !== 'unchanged').length} changes</span>
      </div>
      
      <div className="overflow-auto bg-muted/20 max-h-[500px]">
        <table className="w-full border-collapse text-xs font-mono">
          <tbody>
            {diffResult.map((line, idx) => {
              // Skip unchanged lines if they're not adjacent to changed ones
              // (to keep the diff focused on changes but maintain some context)
              const prevChanged = idx > 0 && diffResult[idx - 1].type !== 'unchanged';
              const nextChanged = idx < diffResult.length - 1 && diffResult[idx + 1].type !== 'unchanged';
              const isContextLine = line.type === 'unchanged' && (prevChanged || nextChanged);
              
              // Hide unchanged lines that aren't providing context
              if (line.type === 'unchanged' && !isContextLine && idx !== 0 && idx !== diffResult.length - 1) {
                // Show a separator for collapsed sections
                const prevHidden = idx > 1 && diffResult[idx - 1].type === 'unchanged' && !prevChanged;
                if (!prevHidden) {
                  return (
                    <tr key={`collapse-${idx}`} className="text-center text-muted-foreground">
                      <td className="border-r px-2 py-0.5 border-muted w-12 text-right"></td>
                      <td className="px-4 py-1" colSpan={2}>
                        <div className="flex items-center justify-center gap-1">
                          <span className="h-px bg-muted flex-1" />
                          <span className="px-2">⋯</span>
                          <span className="h-px bg-muted flex-1" />
                        </div>
                      </td>
                    </tr>
                  );
                }
                return null;
              }
              
              if (line.type === 'unchanged') {
                return (
                  <tr key={`u-${line.oldIndex}`} className="hover:bg-muted/50">
                    <td className="border-r px-2 py-0.5 border-muted w-12 text-right text-muted-foreground">
                      {line.oldIndex !== undefined && line.oldIndex + 1}
                    </td>
                    <td className="px-4 py-0.5 whitespace-pre-wrap break-all">
                      {line.oldContent}
                    </td>
                  </tr>
                );
              }
              
              if (line.type === 'added') {
                return (
                  <tr key={`a-${line.newIndex}`} className="bg-green-50 dark:bg-green-950/20 hover:bg-green-100 dark:hover:bg-green-950/30">
                    <td className="border-r px-2 py-0.5 border-muted w-12 text-right text-muted-foreground">
                      {line.newIndex !== undefined && line.newIndex + 1}
                    </td>
                    <td className="px-4 py-0.5 whitespace-pre-wrap break-all text-green-700 dark:text-green-400">
                      <span className="inline-block w-4">+</span>
                      {line.newContent}
                    </td>
                  </tr>
                );
              }
              
              if (line.type === 'removed') {
                return (
                  <tr key={`r-${line.oldIndex}`} className="bg-red-50 dark:bg-red-950/20 hover:bg-red-100 dark:hover:bg-red-950/30">
                    <td className="border-r px-2 py-0.5 border-muted w-12 text-right text-muted-foreground">
                      {line.oldIndex !== undefined && line.oldIndex + 1}
                    </td>
                    <td className="px-4 py-0.5 whitespace-pre-wrap break-all text-red-700 dark:text-red-400">
                      <span className="inline-block w-4">−</span>
                      {line.oldContent}
                    </td>
                  </tr>
                );
              }
              
              if (line.type === 'modified') {
                // Show both lines with character-level highlighting
                return (
                  <>
                    <tr key={`rm-${line.oldIndex}`} className="bg-red-50 dark:bg-red-950/20 hover:bg-red-100 dark:hover:bg-red-950/30">
                      <td className="border-r px-2 py-0.5 border-muted w-12 text-right text-muted-foreground">
                        {line.oldIndex !== undefined && line.oldIndex + 1}
                      </td>
                      <td className="px-4 py-0.5 whitespace-pre-wrap break-all text-red-700 dark:text-red-400">
                        <span className="inline-block w-4">−</span>
                        {line.highlights ? (
                          <span>
                            {line.highlights.oldParts.map((part, i) => (
                              <span key={i} className={part.highlighted ? 'bg-red-200 dark:bg-red-900/50' : ''}>
                                {part.text}
                              </span>
                            ))}
                          </span>
                        ) : line.oldContent}
                      </td>
                    </tr>
                    <tr key={`am-${line.newIndex}`} className="bg-green-50 dark:bg-green-950/20 hover:bg-green-100 dark:hover:bg-green-950/30">
                      <td className="border-r px-2 py-0.5 border-muted w-12 text-right text-muted-foreground">
                        {line.newIndex !== undefined && line.newIndex + 1}
                      </td>
                      <td className="px-4 py-0.5 whitespace-pre-wrap break-all text-green-700 dark:text-green-400">
                        <span className="inline-block w-4">+</span>
                        {line.highlights ? (
                          <span>
                            {line.highlights.newParts.map((part, i) => (
                              <span key={i} className={part.highlighted ? 'bg-green-200 dark:bg-green-900/50' : ''}>
                                {part.text}
                              </span>
                            ))}
                          </span>
                        ) : line.newContent}
                      </td>
                    </tr>
                  </>
                );
              }
              
              return null;
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Component for browser-related tool calls that shows the VNC preview
function BrowserToolView({ assistantContent, userContent, vncPreviewUrl }: { 
  assistantContent?: string; 
  userContent?: string;
  vncPreviewUrl?: string;
}) {
  // Try to extract URL from content if applicable
  const urlMatch = assistantContent?.match(/url=["'](https?:\/\/[^"']+)["']/);
  const targetUrl = urlMatch ? urlMatch[1] : null;
  
  // Check if the browser operation was successful
  const isSuccess = userContent?.includes('success=True') || userContent?.includes('Successfully');
  
  if (!vncPreviewUrl) {
    return (
      <div className="border rounded-md p-3 text-center">
        <MonitorPlay className="h-10 w-10 mx-auto mb-2 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">Browser preview not available</p>
        <pre className="mt-3 text-xs font-mono bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
          {assistantContent}
        </pre>
      </div>
    );
  }
  
  return (
    <div className="border rounded-md overflow-hidden">
      <div className="bg-muted p-2 flex items-center justify-between border-b">
        <div className="flex items-center">
          <MonitorPlay className="h-4 w-4 mr-2 text-muted-foreground" />
          <span className="text-sm font-medium">Browser Window</span>
        </div>
        {targetUrl && (
          <div className="text-xs font-mono text-muted-foreground truncate max-w-[200px]">
            {targetUrl}
          </div>
        )}
      </div>
      <div className="aspect-video relative bg-black">
        <iframe
          src={vncPreviewUrl}
          title="Browser preview"
          className="w-full h-full"
          style={{ minHeight: "400px" }}
          frameBorder="0"
          allowFullScreen
        />
      </div>
      {isSuccess && (
        <div className="px-3 py-2 border-t bg-green-50 dark:bg-green-950/20 text-green-700 dark:text-green-300 text-xs flex items-center">
          <CheckCircle className="h-3 w-3 mr-2" /> 
          Operation completed successfully
        </div>
      )}
    </div>
  );
}

// Determine which specialized view to use based on tool name
function getUnifiedToolView(toolName: string | undefined, assistantContent: string | undefined, userContent: string | undefined, vncPreviewUrl?: string) {
  if (!toolName) return null;
  
  const lowerToolName = toolName.toLowerCase();
  
  // Check for deploy commands first
  if (lowerToolName === 'deploy' || (assistantContent && assistantContent.includes('<deploy'))) {
    return <DeployToolView assistantContent={assistantContent} userContent={userContent} />;
  }
  
  if (lowerToolName === 'execute-command' || (assistantContent && assistantContent.includes('<execute-command>'))) {
    return <CommandToolView assistantContent={assistantContent} userContent={userContent} />;
  }
  
  if (lowerToolName === 'str-replace' || (assistantContent && assistantContent.includes('<str-replace'))) {
    return <StrReplaceToolView assistantContent={assistantContent} userContent={userContent} />;
  }
  
  if ((lowerToolName.includes('browser') || lowerToolName.includes('browse')) && vncPreviewUrl) {
    return <BrowserToolView assistantContent={assistantContent} userContent={userContent} vncPreviewUrl={vncPreviewUrl} />;
  }
  
  // File operation tools
  if (lowerToolName === 'create-file' || lowerToolName === 'create_file' || 
      (assistantContent && assistantContent.includes('<create-file'))) {
    return <FileCreationToolView assistantContent={assistantContent} userContent={userContent} />;
  }
  
  if (lowerToolName === 'full-file-rewrite' || lowerToolName === 'full_file_rewrite' || 
      (assistantContent && assistantContent.includes('<full-file-rewrite'))) {
    return <FileRewriteToolView assistantContent={assistantContent} userContent={userContent} />;
  }
  
  if (lowerToolName === 'delete-file' || lowerToolName === 'delete_file' || 
      (assistantContent && assistantContent.includes('<delete-file'))) {
    return <FileDeleteToolView assistantContent={assistantContent} userContent={userContent} />;
  }
  
  // Web search tools
  if (lowerToolName === 'web-search' || lowerToolName === 'web_search' ||
      (assistantContent && assistantContent.includes('<web-search'))) {
    return <WebSearchToolView assistantContent={assistantContent} userContent={userContent} />;
  }
  
  if (lowerToolName === 'crawl-webpage' || lowerToolName === 'crawl_webpage' ||
      (assistantContent && assistantContent.includes('<crawl-webpage'))) {
    return <WebCrawlToolView assistantContent={assistantContent} userContent={userContent} />;
  }
  
  // Text editor tools
  if (lowerToolName.includes('text_editor') || lowerToolName.includes('text-editor')) {
    return <TextEditorToolView assistantContent={assistantContent} userContent={userContent} />;
  }
  
  // Data provider tools
  if (lowerToolName === 'get-data-provider-endpoints' || lowerToolName === 'get_data_provider_endpoints' || 
      (assistantContent && assistantContent.includes('<get-data-provider-endpoints'))) {
    return <DataProviderEndpointsView assistantContent={assistantContent} userContent={userContent} />;
  }
  
  if (lowerToolName === 'execute-data-provider-call' || lowerToolName === 'execute_data_provider_call' || 
      (assistantContent && assistantContent.includes('<execute-data-provider-call'))) {
    return <DataProviderCallView assistantContent={assistantContent} userContent={userContent} />;
  }
  
  // Default view - just return null and let the caller handle it
  return null;
}

// Component for file creation tool
function FileCreationToolView({ assistantContent, userContent }: { assistantContent?: string; userContent?: string }) {
  if (!assistantContent) return <div>No content available</div>;
  
  // Extract file path and content
  const filePathMatch = assistantContent.match(/file_path=["']([\s\S]*?)["']/);
  const filePath = filePathMatch ? filePathMatch[1] : "Unknown file";
  
  // Extract content between tags
  const contentMatch = assistantContent.match(/<create-file[\s\S]*?>([\s\S]*?)<\/create-file>/);
  const fileContent = contentMatch ? contentMatch[1] : "";
  
  // Check if operation was successful
  const isSuccess = userContent?.includes('success=True') || userContent?.includes('created successfully');
  
  // Determine file type for syntax highlighting (basic implementation)
  const getFileType = (path: string): string => {
    const extension = path.split('.').pop()?.toLowerCase() || '';
    switch (extension) {
      case 'js': return 'JavaScript';
      case 'ts': return 'TypeScript';
      case 'jsx': case 'tsx': return 'React';
      case 'py': return 'Python';
      case 'html': return 'HTML';
      case 'css': return 'CSS';
      case 'json': return 'JSON';
      case 'md': return 'Markdown';
      default: return extension.toUpperCase() || 'Text';
    }
  };
  
  return (
    <div className="border rounded-md overflow-hidden">
      <div className="flex items-center p-2 bg-muted justify-between">
        <div className="flex items-center">
          <FileSymlink className="h-4 w-4 mr-2 text-muted-foreground" />
          <span className="text-sm font-medium">Create New File</span>
        </div>
        {isSuccess && (
          <span className="text-xs text-green-600 flex items-center">
            <CheckCircle className="h-3 w-3 mr-1" /> Created
          </span>
        )}
      </div>
      
      <div className="px-2 py-1 border-t border-b bg-muted/50 flex justify-between items-center">
        <code className="text-xs font-mono">{filePath}</code>
        <span className="text-xs text-muted-foreground">{getFileType(filePath)}</span>
      </div>
      
      <div className="overflow-auto bg-muted/20 max-h-[500px]">
        <pre className="text-xs font-mono p-3 whitespace-pre-wrap break-all">
          {fileContent}
        </pre>
      </div>
    </div>
  );
}

// Component for full file rewrite tool
function FileRewriteToolView({ assistantContent, userContent }: { assistantContent?: string; userContent?: string }) {
  if (!assistantContent) return <div>No content available</div>;
  
  // Extract file path and content
  const filePathMatch = assistantContent.match(/file_path=["']([\s\S]*?)["']/);
  const filePath = filePathMatch ? filePathMatch[1] : "Unknown file";
  
  // Extract content between tags
  const contentMatch = assistantContent.match(/<full-file-rewrite[\s\S]*?>([\s\S]*?)<\/full-file-rewrite>/);
  const fileContent = contentMatch ? contentMatch[1] : "";
  
  // Check if operation was successful
  const isSuccess = userContent?.includes('success=True') || userContent?.includes('rewritten successfully');
  
  // Determine file type for syntax highlighting (basic implementation)
  const getFileType = (path: string): string => {
    const extension = path.split('.').pop()?.toLowerCase() || '';
    switch (extension) {
      case 'js': return 'JavaScript';
      case 'ts': return 'TypeScript';
      case 'jsx': case 'tsx': return 'React';
      case 'py': return 'Python';
      case 'html': return 'HTML';
      case 'css': return 'CSS';
      case 'json': return 'JSON';
      case 'md': return 'Markdown';
      default: return extension.toUpperCase() || 'Text';
    }
  };
  
  return (
    <div className="border rounded-md overflow-hidden">
      <div className="flex items-center p-2 bg-muted justify-between">
        <div className="flex items-center">
          <FileEdit className="h-4 w-4 mr-2 text-muted-foreground" />
          <span className="text-sm font-medium">File Rewrite</span>
        </div>
        {isSuccess && (
          <span className="text-xs text-green-600 flex items-center">
            <CheckCircle className="h-3 w-3 mr-1" /> Updated
          </span>
        )}
      </div>
      
      <div className="px-2 py-1 border-t border-b bg-muted/50 flex justify-between items-center">
        <code className="text-xs font-mono">{filePath}</code>
        <span className="text-xs text-muted-foreground">{getFileType(filePath)}</span>
      </div>
      
      <div className="overflow-auto bg-muted/20 max-h-[500px]">
        <pre className="text-xs font-mono p-3 whitespace-pre-wrap break-all">
          {fileContent}
        </pre>
      </div>
    </div>
  );
}

// Component for file deletion tool
function FileDeleteToolView({ assistantContent, userContent }: { assistantContent?: string; userContent?: string }) {
  if (!assistantContent) return <div>No content available</div>;
  
  // Extract file path
  const filePathMatch = assistantContent.match(/file_path=["']([\s\S]*?)["']/);
  const filePath = filePathMatch ? filePathMatch[1] : "Unknown file";
  
  // Check if operation was successful
  const isSuccess = userContent?.includes('success=True') || userContent?.includes('deleted successfully');
  
  return (
    <div className="border rounded-md overflow-hidden">
      <div className="flex items-center p-2 bg-muted justify-between">
        <div className="flex items-center text-red-500">
          <X className="h-4 w-4 mr-2" />
          <span className="text-sm font-medium">Delete File</span>
        </div>
        {isSuccess && (
          <span className="text-xs text-green-600 flex items-center">
            <CheckCircle className="h-3 w-3 mr-1" /> Deleted
          </span>
        )}
      </div>
      
      <div className="p-4 flex items-center justify-center">
        <div className="bg-red-50 dark:bg-red-950/20 rounded-md p-3 text-center text-red-700 dark:text-red-400">
          <code className="text-sm font-mono">{filePath}</code>
          <p className="text-xs mt-1">This file has been deleted</p>
        </div>
      </div>
    </div>
  );
}

// Component for web search tool
function WebSearchToolView({ assistantContent, userContent }: { assistantContent?: string; userContent?: string }) {
  if (!assistantContent) return <div>No content available</div>;
  
  // Extract search query
  const queryMatch = assistantContent.match(/query=["']([\s\S]*?)["']/);
  const query = queryMatch ? queryMatch[1] : "Unknown search";
  
  // Check if search was successful
  const isSuccess = userContent?.includes('success=True');
  
  // Parse search results to a more structured format
  const parseSearchResults = (): Array<{title: string, url: string, snippet?: string, publishedDate?: string}> => {
    if (!userContent) return [];
    
    try {
      // Extract the results section
      const outputMatch = userContent.match(/output='([\s\S]*?)(?='\))/);
      if (!outputMatch || !outputMatch[1]) return [];
      
      const output = outputMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      
      // Try to extract search results from the output
      const results: Array<{title: string, url: string, snippet?: string, publishedDate?: string}> = [];
      
      // Try to parse as JSON first
      try {
        if (output.trim().startsWith('{') || output.trim().startsWith('[')) {
          const parsedOutput = JSON.parse(output);
          
          // Handle array of results - this is the most common format
          if (Array.isArray(parsedOutput)) {
            return parsedOutput
              .map(item => {
                // Handle variations in field names (capitalized and lowercase)
                const title = item.Title || item.title || '';
                let url = item.URL || item.Url || item.url || '';
                const snippet = item.Snippet || item.snippet || item.Description || item.description || '';
                const publishedDate = item["Published Date"] || item.publishedDate || item.Date || item.date || '';
                
                // Clean up URLs - sometimes they are quoted or have URL: prefix
                if (url && typeof url === 'string') {
                  url = cleanUrl(url);
                }
                
                // Skip entries without a real URL
                if (!url || url === '"' || url === "'") return null;
                
                return {
                  title: cleanTitle(title) || extractTitleFromUrl(url),
                  url: url,
                  snippet: typeof snippet === 'string' ? snippet : '',
                  publishedDate: typeof publishedDate === 'string' ? publishedDate : ''
                };
              })
              .filter(Boolean) // Remove null entries
              .filter((item, index, self) => 
                // Remove duplicates based on URL
                index === self.findIndex((t) => t.url === item.url)
              );
          }
          
          // Handle object with results array
          if (parsedOutput.results && Array.isArray(parsedOutput.results)) {
            return parsedOutput.results
              .map(item => {
                const title = item.Title || item.title || '';
                let url = item.URL || item.Url || item.url || '';
                url = cleanUrl(url);
                
                // Skip entries without a real URL
                if (!url || url === '"' || url === "'") return null;
                
                return {
                  title: cleanTitle(title) || extractTitleFromUrl(url),
                  url: url,
                  snippet: item.Snippet || item.snippet || item.Description || item.description || '',
                  publishedDate: item["Published Date"] || item.publishedDate || item.Date || item.date || ''
                };
              })
              .filter(Boolean) // Remove null entries
              .filter((item, index, self) => 
                index === self.findIndex((t) => t.url === item.url)
              );
          }
        }
      } catch (e) {
        console.log('JSON parsing failed, trying text parsing');
      }
      
      // Fallback to text parsing for non-JSON or parsing errors
      // First, try to detect if the output is in a specific format but not valid JSON
      
      // Handle cases where JSON is malformed but recognizable
      // For instance, missing quotes around property names or values
      if (output.includes('"Title"') || output.includes('"URL"')) {
        // Try to extract title/URL pairs using regex
        const urlRegex = /"URL":\s*"?([^",\n]+)"?,?/gi;
        const titleRegex = /"Title":\s*"([^"]+)"/gi;
        
        let urlMatch;
        let titleMatch;
        
        // Extract all URLs
        const urls: {url: string, index: number}[] = [];
        while ((urlMatch = urlRegex.exec(output)) !== null) {
          if (urlMatch[1] && urlMatch[1].trim()) {
            urls.push({
              url: cleanUrl(urlMatch[1]),
              index: urlMatch.index
            });
          }
        }
        
        // Extract all titles
        const titles: {title: string, index: number}[] = [];
        while ((titleMatch = titleRegex.exec(output)) !== null) {
          if (titleMatch[1] && titleMatch[1].trim()) {
            titles.push({
              title: cleanTitle(titleMatch[1]),
              index: titleMatch.index
            });
          }
        }
        
        // Match titles with URLs by proximity
        urls.forEach(urlItem => {
          let nearestTitle = '';
          let minDistance = Infinity;
          
          titles.forEach(titleItem => {
            const distance = Math.abs(titleItem.index - urlItem.index);
            if (distance < minDistance) {
              minDistance = distance;
              nearestTitle = titleItem.title;
            }
          });
          
          if (urlItem.url && !results.some(r => r.url === urlItem.url)) {
            results.push({
              title: nearestTitle || extractTitleFromUrl(urlItem.url),
              url: urlItem.url,
              snippet: ''
            });
          }
        });
        
        if (results.length > 0) {
          return results;
        }
      }
      
      // General URL pattern fallback
      const urlPattern = /(https?:\/\/[^\s"'<>]+)/g;
      const urlMatches = [...output.matchAll(urlPattern)];
      
      if (urlMatches.length > 0) {
        // For each URL, try to find a title nearby
        for (let i = 0; i < urlMatches.length; i++) {
          const url = cleanUrl(urlMatches[i][0]);
          
          // Skip if we already have this URL
          if (results.some(r => r.url === url)) continue;
          
          // Get context around URL (10 lines before and after)
          const urlIndex = output.indexOf(urlMatches[i][0]);
          const startContextIndex = Math.max(0, output.lastIndexOf('\n', urlIndex - 200));
          const endContextIndex = Math.min(output.length, output.indexOf('\n', urlIndex + 200));
          const context = output.substring(startContextIndex, endContextIndex);
          
          // Try to find a title in the context
          let title = '';
          
          // Look for something that looks like a title (text followed by the URL)
          const lines = context.split('\n');
          for (let j = 0; j < lines.length; j++) {
            const line = lines[j].trim();
            
            // Skip empty lines or lines that contain the URL
            if (!line || line.includes(url)) continue;
            
            // If line looks like a title (not a URL, reasonable length)
            if (!line.includes('http') && line.length > 5 && line.length < 100) {
              title = cleanTitle(line);
              break;
            }
          }
          
          if (url && !results.some(r => r.url === url)) {
            results.push({
              title: title || extractTitleFromUrl(url),
              url: url,
              snippet: ''
            });
          }
        }
      }
      
      return results;
    } catch (e) {
      console.error("Failed to parse search results", e);
      return [];
    }
  };
  
  // Clean up a title
  const cleanTitle = (title: string): string => {
    if (!title) return '';
    
    // Remove surrounding quotes
    let cleaned = title.replace(/^["'](.+)["']$/g, '$1');
    
    // Remove URL: prefix if accidentally included
    cleaned = cleaned.replace(/^URL:\s*/i, '');
    
    // Remove "title" or "Title" prefix
    cleaned = cleaned.replace(/^(title|Title):\s*/i, '');
    
    // Remove leading/trailing spaces
    cleaned = cleaned.trim();
    
    return cleaned;
  };
  
  // Clean up a URL
  const cleanUrl = (url: string): string => {
    if (!url) return '';
    
    // Remove quotes
    let cleaned = url.replace(/^["'](.+)["']$/g, '$1');
    
    // Remove "URL:" prefix
    cleaned = cleaned.replace(/^URL:\s*/i, '');
    
    // Remove trailing commas, quotes, brackets
    cleaned = cleaned.replace(/[,"'\]\}]+$/, '');
    
    // Remove any trailing whitespace
    cleaned = cleaned.trim();
    
    return cleaned;
  };
  
  // Extract a title from a URL if no title is available
  const extractTitleFromUrl = (url: string): string => {
    try {
      const urlObj = new URL(url);
      
      // Get the domain name first
      const domain = urlObj.hostname.replace('www.', '');
      
      // Get the path without the domain, clean it up and make it presentable
      let path = urlObj.pathname;
      if (path === '/' || !path) {
        // If it's just the homepage, use the domain name
        return domain.charAt(0).toUpperCase() + domain.slice(1);
      }
      
      // Remove trailing slashes, split by slashes and get the last meaningful segment
      path = path.replace(/\/+$/, '');
      const segments = path.split('/').filter(s => s.length > 0);
      if (segments.length > 0) {
        // Get the last segment, replace dashes and underscores with spaces, and capitalize
        const lastSegment = segments[segments.length - 1]
          .replace(/[-_]/g, ' ')
          .replace(/\.([a-z]+)$/, '') // Remove file extensions
          .trim();
          
        if (lastSegment.length > 0) {
          return lastSegment.charAt(0).toUpperCase() + lastSegment.slice(1);
        }
      }
      
      // Fallback to domain name
      return domain.charAt(0).toUpperCase() + domain.slice(1);
    } catch (e) {
      // If URL parsing fails, extract something that looks like a title
      const matches = url.match(/https?:\/\/(?:www\.)?([^\/]+)/);
      return matches ? matches[1] : url.substring(0, 30);
    }
  };
  
  // Format a human-readable date
  const formatDate = (dateString: string): string => {
    if (!dateString) return '';
    
    try {
      const date = new Date(dateString);
      // Check if it's a valid date
      if (isNaN(date.getTime())) return '';
      
      // Only show if it's within the last 3 years or in the future
      const now = new Date();
      const threeYearsAgo = new Date();
      threeYearsAgo.setFullYear(now.getFullYear() - 3);
      
      if (date < threeYearsAgo) return '';
      
      return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
    } catch (e) {
      return '';
    }
  };
  
  const searchResults = parseSearchResults();
  const hasResults = searchResults.length > 0;
  
  // Get raw output for fallback
  const getRawOutput = (): string => {
    if (!userContent) return "";
    
    try {
      // Extract the results section
      const outputMatch = userContent.match(/output='([\s\S]*?)(?='\))/);
      if (outputMatch && outputMatch[1]) {
        return outputMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      return "";
    } catch (e) {
      console.error("Failed to extract search results", e);
      return "";
    }
  };
  
  const rawOutput = getRawOutput();
  
  // Format a URL for display
  const formatUrl = (url: string): string => {
    try {
      const urlObj = new URL(url);
      let formattedUrl = urlObj.hostname.replace('www.', '');
      
      // Add path if it's not just the root
      if (urlObj.pathname && urlObj.pathname !== '/') {
        // Limit path length
        const path = urlObj.pathname.length > 25 
          ? urlObj.pathname.substring(0, 25) + '...' 
          : urlObj.pathname;
        formattedUrl += path;
      }
      
      return formattedUrl;
    } catch (e) {
      // Return a shortened version of the URL if parsing fails
      return url.length > 40 ? url.substring(0, 40) + '...' : url;
    }
  };
  
  return (
    <div className="border rounded-md overflow-hidden">
      <div className="flex items-center p-2 bg-muted justify-between">
        <div className="flex items-center">
          <Search className="h-4 w-4 mr-2 text-muted-foreground" />
          <span className="text-sm font-medium">Web Search Results</span>
        </div>
      </div>
      
      <div className="px-4 py-3 border-t border-b bg-muted/50">
        <div className="flex items-center">
          <div className="text-sm font-medium mr-2">Query:</div>
          <div className="text-sm bg-muted py-1 px-3 rounded-md flex-1">{query}</div>
        </div>
        <div className="mt-1.5 text-xs text-muted-foreground">
          {hasResults ? `Found ${searchResults.length} results` : 'No results found'}
        </div>
      </div>
      
      <div className="overflow-auto bg-muted/20 max-h-[500px]">
        {hasResults ? (
          <div className="divide-y">
            {searchResults.map((result, idx) => (
              <div key={idx} className="p-4 space-y-1.5">
                <div className="flex flex-col">
                  <div className="text-xs text-emerald-600 dark:text-emerald-400 truncate flex items-center">
                    <span className="truncate">{formatUrl(result.url)}</span>
                    {result.publishedDate && (
                      <span className="text-muted-foreground ml-2 whitespace-nowrap">
                        {formatDate(result.publishedDate)}
                      </span>
                    )}
                  </div>
                  <a 
                    href={result.url} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline font-medium"
                  >
                    {result.title}
                  </a>
                </div>
                {result.snippet && (
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {result.snippet}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : rawOutput ? (
          <div className="p-4">
            <div className="text-sm mb-2 text-muted-foreground">
              Showing raw search results:
            </div>
            <pre className="text-xs font-mono bg-muted/30 p-3 rounded whitespace-pre-wrap break-all">
            {rawOutput}
          </pre>
          </div>
        ) : (
          <div className="p-6 text-center text-muted-foreground">
            <Search className="h-6 w-6 mx-auto mb-2 opacity-50" />
            <p className="text-sm font-medium">No results found</p>
            <p className="text-xs mt-1">Try a different search query</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Component for web crawl tool
function WebCrawlToolView({ assistantContent, userContent }: { assistantContent?: string; userContent?: string }) {
  if (!assistantContent) return <div>No content available</div>;
  
  // Extract URL from assistantContent
  const urlMatch = assistantContent.match(/url=["']([\s\S]*?)["']/);
  const url = urlMatch ? urlMatch[1] : "";
  
  // Check if crawl was successful
  const isSuccess = userContent?.includes('success=True');
  
  // Parse crawled content - keep it simple with just title, url, and text
  const parseCrawlResult = (): { title: string; url: string; text: string; } | null => {
    if (!userContent) return null;
    
    try {
      // Extract the output section
      const outputMatch = userContent.match(/output='([\s\S]*?)(?='\))/);
      if (!outputMatch || !outputMatch[1]) return null;
      
      const output = outputMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      
      // Try to parse as JSON
      try {
        if (output.trim().startsWith('{') || output.trim().startsWith('[')) {
          const parsedOutput = JSON.parse(output);
          
          // Handle array with one item (common format)
          if (Array.isArray(parsedOutput) && parsedOutput.length > 0) {
            const item = parsedOutput[0];
            return {
              title: item.Title || item.title || '',
              url: cleanUrl(item.URL || item.Url || item.url || ''),
              text: item.Text || item.text || item.Content || item.content || ''
            };
          }
          
          // Handle single object
          if (!Array.isArray(parsedOutput)) {
            return {
              title: parsedOutput.Title || parsedOutput.title || '',
              url: cleanUrl(parsedOutput.URL || parsedOutput.Url || parsedOutput.url || ''),
              text: parsedOutput.Text || parsedOutput.text || parsedOutput.Content || parsedOutput.content || ''
            };
          }
        }
      } catch (e) {
        console.log('JSON parsing failed');
      }
      
      // If JSON parsing fails, just return the raw text
      return {
        title: url,
        url: url,
        text: output
      };
    } catch (e) {
      console.error("Failed to parse crawl result", e);
      return null;
    }
  };
  
  // Clean up a URL
  const cleanUrl = (url: string): string => {
    if (!url) return '';
    
    // Remove quotes
    let cleaned = url.replace(/^["'](.+)["']$/g, '$1');
    
    // Remove "URL:" prefix
    cleaned = cleaned.replace(/^URL:\s*/i, '');
    
    // Remove trailing commas, quotes, brackets
    cleaned = cleaned.replace(/[,"'\]\}]+$/, '');
    
    // Remove any trailing whitespace
    cleaned = cleaned.trim();
    
    return cleaned;
  };
  
  // Format clean URL for display
  const formatUrl = (url: string): string => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname + (urlObj.pathname !== '/' ? urlObj.pathname : '');
    } catch (e) {
      return url;
    }
  };
  
  // Get raw output for fallback
  const getRawOutput = (): string => {
    if (!userContent) return "";
    
    try {
      // Extract the output section
      const outputMatch = userContent.match(/output='([\s\S]*?)(?='\))/);
      if (outputMatch && outputMatch[1]) {
        return outputMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      return "";
    } catch (e) {
      console.error("Failed to extract webpage content", e);
      return "";
    }
  };
  
  const crawlData = parseCrawlResult();
  const rawOutput = getRawOutput();
  
  return (
    <div className="border rounded-md overflow-hidden">
      <div className="flex items-center p-2 bg-muted justify-between">
        <div className="flex items-center">
          <Globe className="h-4 w-4 mr-2 text-muted-foreground" />
          <span className="text-sm font-medium">Web Content</span>
        </div>
      </div>
      
      <div className="px-4 py-3 border-t border-b bg-muted/50">
          <a 
          href={crawlData?.url || url} 
            target="_blank" 
            rel="noopener noreferrer"
          className="text-blue-600 hover:underline flex items-center gap-1 text-sm font-medium"
          >
          {formatUrl(crawlData?.url || url)}
          <ExternalLink className="h-3.5 w-3.5" />
          </a>
      </div>
      
      <div className="overflow-auto bg-muted/20 max-h-[500px]">
        {crawlData ? (
          <div className="p-4">
            {crawlData.title && crawlData.title !== url && (
              <h3 className="text-base font-semibold mb-3">{crawlData.title}</h3>
            )}
            
            <div className="space-y-2 text-sm">
              {crawlData.text.split('\n').map((paragraph, idx) => (
                paragraph.trim() ? (
                  <p key={idx} className="text-muted-foreground">
                    {paragraph}
                  </p>
                ) : null
              ))}
            </div>
          </div>
        ) : rawOutput ? (
          <div className="p-4">
            <pre className="text-xs font-mono bg-muted/30 p-3 rounded whitespace-pre-wrap break-all">
            {rawOutput}
          </pre>
          </div>
        ) : (
          <div className="p-6 text-center text-muted-foreground">
            <Globe className="h-6 w-6 mx-auto mb-2 opacity-50" />
            <p className="text-sm font-medium">{isSuccess ? "No content extracted" : "Webpage content unavailable"}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Component for text editor actions
function TextEditorToolView({ assistantContent, userContent }: { assistantContent?: string; userContent?: string }) {
  if (!assistantContent) return <div>No content available</div>;
  
  // Extract text editor command
  const commandMatch = assistantContent.match(/command=["']([\s\S]*?)["']/);
  const command = commandMatch ? commandMatch[1] : "unknown";
  
  // Extract path
  const pathMatch = assistantContent.match(/path=["']([\s\S]*?)["']/);
  const path = pathMatch ? pathMatch[1] : "";
  
  // Check if operation was successful
  const isSuccess = userContent?.includes('status":"success') || userContent?.includes('success=True');
  
  // Extract file content if available (for view, create, or write commands)
  const getFileContent = (): string => {
    if (!userContent) return "";
    
    try {
      // Try to extract file_info.content
      const contentMatch = userContent.match(/"content":"([\s\S]*?)(?=")/) || 
                          userContent.match(/content='([\s\S]*?)(?=')/);
      
      if (contentMatch && contentMatch[1]) {
        return JSON.parse(`"${contentMatch[1]}"`); // Parse escaped JSON string
      }
      return "";
    } catch (e) {
      console.error("Failed to parse file content", e);
      return "";
    }
  };
  
  // Get command-specific title and icon
  const getCommandInfo = (cmd: string): {title: string, icon: React.ReactNode} => {
    switch (cmd.toLowerCase()) {
      case 'view':
        return { title: 'View File', icon: <FileSymlink className="h-4 w-4" /> };
      case 'create':
        return { title: 'Create File', icon: <FileEdit className="h-4 w-4" /> };
      case 'write':
        return { title: 'Write to File', icon: <FileEdit className="h-4 w-4" /> };
      case 'str_replace':
      case 'str-replace':
        return { title: 'Replace Text', icon: <FileDiff className="h-4 w-4" /> };
      case 'find_content':
      case 'find-content':
        return { title: 'Find Content', icon: <Search className="h-4 w-4" /> };
      case 'find_file':
      case 'find-file':
        return { title: 'Find File', icon: <Search className="h-4 w-4" /> };
      default:
        return { title: 'Text Editor', icon: <Code className="h-4 w-4" /> };
    }
  };
  
  const commandInfo = getCommandInfo(command);
  const fileContent = getFileContent();
  
  return (
    <div className="border rounded-md overflow-hidden">
      <div className="flex items-center p-2 bg-muted justify-between">
        <div className="flex items-center">
          {commandInfo.icon}
          <span className="text-sm font-medium ml-2">{commandInfo.title}</span>
        </div>
        {isSuccess && (
          <span className="text-xs text-green-600 flex items-center">
            <CheckCircle className="h-3 w-3 mr-1" /> Success
          </span>
        )}
      </div>
      
      <div className="px-3 py-2 border-t border-b bg-muted/50">
        <div className="flex items-center">
          <div className="text-xs font-medium mr-2">Path:</div>
          <div className="text-xs font-mono bg-muted px-2 py-1 rounded flex-1">{path}</div>
        </div>
        <div className="flex items-center mt-2">
          <div className="text-xs font-medium mr-2">Command:</div>
          <div className="text-xs font-mono bg-muted px-2 py-1 rounded">{command}</div>
        </div>
      </div>
      
      <div className="overflow-auto bg-muted/20 max-h-[500px]">
        {fileContent ? (
          <pre className="text-xs font-mono p-3 whitespace-pre-wrap break-all">
            {fileContent}
          </pre>
        ) : (
          <div className="p-4 text-center text-muted-foreground">
            <Code className="h-5 w-5 mx-auto mb-2 opacity-50" />
            <p className="text-sm">
              {isSuccess ? "Operation completed successfully" : "No content to display"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// Component for data provider endpoints
function DataProviderEndpointsView({ assistantContent, userContent }: { assistantContent?: string; userContent?: string }) {
  if (!assistantContent) return <div>No content available</div>;
  
  // Extract service name
  const serviceNameMatch = assistantContent.match(/service_name=["']([\s\S]*?)["']/);
  const serviceName = serviceNameMatch ? serviceNameMatch[1] : "unknown";
  
  // Check if operation was successful
  const isSuccess = userContent?.includes('success=True');
  
  // Parse endpoints
  const getEndpoints = (): Record<string, any> => {
    if (!userContent || !isSuccess) return {};
    
    try {
      // Extract the output section
      const outputMatch = userContent.match(/output='([\s\S]*?)(?='\))/);
      if (!outputMatch || !outputMatch[1]) return {};
      
      // Try to parse as JSON
      return JSON.parse(outputMatch[1]);
    } catch (e) {
      console.error("Failed to parse endpoints", e);
      return {};
    }
  };
  
  const endpoints = getEndpoints();
  
  return (
    <div className="border rounded-md overflow-hidden">
      <div className="flex items-center p-2 bg-muted justify-between">
        <div className="flex items-center">
          <ListFilter className="h-4 w-4 mr-2 text-muted-foreground" />
          <span className="text-sm font-medium">Data Provider Endpoints</span>
        </div>
      </div>
      
      <div className="px-3 py-2 border-t border-b bg-muted/50">
        <div className="flex items-center">
          <div className="text-xs font-medium mr-2">Service:</div>
          <div className="text-xs font-mono bg-muted px-2 py-1 rounded flex-1">{serviceName}</div>
        </div>
      </div>
      
      <div className="overflow-auto bg-muted/20 max-h-[500px]">
        {Object.keys(endpoints).length > 0 ? (
          <div className="p-3">
            <div className="text-xs font-medium mb-2">Available Endpoints:</div>
            <div className="space-y-2">
              {Object.entries(endpoints).map(([key, value]) => (
                <div key={key} className="bg-muted rounded p-2">
                  <div className="font-medium">{key}</div>
                  <div className="text-xs mt-1 text-muted-foreground">
                    {typeof value === 'string' 
                      ? value 
                      : (typeof value === 'object' 
                        ? JSON.stringify(value, null, 2) 
                        : String(value))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="p-4 text-center text-muted-foreground">
            <Database className="h-5 w-5 mx-auto mb-2 opacity-50" />
            <p className="text-sm">{isSuccess ? "No endpoints available" : "Failed to retrieve endpoints"}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Component for data provider calls
function DataProviderCallView({ assistantContent, userContent }: { assistantContent?: string; userContent?: string }) {
  if (!assistantContent) return <div>No content available</div>;
  
  // Extract service name and route
  const serviceNameMatch = assistantContent.match(/service_name=["']([\s\S]*?)["']/);
  const serviceName = serviceNameMatch ? serviceNameMatch[1] : "unknown";
  
  const routeMatch = assistantContent.match(/route=["']([\s\S]*?)["']/);
  const route = routeMatch ? routeMatch[1] : "unknown";
  
  // Extract payload
  const getPayload = (): string => {
    const payloadMatch = assistantContent.match(/<execute-data-provider-call[\s\S]*?>([\s\S]*?)<\/execute-data-provider-call>/);
    if (payloadMatch && payloadMatch[1]) {
      try {
        return JSON.stringify(JSON.parse(payloadMatch[1]), null, 2);
      } catch (e) {
        return payloadMatch[1];
      }
    }
    return "{}";
  };
  
  // Check if operation was successful
  const isSuccess = userContent?.includes('success=True');
  
  // Parse response
  const getResponse = (): any => {
    if (!userContent || !isSuccess) return null;
    
    try {
      // Extract the output section
      const outputMatch = userContent.match(/output='([\s\S]*?)(?='\))/);
      if (!outputMatch || !outputMatch[1]) return null;
      
      // Try to parse as JSON
      return JSON.parse(outputMatch[1]);
    } catch (e) {
      console.error("Failed to parse data provider response", e);
      return null;
    }
  };
  
  const payload = getPayload();
  const response = getResponse();
  
  return (
    <div className="border rounded-md overflow-hidden">
      <div className="flex items-center p-2 bg-muted justify-between">
        <div className="flex items-center">
          <Database className="h-4 w-4 mr-2 text-muted-foreground" />
          <span className="text-sm font-medium">Data Provider Call</span>
        </div>
        {isSuccess && (
          <span className="text-xs text-green-600 flex items-center">
            <CheckCircle className="h-3 w-3 mr-1" /> Success
          </span>
        )}
      </div>
      
      <div className="px-3 py-2 border-t border-b bg-muted/50">
        <div className="flex items-center">
          <div className="text-xs font-medium mr-2">Service:</div>
          <div className="text-xs font-mono bg-muted px-2 py-1 rounded">{serviceName}</div>
        </div>
        <div className="flex items-center mt-1">
          <div className="text-xs font-medium mr-2">Route:</div>
          <div className="text-xs font-mono bg-muted px-2 py-1 rounded">{route}</div>
        </div>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x">
        <div className="p-3">
          <div className="text-xs font-medium mb-2">Request Payload:</div>
          <pre className="text-xs font-mono bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
            {payload}
          </pre>
        </div>
        
        <div className="p-3">
          <div className="text-xs font-medium mb-2">Response:</div>
          {response ? (
            <pre className="text-xs font-mono bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(response, null, 2)}
            </pre>
          ) : (
            <div className="p-4 text-center text-muted-foreground">
              <p className="text-sm">{isSuccess ? "No response data" : "Request failed"}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Component for deploy tool
function DeployToolView({ assistantContent, userContent }: { assistantContent?: string; userContent?: string }) {
  if (!assistantContent) return <div>No content available</div>;
  
  // Extract project name
  const nameMatch = assistantContent.match(/name=["']([\s\S]*?)["']/);
  const projectName = nameMatch ? nameMatch[1] : "unknown";
  
  // Extract directory path
  const dirMatch = assistantContent.match(/directory_path=["']([\s\S]*?)["']/);
  const directory = dirMatch ? dirMatch[1] : "unknown";
  
  // Check if operation was successful
  const isSuccess = userContent?.includes('Success!') || userContent?.includes('Deployment complete!') || userContent?.includes('Successfully created');
  
  // Extract deployment URL from the response
  const extractDeploymentUrl = (): string | null => {
    if (!userContent) return null;
    
    // Try to find the URL pattern in the output
    const urlMatch = userContent.match(/https:\/\/[a-zA-Z0-9-]+\.pages\.dev/);
    return urlMatch ? urlMatch[0] : null;
  };
  
  const deploymentUrl = extractDeploymentUrl();
  
  return (
    <div className="border rounded-md overflow-hidden">
      <div className="flex items-center p-3 bg-muted justify-between">
        <div className="flex items-center">
          <Rocket className="h-5 w-5 mr-2 text-primary" />
          <span className="text-base font-medium">Deployment</span>
        </div>
        {isSuccess && (
          <span className="text-sm text-green-600 flex items-center">
            <CheckCircle className="h-4 w-4 mr-1" /> Deployed
          </span>
        )}
      </div>
      
      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Project:</div>
          <div className="text-sm font-mono">{projectName}</div>
        </div>
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Directory:</div>
          <div className="text-sm font-mono">{directory}</div>
        </div>
      </div>
      
      {deploymentUrl && (
        <div className="p-4 bg-green-50 dark:bg-green-950/20 space-y-4">
          <div className="space-y-1">
            <div className="text-sm font-medium text-green-700 dark:text-green-300">Deployment URL:</div>
            <a 
              href={deploymentUrl} 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline flex items-center gap-1 break-all"
            >
              {deploymentUrl}
              <ExternalLink className="h-4 w-4 flex-shrink-0" />
            </a>
          </div>
          
          <div className="text-sm text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 p-3 rounded-md flex items-start gap-2">
            <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>It may take a few minutes before the site becomes reachable.</span>
          </div>
          
          <div className="flex justify-end">
            <a 
              href={deploymentUrl} 
              target="_blank" 
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4 py-2"
            >
              Visit Site
              <ExternalLink className="h-4 w-4 ml-1" />
            </a>
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
  // Updated styling for full-height panel that sits alongside the header
  const showNavigation = isHistoricalPair(content) && totalPairs > 1 && currentIndex !== null;
  
  // Get VNC preview URL from project if available
  const vncPreviewUrl = project?.sandbox?.vnc_preview ? `${project.sandbox.vnc_preview}/vnc_lite.html?password=${project?.sandbox?.pass}` : undefined;

  // Get the sandbox ID from project for todo.md fetching
  const sandboxId = project?.sandbox?.id || null;
  
  // Get tool name for display
  const getToolName = (): { name: string, icon: React.ReactNode } => {
    if (isHistoricalPair(content)) {
      const toolName = content.assistantCall.name || '';
      
      if (toolName.toLowerCase() === 'deploy') {
        return { name: 'DEPLOY', icon: <Rocket className="h-4 w-4" /> };
      }
      
      if (toolName.toLowerCase().includes('command')) {
        return { name: 'EXECUTE', icon: <Terminal className="h-4 w-4" /> };
      }
      
      return { name: toolName.toUpperCase(), icon: <Command className="h-4 w-4" /> };
    }
    
    if (content && 'name' in content) {
      const toolName = content.name || '';
      
      if (toolName.toLowerCase() === 'deploy') {
        return { name: 'DEPLOY', icon: <Rocket className="h-4 w-4" /> };
      }
      
      if (toolName.toLowerCase().includes('command')) {
        return { name: 'EXECUTE', icon: <Terminal className="h-4 w-4" /> };
      }
      
      return { name: toolName.toUpperCase(), icon: <Command className="h-4 w-4" /> };
    }
    
    return { name: '', icon: null };
  };  
  return (
    <div 
      className={`
        ${isOpen ? 'w-full sm:w-[100%] md:w-[45%] lg:w-[42.5%] xl:w-[40%] 2xl:w-[35%] max-w-[800px]' : 'w-0'} 
        border-l bg-sidebar h-screen flex flex-col 
        transition-all duration-300 ease-in-out overflow-hidden
        fixed sm:sticky top-0 right-0 z-30 
      `}
    >
      {/* Ensure content doesn't render or is hidden when closed to prevent layout shifts */}
      {isOpen && (
        <>
          <div className="bg-muted/30 backdrop-blur-sm sticky top-0 z-10">
            <div className="flex items-center justify-between px-5 py-3">
              <div className="flex flex-col">
            <h2 className="text-lg font-semibold flex items-center gap-2">
                  <Laptop className="h-5 w-5 text-primary" /> 
                  <span>Suna's Computer</span>
            </h2>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon" onClick={onClose} className="h-8 w-8 rounded-full">
              <X className="h-4 w-4" />
              <span className="sr-only">Close Panel</span>
            </Button>
          </div>
            </div>
            
            {/* Tool name display - Vercel-style minimalist */}
          </div>
          <div className="flex-1 p-4 overflow-y-auto">
            {content ? (
              // ---- Render Historical Pair ----
              'type' in content && content.type === 'historical' ? (
                <div className="space-y-6">
                  {/* Unified tool view - shows request and result together */}
                  {getUnifiedToolView(
                    content.assistantCall.name, 
                    content.assistantCall.content, 
                    content.userResult.content,
                    vncPreviewUrl
                  ) || (
                    // Default view if no specialized handler exists
                    <div className="space-y-6">
                      <div>
                        <h3 className="font-semibold text-sm mb-2 flex items-center gap-1.5 text-muted-foreground">
                          <Terminal className="h-4 w-4" />
                          Tool Call (Assistant)
                        </h3>
                        <div className="space-y-2">
                          <div>
                            <h4 className="text-xs font-medium text-muted-foreground/80 mb-1">Name:</h4>
                            <p className="text-sm font-mono bg-muted p-2 rounded break-all">{content.assistantCall.name || 'N/A'}</p>
                          </div>
                          <div>
                            <h4 className="text-xs font-medium text-muted-foreground/80 mb-1">Content/Arguments:</h4>
                            <pre className="text-xs font-mono bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
                              {content.assistantCall.content || 'No content'}
                            </pre>
                          </div>
                        </div>
                      </div>

                      <div>
                        <h3 className="font-semibold text-sm mb-2 flex items-center gap-1.5 text-muted-foreground">
                          <CheckCircle className="h-4 w-4 text-green-600" />
                          Tool Result (User)
                        </h3>
                         <div className="space-y-2">
                          <div>
                            <h4 className="text-xs font-medium text-muted-foreground/80 mb-1">Name:</h4>
                            <p className="text-sm font-mono bg-muted p-2 rounded break-all">{content.userResult.name || 'N/A'}</p>
                          </div>
                          <div>
                            <h4 className="text-xs font-medium text-muted-foreground/80 mb-1">Content/Output:</h4>
                            <pre className="text-xs font-mono bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
                              {content.userResult.content || 'No content'}
                            </pre>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) :
              // ---- Render Live Tool Call Data ----
              'name' in content ? ( // Check if it's ToolCallData
                <div className="space-y-4">
                  <div>
                    <h3 className="font-semibold text-sm mb-1 text-muted-foreground">Tool Name (Live):</h3>
                    <p className="text-sm font-mono bg-muted p-2 rounded break-all">{content.name || 'N/A'}</p>
                  </div>
                  
                  {/* Specialized view for live tool call */}
                  {getUnifiedToolView(content.name, content.arguments, undefined, vncPreviewUrl) || (
                    <div>
                      <h3 className="font-semibold text-sm mb-1 text-muted-foreground">Arguments (Live):</h3>
                      <pre className="text-xs font-mono bg-muted p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
                        {content.arguments
                          ? (() => {
                              try {
                                // Attempt to parse and pretty-print JSON arguments
                                return JSON.stringify(JSON.parse(content.arguments || ''), null, 2);
                              } catch (e) {
                                // Fallback for non-JSON arguments
                                return content.arguments;
                              }
                            })()
                          : 'No arguments'}
                      </pre>
                    </div>
                  )}
                  
                  {/* Add optional ID/Index if needed */}
                   {content.id && (
                     <div>
                       <h3 className="font-semibold text-sm mb-1 text-muted-foreground">Tool Call ID:</h3>
                       <p className="text-xs font-mono bg-muted p-1 rounded break-all">{content.id}</p>
                     </div>
                   )}
                </div>
              ) : null // Should not happen if content is not null, but handles edge case
            ) : (
              // ---- Render Empty State ----
              <div className="text-center text-muted-foreground text-sm mt-8 flex flex-col items-center gap-2">
                <Package className="h-10 w-10 mb-2 text-muted-foreground/50" />
                <p className="font-medium">No Tool Call Active</p>
                <p className="text-xs">Details will appear here when the agent uses a tool.</p>
              </div>
            )}
          </div>

          {/* Navigation Controls moved to bottom, just above TodoPanel */} 
          {showNavigation && (
            <div className="px-4 pt-2 pb-2 border-t">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  {currentIndex + 1 === totalPairs ? (
                    <div className="flex items-center">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30 mr-1.5">
                        <CheckCircle className="h-3 w-3 text-green-600" />
                      </span>
                      <span className="text-sm font-medium">
                        {totalPairs > 1 ? 
                          `Completed ${totalPairs} steps` : 
                          "Step completed"}
                      </span>
                    </div>
                  ) : (
                    <>
                <span className="text-sm font-medium text-muted-foreground">
                        Step {currentIndex + 1}
                </span>
                      <span className="text-xs text-muted-foreground/70 font-mono">
                        of {totalPairs}
                      </span>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    onClick={() => onNavigate(currentIndex - 1)}
                    disabled={currentIndex === 0}
                    className="h-7 w-7"
                  >
                    <SkipBack className="h-4 w-4" />
                  </Button>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    onClick={() => onNavigate(currentIndex + 1)}
                    disabled={currentIndex === totalPairs - 1}
                    className="h-7 w-7"
                  >
                    <SkipForward className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              
              <div className="relative">
              <Slider
                  value={[currentIndex]} 
                max={totalPairs - 1}
                step={1}
                  onValueChange={(value) => onNavigate(value[0])}
                  className={currentIndex + 1 === totalPairs ? "accent-green-600" : ""}
                />
                
                {/* Progress markers */}
                {totalPairs > 3 && (
                  <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 flex justify-between pointer-events-none">
                    <div className="w-1 h-1 rounded-full bg-muted-foreground/40"></div>
                    <div className="w-1 h-1 rounded-full bg-muted-foreground/40"></div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Todo Panel at the bottom of side panel */}
          {/* {sandboxId && (
            <TodoPanel
              sandboxId={sandboxId}
              isSidePanelOpen={isOpen}
            />
          )} */}
        </>
      )}
    </div>
  );
} 