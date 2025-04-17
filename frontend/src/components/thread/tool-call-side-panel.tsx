import { Button } from "@/components/ui/button";
import { X, Package, Info, Terminal, CheckCircle, SkipBack, SkipForward, MonitorPlay, FileSymlink, FileDiff, FileEdit, Search, Globe, ExternalLink, Database, Code, ListFilter } from "lucide-react";
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
    <div className="border border-muted rounded-md overflow-hidden">
      {/* Terminal header */}
      <div className="bg-gray-900 p-2 flex items-center gap-2">
        <div className="h-3 w-3 rounded-full bg-red-500"></div>
        <div className="h-3 w-3 rounded-full bg-yellow-500"></div>
        <div className="h-3 w-3 rounded-full bg-green-500"></div>
        <span className="text-xs text-slate-400 ml-2 flex-1">Terminal</span>
        {exitCode !== null && (
          <span className={`text-xs px-2 py-0.5 rounded ${isSuccessful ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
            Exit: {exitCode}
          </span>
        )}
      </div>
      
      {/* Unified terminal output area */}
      <div className="bg-black font-mono text-xs p-3 text-slate-300 whitespace-pre-wrap max-h-[500px] overflow-y-auto">
        {command && (
          <>
            <span className="text-green-400">user@workspace:~$ </span>
            <span className="text-slate-200">{command}</span>
            {output && (
              <>
                <div className="pt-1 pb-2"></div>
                <div className="text-slate-300">{output}</div>
              </>
            )}
            {!output && <div className="animate-pulse mt-1">■</div>}
          </>
        )}
        {!command && <span className="text-gray-500">No command available</span>}
      </div>
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
  
  // Get raw output without trying to parse as JSON
  const getRawOutput = (): string => {
    if (!userContent) return "";
    
    try {
      // Extract the results section
      const outputMatch = userContent.match(/output='([\s\S]*?)(?='\))/);
      if (outputMatch && outputMatch[1]) {
        return outputMatch[1];
      }
      return "";
    } catch (e) {
      console.error("Failed to extract search results", e);
      return "";
    }
  };
  
  const rawOutput = getRawOutput();
  
  return (
    <div className="border rounded-md overflow-hidden">
      <div className="flex items-center p-2 bg-muted justify-between">
        <div className="flex items-center">
          <Search className="h-4 w-4 mr-2 text-muted-foreground" />
          <span className="text-sm font-medium">Web Search Results</span>
        </div>
      </div>
      
      <div className="px-3 py-2 border-t border-b bg-muted/50">
        <div className="flex items-center">
          <div className="text-sm font-medium mr-2">Query:</div>
          <div className="text-sm font-mono bg-muted py-1 px-2 rounded flex-1">{query}</div>
        </div>
      </div>
      
      <div className="overflow-auto bg-muted/20 max-h-[500px]">
        {rawOutput ? (
          <pre className="text-xs font-mono p-3 whitespace-pre-wrap break-all">
            {rawOutput}
          </pre>
        ) : (
          <div className="p-4 text-center text-muted-foreground">
            <Search className="h-5 w-5 mx-auto mb-2 opacity-50" />
            <p className="text-sm">{isSuccess ? "No results found" : "Search results unavailable"}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Component for web crawl tool
function WebCrawlToolView({ assistantContent, userContent }: { assistantContent?: string; userContent?: string }) {
  if (!assistantContent) return <div>No content available</div>;
  
  // Extract URL
  const urlMatch = assistantContent.match(/url=["']([\s\S]*?)["']/);
  const url = urlMatch ? urlMatch[1] : "";
  
  // Check if crawl was successful
  const isSuccess = userContent?.includes('success=True');
  
  // Get raw output without trying to parse as JSON
  const getRawOutput = (): string => {
    if (!userContent) return "";
    
    try {
      // Extract the results section
      const outputMatch = userContent.match(/output='([\s\S]*?)(?='\))/);
      if (outputMatch && outputMatch[1]) {
        return outputMatch[1];
      }
      return "";
    } catch (e) {
      console.error("Failed to extract webpage content", e);
      return "";
    }
  };
  
  const rawOutput = getRawOutput();
  
  return (
    <div className="border rounded-md overflow-hidden">
      <div className="flex items-center p-2 bg-muted justify-between">
        <div className="flex items-center">
          <Globe className="h-4 w-4 mr-2 text-muted-foreground" />
          <span className="text-sm font-medium">Webpage Content</span>
        </div>
      </div>
      
      <div className="px-3 py-2 border-t border-b bg-muted/50">
        <div className="flex items-center truncate">
          <a 
            href={url} 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:underline flex items-center gap-1"
          >
            {url.length > 50 ? `${url.substring(0, 50)}...` : url}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
      
      <div className="overflow-auto bg-muted/20 max-h-[500px]">
        {rawOutput ? (
          <pre className="text-xs font-mono p-3 whitespace-pre-wrap break-all">
            {rawOutput}
          </pre>
        ) : (
          <div className="p-4 text-center text-muted-foreground">
            <Globe className="h-5 w-5 mx-auto mb-2 opacity-50" />
            <p className="text-sm">{isSuccess ? "No content extracted" : "Webpage content unavailable"}</p>
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

  return (
    <div 
      className={`
        ${isOpen ? 'w-full sm:w-[85%] md:w-[75%] lg:w-[60%] xl:w-[50%] 2xl:w-[40%] max-w-[1000px]' : 'w-0'} 
        border-l bg-sidebar h-screen flex flex-col 
        transition-all duration-300 ease-in-out overflow-hidden
        fixed sm:sticky top-0 right-0 z-30 
      `}
    >
      {/* Ensure content doesn't render or is hidden when closed to prevent layout shifts */}
      {isOpen && (
        <>
          <div className="flex items-center justify-between p-4 shrink-0">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Info className="h-5 w-5" /> 
              Suna´s Computer
            </h2>
            <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
              <X className="h-4 w-4" />
              <span className="sr-only">Close Panel</span>
            </Button>
          </div>
          <div className="flex-1 p-4 overflow-y-auto">
            {content ? (
              // ---- Render Historical Pair ----
              'type' in content && content.type === 'historical' ? (
                <div className="space-y-6">
                  {/* Tool name header */}
                  <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground border-b pb-3">
                    <Terminal className="h-4 w-4" />
                    <span>{content.assistantCall.name || 'Tool Call'}</span>
                  </div>
                
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
                <span className="text-sm font-medium text-muted-foreground">
                  Step {currentIndex + 1} of {totalPairs}
                </span>
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
              <Slider
                value={[currentIndex]} // Slider value is an array
                max={totalPairs - 1}
                step={1}
                onValueChange={(value) => onNavigate(value[0])} // onValueChange gives an array
              />
            </div>
          )}

          {/* Todo Panel at the bottom of side panel */}
          {sandboxId && (
            <TodoPanel
              sandboxId={sandboxId}
              isSidePanelOpen={isOpen}
            />
          )}
        </>
      )}
    </div>
  );
} 