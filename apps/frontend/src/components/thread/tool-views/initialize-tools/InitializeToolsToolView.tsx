'use client';

import React from 'react';
import { ToolViewProps } from '../types';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  Presentation, 
  Sparkles, 
  Settings, 
  CheckCircle
} from 'lucide-react';
import { ToolViewHeader } from '../shared/ToolViewHeader';
import { ToolViewFooter } from '../shared/ToolViewFooter';

/**
 * Maps tool names to their friendly display mode names and icons
 * All use neutral colors for consistency
 */
const TOOL_MODE_CONFIG: Record<string, { name: string; icon: React.ElementType }> = {
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
        <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
          <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-zinc-100 dark:bg-zinc-800 shadow-inner">
            {isStreaming ? (
              <Sparkles className="h-10 w-10 text-zinc-500 dark:text-zinc-400 animate-pulse" />
            ) : (
              <CheckCircle className="h-10 w-10 text-zinc-700 dark:text-zinc-300" />
            )}
          </div>
          <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
            {isStreaming ? `Activating ${modeConfig.name}...` : `${modeConfig.name} Activated`}
          </h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md">
            {isStreaming 
              ? `Setting up the tools needed for ${modeConfig.name.toLowerCase()}.`
              : `Ready to use ${modeConfig.name.toLowerCase()} features.`
            }
          </p>
        </div>
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (
          <Badge variant="outline" className="h-6 py-0.5 bg-zinc-100 dark:bg-zinc-800">
            <CheckCircle className="h-3 w-3 text-zinc-600 dark:text-zinc-400" />
            <span className="text-zinc-600 dark:text-zinc-400">Ready</span>
          </Badge>
        )}
      </ToolViewFooter>
    </Card>
  );
}
