import React from 'react';
import {
  Search,
  CheckCircle,
  AlertTriangle,
  CircleDashed,
  Tag,
  Star,
  Clock,
} from 'lucide-react';
import { ToolViewProps } from './types';
import { GenericToolView } from './GenericToolView';
import { cn } from '@/lib/utils';

interface RetrievedMemory {
  memory_id: string;
  memory_type: 'semantic' | 'episodic' | 'procedural';
  content: string;
  tags: string[];
  importance_score: number;
  created_at: string;
  last_accessed: string;
}

interface MemoryRetrieveData {
  query?: string;
  memory_types?: string[];
  tags?: string[];
  limit?: number;
  min_importance?: number;
  memories?: RetrievedMemory[];
}

function extractMemoryRetrieveContent(content: string): MemoryRetrieveData | null {
  try {
    // Extract content between retrieve_memories tags
    const match = content.match(/<retrieve_memories[^>]*>([\s\S]*?)<\/retrieve_memories>/);
    if (!match) return null;

    // Extract attributes
    const queryMatch = content.match(/<retrieve_memories[^>]*>([\s\S]*?)<\/retrieve_memories>/);
    const typesMatch = content.match(/memory_types="([^"]+)"/);
    const tagsMatch = content.match(/tags="([^"]+)"/);
    const limitMatch = content.match(/limit="([^"]+)"/);
    const importanceMatch = content.match(/min_importance="([^"]+)"/);

    return {
      query: queryMatch?.[1]?.trim(),
      memory_types: typesMatch?.[1]?.split(',').map(type => type.trim()),
      tags: tagsMatch?.[1]?.split(',').map(tag => tag.trim()),
      limit: limitMatch ? parseInt(limitMatch[1]) : undefined,
      min_importance: importanceMatch ? parseFloat(importanceMatch[1]) : undefined
    };
  } catch (e) {
    return null;
  }
}

function parseToolContent(content: string): RetrievedMemory[] | null {
  try {
    const data = JSON.parse(content);
    return data.memories || null;
  } catch (e) {
    return null;
  }
}

export function MemoryRetrieveToolView({
  name = 'retrieve_memories',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const retrieveData = extractMemoryRetrieveContent(assistantContent);
  const memories = parseToolContent(toolContent || '{}');
  const toolTitle = 'Retrieve Memories';

  if (!retrieveData) {
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
              <Search className="h-4 w-4 mr-2 text-zinc-600 dark:text-zinc-400" />
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
                  Retrieving memories...
                </p>
              </div>
            </div>
          ) : (
            <div className="p-4 bg-white dark:bg-zinc-950 flex-1">
              {/* Search Parameters */}
              <div className="mb-4 space-y-2">
                {retrieveData.query && (
                  <div className="text-sm">
                    <span className="text-zinc-500 dark:text-zinc-400">Query: </span>
                    <span className="text-zinc-700 dark:text-zinc-300">{retrieveData.query}</span>
                  </div>
                )}
                {retrieveData.memory_types && retrieveData.memory_types.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">Types: </span>
                    {retrieveData.memory_types.map((type, i) => (
                      <span
                        key={i}
                        className={cn(
                          "px-2 py-1 rounded-full text-xs font-medium",
                          type === 'semantic' && "bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400",
                          type === 'episodic' && "bg-purple-100 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400",
                          type === 'procedural' && "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                        )}
                      >
                        {type}
                      </span>
                    ))}
                  </div>
                )}
                {retrieveData.tags && retrieveData.tags.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    <span className="text-zinc-500 dark:text-zinc-400">Tags: </span>
                    {retrieveData.tags.map((tag, i) => (
                      <span
                        key={i}
                        className="px-2 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-full text-xs"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Retrieved Memories */}
              {memories && memories.length > 0 ? (
                <div className="space-y-4">
                  {memories.map((memory) => (
                    <div
                      key={memory.memory_id}
                      className="border border-zinc-200 dark:border-zinc-800 rounded-md p-3 space-y-2"
                    >
                      {/* Memory Type */}
                      <div className="flex items-center gap-2">
                        <span className={cn(
                          "px-2 py-1 rounded-full text-xs font-medium",
                          memory.memory_type === 'semantic' && "bg-blue-100 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400",
                          memory.memory_type === 'episodic' && "bg-purple-100 text-purple-700 dark:bg-purple-900/20 dark:text-purple-400",
                          memory.memory_type === 'procedural' && "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                        )}>
                          {memory.memory_type}
                        </span>
                        <div className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                          <Star className="h-3 w-3" />
                          <span>{memory.importance_score.toFixed(1)}</span>
                        </div>
                      </div>

                      {/* Content */}
                      <div className="text-sm text-zinc-700 dark:text-zinc-300">
                        {memory.content}
                      </div>

                      {/* Tags */}
                      {memory.tags && memory.tags.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {memory.tags.map((tag, i) => (
                            <span
                              key={i}
                              className="px-2 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded-full text-xs"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Timestamps */}
                      <div className="flex items-center gap-4 text-xs text-zinc-500 dark:text-zinc-400">
                        <div className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          <span>Created: {new Date(memory.created_at).toLocaleString()}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          <span>Last accessed: {new Date(memory.last_accessed).toLocaleString()}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-zinc-500 dark:text-zinc-400">
                  No memories found
                </div>
              )}
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
                {isSuccess
                  ? `Retrieved ${memories?.length || 0} memories`
                  : 'Failed to retrieve memories'}
              </span>
            </div>
          )}

          {isStreaming && (
            <div className="flex items-center gap-2">
              <CircleDashed className="h-3.5 w-3.5 text-blue-500 animate-spin" />
              <span>Retrieving memories...</span>
            </div>
          )}

          <div className="text-xs">
            {toolTimestamp && !isStreaming
              ? new Date(toolTimestamp).toLocaleString()
              : assistantTimestamp
                ? new Date(assistantTimestamp).toLocaleString()
                : ''}
          </div>
        </div>
      </div>
    </div>
  );
} 