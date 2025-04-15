'use client';

import React from 'react';
import { ParsedTag, ToolComponentProps } from '@/lib/types/tool-calls';
import { 
  File, FileText, Terminal, FolderPlus, Folder, Code, Search as SearchIcon, 
  Bell, Replace, Plus, Minus
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { diffLines } from 'diff';

// Shared compact mode component
const CompactToolDisplay: React.FC<{
  icon: React.ReactNode,
  name: string,
  input: string,
  isRunning?: boolean
}> = ({ icon, name, input, isRunning }) => {
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-xs bg-muted/30 rounded">
      {icon}
      <span className="font-medium">{name}: {input}</span>
      {isRunning && (
        <div className="flex items-center gap-1">
          <span className="text-amber-500">Running</span>
          <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse"></div>
        </div>
      )}
    </div>
  );
};

/**
 * Create File Tool Component
 */
export const CreateFileTool: React.FC<ToolComponentProps> = ({ tag, mode }) => {
  const filePath = tag.attributes.file_path || '';
  const fileContent = tag.content || '';
  const isRunning = tag.status === 'running';
  
  if (mode === 'compact') {
    return (
      <CompactToolDisplay 
        icon={<FileText className="h-4 w-4 mr-2" />}
        name={isRunning ? "Creating file" : "Created file"}
        input={filePath}
        isRunning={isRunning}
      />
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden border-subtle dark:border-white/10">
      <div className="flex items-center px-2 py-1 text-xs font-medium border-b border-subtle dark:border-white/10 bg-background-secondary dark:bg-background-secondary text-foreground">
        <FileText className="h-4 w-4 mr-2" />
        <div className="flex-1">{isRunning ? "Creating file" : "Created file"}: {filePath}</div>
        {isRunning && (
          <div className="flex items-center gap-2">
            <span className="text-amber-500">Running</span>
            <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse"></div>
          </div>
        )}
      </div>
      <div className="p-3 bg-card-bg dark:bg-background-secondary text-foreground">
        <div className="space-y-2">
          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
            <FileText className="h-3 w-3" />
            <span className="font-mono">{filePath}</span>
          </div>
          <pre className="whitespace-pre-wrap bg-muted p-2 rounded-md text-xs overflow-x-auto max-h-60">
            {fileContent}
          </pre>
        </div>
      </div>
    </div>
  );
};

/**
 * Full File Rewrite Tool Component
 */
export const FullFileRewriteTool: React.FC<ToolComponentProps> = ({ tag, mode }) => {
  const filePath = tag.attributes.file_path || '';
  const fileContent = tag.content || '';
  const isRunning = tag.status === 'running';
  
  if (mode === 'compact') {
    return (
      <CompactToolDisplay
        icon={<FileText className="h-4 w-4 mr-2" />}
        name={isRunning ? "Rewriting file" : "Rewrote file"}
        input={filePath}
        isRunning={isRunning}
      />
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden border-subtle dark:border-white/10">
      <div className="flex items-center px-2 py-1 text-xs font-medium border-b border-subtle dark:border-white/10 bg-background-secondary dark:bg-background-secondary text-foreground">
        <FileText className="h-4 w-4 mr-2" />
        <div className="flex-1">{isRunning ? "Rewriting file" : "Rewrote file"}: {filePath}</div>
        {isRunning && (
          <div className="flex items-center gap-2">
            <span className="text-amber-500">Running</span>
            <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse"></div>
          </div>
        )}
      </div>
      <div className="p-3 bg-card-bg dark:bg-background-secondary text-foreground">
        <div className="space-y-2">
          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
            <FileText className="h-3 w-3" />
            <span className="font-mono">{filePath}</span>
          </div>
          <pre className="whitespace-pre-wrap bg-muted p-2 rounded-md text-xs overflow-x-auto max-h-60">
            {fileContent}
          </pre>
        </div>
      </div>
    </div>
  );
};

/**
 * Read File Tool Component
 */
export const ReadFileTool: React.FC<ToolComponentProps> = ({ tag, mode }) => {
  const filePath = tag.attributes.file_path || '';
  const fileContent = tag.content || '';
  const isRunning = tag.status === 'running';
  
  if (mode === 'compact') {
    return (
      <CompactToolDisplay
        icon={<File className="h-4 w-4 mr-2" />}
        name={isRunning ? "Reading file" : "Read file"}
        input={filePath}
        isRunning={isRunning}
      />
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden border-subtle dark:border-white/10">
      <div className="flex items-center px-2 py-1 text-xs font-medium border-b border-subtle dark:border-white/10 bg-background-secondary dark:bg-background-secondary text-foreground">
        <File className="h-4 w-4 mr-2" />
        <div className="flex-1">{isRunning ? "Reading file" : "Read file"}: {filePath}</div>
        {isRunning && (
          <div className="flex items-center gap-2">
            <span className="text-amber-500">Running</span>
            <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse"></div>
          </div>
        )}
      </div>
      <div className="p-3 bg-card-bg dark:bg-background-secondary text-foreground">
        <div className="space-y-2">
          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
            <File className="h-3 w-3" />
            <span className="font-mono">{filePath}</span>
          </div>
          <pre className="whitespace-pre-wrap bg-muted p-2 rounded-md text-xs overflow-x-auto max-h-60">
            {fileContent}
          </pre>
        </div>
      </div>
    </div>
  );
};

/**
 * Execute Command Tool Component
 */
export const ExecuteCommandTool: React.FC<ToolComponentProps> = ({ tag, mode }) => {
  const output = tag.content || '';
  const command = tag.resultTag?.content || '';
  const isRunning = tag.status === 'running';

  if (mode === 'compact') {
    return (
      <CompactToolDisplay
        icon={<Terminal className="h-4 w-4 mr-2" />}
        name={isRunning ? "Executing" : "Executed"}
        input={tag.content}  // in compact mode, the command is in the content
        isRunning={isRunning}
      />
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden border-subtle dark:border-white/10">
      <div className="flex items-center px-2 py-1 text-xs font-medium border-b border-subtle dark:border-white/10 bg-background-secondary dark:bg-background-secondary text-foreground">
        <Terminal className="h-4 w-4 mr-2" />
        <div className="flex-1">{isRunning ? `Executing: ${command}` : `Executed: ${command}`}</div>
        {isRunning && (
          <div className="flex items-center gap-2">
            <span className="text-amber-500">Running</span>
            <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse"></div>
          </div>
        )}
      </div>
      <div className="p-3 bg-card-bg dark:bg-background-secondary text-foreground">
        <div className="font-mono text-xs bg-black text-green-400 p-3 rounded-md">
          <div className="flex items-center gap-2 mb-2 text-white/80">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <div className="w-3 h-3 rounded-full bg-yellow-500" />
            <div className="w-3 h-3 rounded-full bg-green-500" />
            <div className="flex-1 text-center text-xs">Terminal</div>
          </div>

          <div className="space-y-1">
            <div className="flex items-start gap-2">
              <span className="text-blue-400">user@localhost</span>
              <span className="text-white/60">:</span>
              <span className="text-purple-400">~</span>
              <span className="text-white/60">$</span>
              <span>{command}</span>
            </div>
            
            {output && (
              <pre className="whitespace-pre-wrap pl-4 text-white/90">{output}</pre>
            )}

            {!isRunning && (
              <div className="flex items-start gap-2">
                <span className="text-blue-400">user@localhost</span>
                <span className="text-white/60">:</span>
                <span className="text-purple-400">~</span>
                <span className="text-white/60">$</span>
                <span className="animate-pulse">█</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * String Replace Tool Component
 */
export const StringReplaceTool: React.FC<ToolComponentProps> = ({ tag, mode }) => {
  const content = tag.content || '';
  const isRunning = tag.status === 'running';
  
  // Parse the old and new strings from the content
  const oldStrMatch = content.match(/<old_str>([\s\S]*?)<\/old_str>/);
  const newStrMatch = content.match(/<new_str>([\s\S]*?)<\/new_str>/);
  
  const oldStr = oldStrMatch ? oldStrMatch[1] : '';
  const newStr = newStrMatch ? newStrMatch[1] : '';
  
  // Calculate the diff between old and new strings
  const diff = diffLines(oldStr, newStr);
  
  interface DiffPart {
    added?: boolean;
    removed?: boolean;
    value: string;
  }

  if (mode === 'compact') {
    return (
      <CompactToolDisplay
        icon={<Replace className="h-4 w-4 mr-2" />}
        name={isRunning ? "Updating file" : "Updated file"}
        input=""
        isRunning={isRunning}
      />
    );
  }
  
  return (
    <div className="border rounded-lg overflow-hidden border-subtle dark:border-white/10">
      <div className="flex items-center px-2 py-1 text-xs font-medium border-b border-subtle dark:border-white/10 bg-background-secondary dark:bg-background-secondary text-foreground">
        <Replace className="h-4 w-4 mr-2" />
        <div className="flex-1">{isRunning ? "Updating file" : "Updated file"}</div>
        {isRunning && (
          <div className="flex items-center gap-2">
            <span className="text-amber-500">Running</span>
            <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse"></div>
          </div>
        )}
      </div>
      <div className="p-3 bg-card-bg dark:bg-background-secondary text-foreground">
        <div className="space-y-2">
          <div className="border border-subtle dark:border-white/10 rounded-md overflow-hidden font-mono text-xs">
            {diff.map((part: DiffPart, index: number) => (
              <div 
                key={index}
                className={cn(
                  "px-2 py-0.5 flex items-start",
                  part.added ? "bg-green-500/10 text-green-700 dark:text-green-400" : 
                  part.removed ? "bg-red-500/10 text-red-700 dark:text-red-400" : 
                  "text-foreground"
                )}
              >
                <span className="mr-2">
                  {part.added ? <Plus className="h-3 w-3" /> : 
                   part.removed ? <Minus className="h-3 w-3" /> : 
                   <span className="w-3" />}
                </span>
                <pre className="whitespace-pre-wrap flex-1">{part.value}</pre>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Notification Tool Component
 */
export const NotifyTool: React.FC<ToolComponentProps> = ({ tag, mode }) => {
  const message = tag.attributes.message || '';
  const type = tag.attributes.type || 'info';
  const isRunning = tag.status === 'running';
  
  if (mode === 'compact') {
    return (
      <CompactToolDisplay
        icon={<Bell className="h-4 w-4 mr-2" />}
        name={isRunning ? "Sending notification" : "Sent notification"}
        input={message.substring(0, 30) + (message.length > 30 ? '...' : '')}
        isRunning={isRunning}
      />
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden border-subtle dark:border-white/10">
      <div className="flex items-center px-2 py-1 text-xs font-medium border-b border-subtle dark:border-white/10 bg-background-secondary dark:bg-background-secondary text-foreground">
        <Bell className="h-4 w-4 mr-2" />
        <div className="flex-1">{isRunning ? "Sending notification" : "Sent notification"}: {message.substring(0, 30)}{message.length > 30 ? '...' : ''}</div>
        {isRunning && (
          <div className="flex items-center gap-2">
            <span className="text-amber-500">Running</span>
            <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse"></div>
          </div>
        )}
      </div>
      <div className="p-3 bg-card-bg dark:bg-background-secondary text-foreground">
        <div className={cn(
          "p-2 rounded-md",
          type === 'error' ? 'bg-red-500/10 text-red-600 dark:text-red-400' :
          type === 'warning' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' :
          type === 'success' ? 'bg-green-500/10 text-green-600 dark:text-green-400' :
          'bg-blue-500/10 text-blue-600 dark:text-blue-400'
        )}>
          {message}
        </div>
      </div>
    </div>
  );
};

/**
 * Directory Tool Component (for create-directory and list-directory)
 */
export const DirectoryTool: React.FC<ToolComponentProps> = ({ tag, mode }) => {
  const path = tag.attributes.path || '';
  const content = tag.content || '';
  const isListDirectory = tag.tagName === 'list-directory';
  const isRunning = tag.status === 'running';
  
  if (mode === 'compact') {
    return (
      <CompactToolDisplay
        icon={isListDirectory ? <Folder className="h-4 w-4 mr-2" /> : <FolderPlus className="h-4 w-4 mr-2" />}
        name={isListDirectory ? 
          (isRunning ? "Listing directory" : "Listed directory") : 
          (isRunning ? "Creating directory" : "Created directory")}
        input={path}
        isRunning={isRunning}
      />
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden border-subtle dark:border-white/10">
      <div className="flex items-center px-2 py-1 text-xs font-medium border-b border-subtle dark:border-white/10 bg-background-secondary dark:bg-background-secondary text-foreground">
        {isListDirectory ? <Folder className="h-4 w-4 mr-2" /> : <FolderPlus className="h-4 w-4 mr-2" />}
        <div className="flex-1">
          {isListDirectory ? 
            (isRunning ? `Listing directory: ${path}` : `Listed directory: ${path}`) : 
            (isRunning ? `Creating directory: ${path}` : `Created directory: ${path}`)}
        </div>
        {isRunning && (
          <div className="flex items-center gap-2">
            <span className="text-amber-500">Running</span>
            <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse"></div>
          </div>
        )}
      </div>
      <div className="p-3 bg-card-bg dark:bg-background-secondary text-foreground">
        <div className="space-y-2">
          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
            <Folder className="h-3 w-3" />
            <span className="font-mono">{path}</span>
          </div>
          {isListDirectory && content && (
            <pre className="whitespace-pre-wrap bg-muted p-2 rounded-md text-xs overflow-x-auto max-h-60">
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * Search Code Tool Component
 */
export const SearchCodeTool: React.FC<ToolComponentProps> = ({ tag, mode }) => {
  const query = tag.attributes.query || '';
  const content = tag.content || '';
  const isRunning = tag.status === 'running';
  
  if (mode === 'compact') {
    return (
      <CompactToolDisplay
        icon={<SearchIcon className="h-4 w-4 mr-2" />}
        name={isRunning ? "Searching code" : "Searched code"}
        input={query}
        isRunning={isRunning}
      />
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden border-subtle dark:border-white/10">
      <div className="flex items-center px-2 py-1 text-xs font-medium border-b border-subtle dark:border-white/10 bg-background-secondary dark:bg-background-secondary text-foreground">
        <SearchIcon className="h-4 w-4 mr-2" />
        <div className="flex-1">{isRunning ? "Searching code" : "Searched code"}: {query}</div>
        {isRunning && (
          <div className="flex items-center gap-2">
            <span className="text-amber-500">Running</span>
            <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse"></div>
          </div>
        )}
      </div>
      <div className="p-3 bg-card-bg dark:bg-background-secondary text-foreground">
        <div className="space-y-2">
          <div className="flex items-center gap-1 text-xs bg-primary/10 p-1 rounded">
            <SearchIcon className="h-3 w-3" />
            <span className="font-mono">{query}</span>
          </div>
          <pre className="whitespace-pre-wrap bg-muted p-2 rounded-md text-xs overflow-x-auto max-h-60">
            {content}
          </pre>
        </div>
      </div>
    </div>
  );
};

// Tool component registry
export const ToolComponentRegistry: Record<string, React.FC<ToolComponentProps>> = {
  'create-file': CreateFileTool,
  'read-file': ReadFileTool,
  'execute-command': ExecuteCommandTool,
  'str-replace': StringReplaceTool,
  'create-directory': DirectoryTool,
  'list-directory': DirectoryTool,
  'search-code': SearchCodeTool,
  'notify': NotifyTool,
  'ask': NotifyTool,  // Handle ask similar to notify for now
  'complete': NotifyTool, // Handle complete similar to notify for now
  'full-file-rewrite': FullFileRewriteTool,
};

// Helper function to get the appropriate component for a tag
export function getComponentForTag(tag: ParsedTag): React.FC<ToolComponentProps> {
  if (!ToolComponentRegistry[tag.tagName]) {
    console.warn(`No component registered for tag type: ${tag.tagName}`);
  }
  return ToolComponentRegistry[tag.tagName] || 
    // Fallback component for unknown tag types
    (({tag, mode}) => {
      console.log(`Rendering fallback component for tag: ${tag.tagName}`, tag);
      const isRunning = tag.status === 'running';
      
      if (mode === 'compact') {
        return (
          <CompactToolDisplay
            icon={<Code className="h-4 w-4 mr-2" />}
            name={isRunning ? `${tag.tagName} operation running` : `${tag.tagName} operation complete`}
            input=""
            isRunning={isRunning}
          />
        );
      }

      return (
        <div className="border rounded-lg overflow-hidden border-subtle dark:border-white/10">
          <div className="flex items-center px-2 py-1 text-xs font-medium border-b border-subtle dark:border-white/10 bg-background-secondary dark:bg-background-secondary text-foreground">
            <Code className="h-4 w-4 mr-2" />
            <div className="flex-1">{isRunning ? `${tag.tagName} operation running` : `${tag.tagName} operation complete`}</div>
            {isRunning && (
              <div className="flex items-center gap-2">
                <span className="text-amber-500">Running</span>
                <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse"></div>
              </div>
            )}
          </div>
          <div className="p-3 bg-card-bg dark:bg-background-secondary text-foreground">
            <pre className="whitespace-pre-wrap bg-muted p-2 rounded-md text-xs">{tag.content || ''}</pre>
          </div>
        </div>
      );
    });
}