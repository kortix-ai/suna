import React from 'react';
import {
  Save,
  CheckCircle,
  AlertTriangle,
  CircleDashed,
  Tag,
  Star,
} from 'lucide-react';
import { ToolViewProps } from './types';
import { GenericToolView } from './GenericToolView';
import { cn } from '@/lib/utils';

interface MemorySaveData {
  memory_type: 'semantic' | 'episodic' | 'procedural';
  content: string;
  tags?: string[];
  importance_score?: number;
}

function extractMemorySaveContent(content: string): MemorySaveData | null {
  try {
    const match = content.match(/<save-memory[^>]*>([\s\S]*?)<\/save-memory>/);
    if (!match) return null;

    const typeMatch = content.match(/memory_type="([^"]+)"/);
    const tagsMatch = content.match(/tags="([^"]+)"/);
    const scoreMatch = content.match(/importance_score="([^"]+)"/);

    return {
      memory_type: (typeMatch?.[1] as MemorySaveData['memory_type']) || 'semantic',
      content: match[1].trim(),
      tags: tagsMatch?.[1]?.split(',').map(tag => tag.trim()) || [],
      importance_score: scoreMatch ? parseFloat(scoreMatch[1]) : undefined
    };
  } catch (e) {
    return null;
  }
}

export function MemorySaveToolView({
  name = 'save-memory',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const memoryData = extractMemorySaveContent(assistantContent);
  const toolTitle = 'Save Memory';

  if (!memoryData) {
    return (
      <GenericToolView
        name={name}
        assistantContent={assistantContent}
        toolContent={toolContent}
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isSuccess={isSuccess}
        isStreaming={isStreaming}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 p-4 overflow-auto">
        <div className="border border-zinc-200 dark:border-zinc-800 rounded-md overflow-hidden h-full flex flex-col">
          <div className="flex items-center p-2 bg-zinc-100 dark:bg-zinc-900 justify-between border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center">
              <Save className="h-4 w-4 mr-2 text-zinc-600 dark:text-zinc-400" />
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                {toolTitle}
              </span>
            </div>
          </div>

          {isStreaming ? (
            <div className="flex-1 bg-white dark:bg-zinc-950 flex items-center justify-center">
              <div className="text-center p-6">
                <CircleDashed className="h-8 w-8 mx-auto mb-3 text-blue-500 animate-spin" />
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Saving memory...
                </p>
              </div>
            </div>
          ) : (
            <div className="p-4 bg-white dark:bg-zinc-950 flex-1">
              <div className="space-y-4">
                {/* Memory Type Badge */}
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    Type:
                  </span>
                  <span className={cn(
                    "px-2 py-1 rounded-full text-xs font-medium",
                    memoryData.memory_type === 'semantic' && "bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400",
                    memoryData.memory_type === 'episodic' && "bg-purple-100 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400",
                    memoryData.memory_type === 'procedural' && "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                  )}>
                    {memoryData.memory_type}
                  </span>
                </div>

                {/* Content */}
                <div>
                  <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                    Content:
                  </div>
                  <div className="text-sm text-zinc-700 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900 p-3 rounded-md">
                    {memoryData.content}
                  </div>
                </div>

                {/* Tags */}
                {memoryData.tags && memoryData.tags.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    <div className="flex items-center gap-2 w-full">
                      <Tag className="h-3.5 w-3.5 text-zinc-400" />
                      <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                        Tags:
                      </span>
                    </div>
                    {memoryData.tags.map((tag, i) => (
                      <span
                        key={i}
                        className="px-2 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-full text-xs"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                {/* Importance Score */}
                {memoryData.importance_score !== undefined && (
                  <div className="flex items-center gap-2">
                    <Star className="h-3.5 w-3.5 text-zinc-400" />
                    <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                      Importance:
                    </span>
                    <span className="text-xs text-zinc-700 dark:text-zinc-300">
                      {memoryData.importance_score.toFixed(1)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
          {!isStreaming && (
            <div className="flex items-center gap-2">
              {isSuccess ? (
                <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
              )}
              <span>
                {isSuccess ? 'Memory saved successfully' : 'Failed to save memory'}
              </span>
            </div>
          )}

          {isStreaming && (
            <div className="flex items-center gap-2">
              <CircleDashed className="h-3.5 w-3.5 text-blue-500 animate-spin" />
              <span>Saving memory...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
} 