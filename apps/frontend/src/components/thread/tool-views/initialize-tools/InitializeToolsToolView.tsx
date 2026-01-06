'use client';

import React from 'react';
import { ToolViewProps } from '../types';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  Presentation, 
  Sparkles, 
  Settings, 
  CheckCircle,
  LucideIcon
} from 'lucide-react';
import { ToolViewHeader } from '../shared/ToolViewHeader';
import { ToolViewFooter } from '../shared/ToolViewFooter';

/**
 * Maps tool names to their friendly display mode names and icons
 * All use neutral colors for consistency
 */
const TOOL_MODE_CONFIG: Record<string, { name: string; icon: LucideIcon }> = {
  'sb_presentation_tool': {
    name: 'Presentation Mode',
    icon: Presentation,
  },
  'presentation': {
    name: 'Presentation Mode',
    icon: Presentation,
  },
};

const DEFAULT_MODE_CONFIG = {
  name: 'Tools',
  icon: Settings,
};

/**
 * Formats a tool name into a readable display name
 * e.g., "sb_file_operations" -> "File Operations"
 */
function formatToolName(toolName: string): string {
  return toolName
    .replace(/^sb_/, '') // Remove sb_ prefix
    .replace(/_/g, ' ')  // Replace underscores with spaces
    .replace(/-/g, ' ')  // Replace hyphens with spaces
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function InitializeToolsToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  // Extract the tool_names from arguments to determine which mode is being activated
  const toolNames = React.useMemo(() => {
    if (!toolCall?.arguments) return [];
    
    const args = toolCall.arguments;
    if (typeof args === 'string') {
      try {
        const parsed = JSON.parse(args);
        return parsed.tool_names ? [parsed.tool_names].flat() : [];
      } catch {
        return [];
      }
    }
    
    if (typeof args === 'object' && args !== null) {
      const toolNamesArg = (args as any).tool_names;
      if (toolNamesArg) {
        return Array.isArray(toolNamesArg) ? toolNamesArg : [toolNamesArg];
      }
    }
    
    return [];
  }, [toolCall?.arguments]);

  // Determine the mode configuration based on the tool names
  const modeConfig = React.useMemo(() => {
    for (const toolName of toolNames) {
      const normalizedName = toolName.toLowerCase().replace(/-/g, '_');
      if (TOOL_MODE_CONFIG[normalizedName]) {
        return TOOL_MODE_CONFIG[normalizedName];
      }
      // Check for partial matches
      for (const [key, config] of Object.entries(TOOL_MODE_CONFIG)) {
        if (normalizedName.includes(key) || key.includes(normalizedName)) {
          return config;
        }
      }
    }
    return DEFAULT_MODE_CONFIG;
  }, [toolNames]);

  const Icon = modeConfig.icon;
  const title = isStreaming ? `Activating ${modeConfig.name}...` : `${modeConfig.name} Activated`;

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <ToolViewHeader icon={Icon} title={title} />

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {/* Clean minimal background */}
        <div className="absolute inset-0 bg-white dark:bg-zinc-950" />
        
        <div className="relative flex flex-col items-center justify-center h-full py-10 px-6">
          {/* Minimal icon container */}
          <div className={`relative w-12 h-12 mb-4 ${isStreaming ? 'animate-pulse' : ''}`}>
            <div className="absolute inset-0 rounded-full border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 flex items-center justify-center">
              {isStreaming ? (
                <Sparkles className="h-5 w-5 text-zinc-400 dark:text-zinc-500" />
              ) : (
                <CheckCircle className="h-5 w-5 text-zinc-900 dark:text-zinc-100" />
              )}
            </div>
          </div>

          {/* Title */}
          <h3 className="text-base font-medium mb-1 text-zinc-900 dark:text-zinc-100 tracking-tight">
            {isStreaming ? `Activating ${modeConfig.name}...` : `${modeConfig.name} Ready`}
          </h3>
          
          {/* Subtitle */}
          <p className="text-xs text-zinc-400 dark:text-zinc-500 text-center mb-4 font-mono">
            {isStreaming 
              ? 'Preparing...'
              : `${toolNames.length} tool${toolNames.length !== 1 ? 's' : ''} activated`
            }
          </p>

          {/* Tool badges - minimal monochrome style */}
          {toolNames.length > 0 && (
            <div className="flex flex-wrap justify-center gap-1.5 max-w-md">
              {toolNames.map((tool, index) => (
                <div
                  key={tool}
                  className={`
                    flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono
                    transition-all duration-300 ease-out
                    bg-zinc-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 
                    border border-zinc-200 dark:border-zinc-800
                  `}
                  style={{
                    animation: !isStreaming ? `fadeSlideIn 0.3s ease-out ${index * 0.05}s both` : undefined,
                  }}
                >
                  <span className="text-zinc-400 dark:text-zinc-600">›</span>
                  <span>{formatToolName(tool)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* CSS for staggered animation */}
        <style jsx>{`
          @keyframes fadeSlideIn {
            from {
              opacity: 0;
              transform: translateY(4px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
        `}</style>
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (
          <Badge variant="outline" className="h-5 py-0 px-2 bg-zinc-100 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800">
            <span className="text-[10px] font-mono text-zinc-600 dark:text-zinc-400 uppercase tracking-wider">Ready</span>
          </Badge>
        )}
      </ToolViewFooter>
    </Card>
  );
}
