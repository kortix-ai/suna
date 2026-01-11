import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { View, ScrollView, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CheckCircle2, CircleDashed } from 'lucide-react-native';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { getUserFriendlyToolName } from '@agentpress/shared';
// NOTE: useSmoothText removed - displaying content immediately (following frontend pattern)
import { getToolIcon } from '@/lib/icons/tool-icons';

const STREAMABLE_TOOLS = {
  FILE_OPERATIONS: new Set([
    'Creating File',
    'Rewriting File',
    'AI File Edit',
    'Editing Text',
    'Editing File',
    'Deleting File',
  ]),
  COMMAND_TOOLS: new Set([
    'Executing Command',
    'Checking Command Output',
    'Terminating Command',
    'Listing Commands',
  ]),
  BROWSER_TOOLS: new Set([
    'Navigating to Page',
    'Performing Action',
    'Extracting Content',
    'Taking Screenshot',
  ]),
  WEB_TOOLS: new Set([
    'Searching Web',
    'Crawling Website',
    'Scraping Website',
  ]),
  OTHER_STREAMABLE: new Set([
    'Calling data provider',
    'Getting endpoints',
    'Creating Tasks',
    'Updating Tasks',
    'Viewing Image',
    'Creating Presentation Outline',
    'Creating Presentation',
    'Exposing Port',
    'Getting Worker Config',
    'Searching MCP Servers',
  ])
};

function isStreamableTool(toolName: string): boolean {
  return Object.values(STREAMABLE_TOOLS).some(toolSet => toolSet.has(toolName));
}

function extractToolNameFromStream(content: string): string | null {
  if (!content || typeof content !== 'string') return null;

  const invokeMatch = content.match(/<invoke\s+name=["']([^"']+)["']/i);
  if (invokeMatch) {
    return invokeMatch[1].replace(/_/g, '-');
  }

  const oldFormatMatch = content.match(/<([a-zA-Z\-_]+)(?:\s+[^>]*)?>(?!\/)/);
  if (oldFormatMatch) {
    return oldFormatMatch[1].replace(/_/g, '-');
  }

  return null;
}

function extractPrimaryParameter(content: string): string | null {
  if (!content || typeof content !== 'string') return null;

  const paramPatterns = [
    /<parameter\s+name=["']file_path["']>(.*?)(<\/parameter>|$)/i,
    /<parameter\s+name=["']command["']>(.*?)(<\/parameter>|$)/i,
    /<parameter\s+name=["']query["']>(.*?)(<\/parameter>|$)/i,
    /<parameter\s+name=["']url["']>(.*?)(<\/parameter>|$)/i,
    /<parameter\s+name=["']text["']>(.*?)(<\/parameter>|$)/i,
  ];

  for (const pattern of paramPatterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      const value = match[1].trim();
      if (value.length > 40) {
        return value.substring(0, 37) + '...';
      }
      return value;
    }
  }

  return null;
}

function extractStreamingContent(content: string, toolName: string): string {
  if (!content || typeof content !== 'string') return '';

  const isCreateFile = toolName === 'Creating File';
  const isEditFile = toolName === 'AI File Edit';
  const isFullFileRewrite = toolName === 'Rewriting File';

  if (STREAMABLE_TOOLS.FILE_OPERATIONS.has(toolName)) {
    let paramName: string | null = null;
    if (isEditFile) paramName = 'code_edit';
    else if (isCreateFile || isFullFileRewrite) paramName = 'file_contents';

    if (paramName) {
      const newMatch = content.match(new RegExp(`<parameter\\s+name=["']${paramName}["']>([\\s\\S]*)`, 'i'));
      if (newMatch && newMatch[1]) {
        const cleanContent = newMatch[1].replace(/<\/parameter>[\s\S]*$/, '');
        return cleanContent;
      }
      if (isEditFile) {
        const oldMatch = content.match(/<code_edit>([\s\S]*)/i);
        if (oldMatch && oldMatch[1]) {
          const cleanContent = oldMatch[1].replace(/<\/code_edit>[\s\S]*$/, '');
          return cleanContent;
        }
      }
    }
  }

  if (STREAMABLE_TOOLS.COMMAND_TOOLS.has(toolName)) {
    const commandMatch = content.match(/<parameter\s+name=["']command["']>([\s\S]*?)(<\/parameter>|$)/i);
    if (commandMatch && commandMatch[1]) {
      return commandMatch[1].trim();
    }
  }

  if (STREAMABLE_TOOLS.WEB_TOOLS.has(toolName)) {
    const queryMatch = content.match(/<parameter\s+name=["']query["']>([\s\S]*?)(<\/parameter>|$)/i);
    const urlMatch = content.match(/<parameter\s+name=["']url["']>([\s\S]*?)(<\/parameter>|$)/i);

    if (queryMatch && queryMatch[1]) {
      return queryMatch[1].trim();
    }
    if (urlMatch && urlMatch[1]) {
      return urlMatch[1].trim();
    }
  }

  if (STREAMABLE_TOOLS.OTHER_STREAMABLE.has(toolName)) {
    const commonParams = ['text', 'content', 'data', 'config', 'description', 'prompt'];
    for (const param of commonParams) {
      const match = content.match(new RegExp(`<parameter\\s+name=["']${param}["']>([\\s\\S]*?)(<\\/parameter>|$)`, 'i'));
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  }

  return '';
}

interface StreamingToolCardProps {
  content: string;
  isCompleted?: boolean;
  toolCall?: { completed?: boolean; tool_result?: any } | null;
}

export const StreamingToolCard = React.memo(function StreamingToolCard({ content, isCompleted: propIsCompleted, toolCall }: StreamingToolCardProps) {
  const scrollViewRef = useRef<ScrollView>(null);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const contentHeightRef = useRef(0);
  const scrollViewHeightRef = useRef(0);

  const toolInfo = useMemo(() => {
    const rawToolName = extractToolNameFromStream(content);
    if (!rawToolName) return null;

    const displayName = getUserFriendlyToolName(rawToolName);
    const IconComponent = getToolIcon(rawToolName);
    const primaryParam = extractPrimaryParameter(content);
    const rawStreamingContent = extractStreamingContent(content, displayName);
    const shouldShowContent = isStreamableTool(displayName) && rawStreamingContent.length > 0;

    return {
      rawToolName,
      displayName,
      IconComponent,
      primaryParam,
      rawStreamingContent,
      shouldShowContent,
    };
  }, [content]);

  // Display tool streaming content immediately (following frontend pattern - no artificial delay)
  const smoothStreamingContent = toolInfo?.rawStreamingContent || '';

  // Track if user has scrolled away from bottom
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    // Consider "at bottom" if within 50px of the bottom
    setIsUserScrolledUp(distanceFromBottom > 50);
  }, []);

  // Only auto-scroll if user hasn't scrolled up
  useEffect(() => {
    if (scrollViewRef.current && smoothStreamingContent && !isUserScrolledUp) {
      scrollViewRef.current.scrollToEnd({ animated: false });
    }
  }, [smoothStreamingContent, isUserScrolledUp]);

  if (!toolInfo) {
    const fallbackIsCompleted = propIsCompleted || 
                                toolCall?.completed === true || 
                                (toolCall?.tool_result !== undefined && toolCall?.tool_result !== null);
    return (
      <View className="flex-row items-center gap-3 p-3 rounded-3xl border border-border bg-card">
        <View className="h-8 w-8 rounded-xl border border-border bg-background items-center justify-center">
          <Icon as={CircleDashed} size={16} className="text-primary" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-roobert-medium text-foreground mb-0.5">
            Loading...
          </Text>
        </View>
        {fallbackIsCompleted ? (
          <Icon as={CheckCircle2} size={16} className="text-emerald-500" />
        ) : (
          <KortixLoader size="small" />
        )}
      </View>
    );
  }

  const { displayName, IconComponent, primaryParam, shouldShowContent } = toolInfo;
  
  // Check if tool is completed (from prop or toolCall)
  const isCompleted = propIsCompleted || 
                     toolCall?.completed === true || 
                     (toolCall?.tool_result !== undefined && 
                      toolCall?.tool_result !== null &&
                      (typeof toolCall.tool_result === 'object' || Boolean(toolCall.tool_result)));

  if (!shouldShowContent) {
    return (
      <View className="flex-row items-center gap-3 p-3 rounded-3xl border border-border bg-card">
        <View className="h-8 w-8 rounded-xl border border-border bg-background items-center justify-center">
          <Icon as={IconComponent} size={16} className="text-primary" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-roobert-medium text-foreground mb-0.5">
            {displayName}
          </Text>
          {primaryParam && (
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {primaryParam}
            </Text>
          )}
        </View>
        {isCompleted ? (
          <Icon as={CheckCircle2} size={16} className="text-emerald-500" />
        ) : (
          <KortixLoader size="small" />
        )}
      </View>
    );
  }

  return (
    <View className="rounded-3xl border border-border bg-card overflow-hidden">
      <View className="flex-row items-center gap-3 p-3 border-b border-border">
        <View className="h-8 w-8 rounded-xl border border-border bg-background items-center justify-center">
          <Icon as={IconComponent} size={16} className="text-primary" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-roobert-medium text-foreground mb-0.5">
            {displayName}
          </Text>
          {primaryParam && (
            <Text className="text-xs text-muted-foreground" numberOfLines={1}>
              {primaryParam}
            </Text>
          )}
        </View>
        {isCompleted ? (
          <Icon as={CheckCircle2} size={16} className="text-emerald-500" />
        ) : (
          <KortixLoader size="small" />
        )}
      </View>

      <ScrollView
        ref={scrollViewRef}
        className="max-h-[300px] bg-card"
        showsVerticalScrollIndicator={true}
        onScroll={handleScroll}
        scrollEventThrottle={16}
      >
        <View className="p-3">
          <Text
            className="text-xs text-foreground font-roobert-mono"
            style={{ fontFamily: 'monospace' }}
          >
            {smoothStreamingContent}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
});
