import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Presentation, Settings, CheckCircle, Sparkles } from 'lucide-react-native';
import type { ToolViewProps } from '../types';

const TOOL_MODE_CONFIG: Record<string, { name: string; icon: any }> = {
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

function formatToolName(toolName: string): string {
  return toolName
    .replace(/^sb_/, '')
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function InitializeToolsToolView({
  toolCall,
  isStreaming = false,
}: ToolViewProps) {
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

  const modeConfig = React.useMemo(() => {
    for (const toolName of toolNames) {
      const normalizedName = toolName.toLowerCase().replace(/-/g, '_');
      if (TOOL_MODE_CONFIG[normalizedName]) {
        return TOOL_MODE_CONFIG[normalizedName];
      }
      for (const [key, config] of Object.entries(TOOL_MODE_CONFIG)) {
        if (normalizedName.includes(key) || key.includes(normalizedName)) {
          return config;
        }
      }
    }
    return DEFAULT_MODE_CONFIG;
  }, [toolNames]);

  const title = isStreaming 
    ? `Activating ${modeConfig.name}...` 
    : `${modeConfig.name} Ready`;

  const subtitle = isStreaming 
    ? 'Preparing tools...'
    : `${toolNames.length} tool${toolNames.length !== 1 ? 's' : ''} activated`;

  return (
    <View className="flex-1 items-center justify-center py-12">
      <View className="w-20 h-20 rounded-full bg-primary/10 border-2 border-primary/20 items-center justify-center">
        {isStreaming ? (
          <Icon as={Sparkles} size={32} className="text-primary" />
        ) : (
          <Icon as={CheckCircle} size={32} className="text-primary" />
        )}
      </View>

      <View className="mt-5 items-center">
        <Text className="text-xl font-roobert-semibold text-foreground">
          {title}
        </Text>
        <Text className="text-sm text-muted-foreground mt-1">
          {subtitle}
        </Text>
      </View>

      {toolNames.length > 0 && (
        <View className="mt-6 flex-row flex-wrap justify-center gap-2 px-4">
          {toolNames.map((tool) => (
            <View 
              key={tool}
              className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2"
            >
              <View className="flex-row items-center gap-2">
                <Text className="text-primary/50 text-xs">›</Text>
                <Text className="text-sm font-roobert-medium text-primary">{formatToolName(tool)}</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {!isStreaming && (
        <View className="mt-6">
          <View className="px-4 py-2 rounded-full bg-primary">
            <Text className="text-xs font-roobert-semibold text-primary-foreground uppercase tracking-wider">
              Ready
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}
