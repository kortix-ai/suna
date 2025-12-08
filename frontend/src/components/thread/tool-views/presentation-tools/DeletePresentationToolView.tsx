import React from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Trash2,
  Clock,
  CheckCircle,
  AlertTriangle,
  Folder,
  FolderX,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp } from '../utils';
import { LoadingState } from '../shared/LoadingState';

interface DeletePresentationData {
  message: string;
  deleted_path: string;
}

export function DeletePresentationToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
}: ToolViewProps) {
  // Defensive check - handle cases where toolCall might be undefined
  if (!toolCall) {
    console.warn('DeletePresentationToolView: toolCall is undefined. Tool views should use structured props.');
    return null;
  }

  // Extract from toolResult.output (from metadata)
  let deleteData: DeletePresentationData | null = null;
  let error: string | null = null;

  try {
    if (toolResult?.output) {
      let output = toolResult.output;
      if (typeof output === 'string') {
        // Try to parse as JSON first, but handle plain string messages
        try {
          // Check if it looks like JSON (starts with { or [)
          if (output.trim().startsWith('{') || output.trim().startsWith('[')) {
            deleteData = JSON.parse(output);
          } else {
            // It's a plain string message, create a deleteData object from it
            // Try to extract path from toolCall arguments or the message
            const deletedPath = toolCall.arguments?.presentation_name || 
                              toolCall.arguments?.path || 
                              output.match(/['"]([^'"]+)['"]/)?.[1] || 
                              'Unknown';
            deleteData = {
              message: output,
              deleted_path: deletedPath,
            };
          }
        } catch (e) {
          // If JSON parsing fails, treat as plain string message
          const deletedPath = toolCall.arguments?.presentation_name || 
                            toolCall.arguments?.path || 
                            output.match(/['"]([^'"]+)['"]/)?.[1] || 
                            'Unknown';
          deleteData = {
            message: output,
            deleted_path: deletedPath,
          };
        }
      } else if (typeof output === 'object' && output !== null) {
        // Already an object, use it directly
        deleteData = output as unknown as DeletePresentationData;
        // Ensure required fields exist
        if (!deleteData.deleted_path && toolCall.arguments) {
          deleteData.deleted_path = toolCall.arguments.presentation_name || 
                                   toolCall.arguments.path || 
                                   'Unknown';
        }
        if (!deleteData.message && typeof output === 'object') {
          deleteData.message = (output as any).message || 'Presentation deleted successfully';
        }
      }
    } else {
      // No output, try to construct from arguments
      if (toolCall.arguments) {
        const deletedPath = toolCall.arguments.presentation_name || 
                           toolCall.arguments.path || 
                           'Unknown';
        deleteData = {
          message: 'Presentation deleted successfully',
          deleted_path: deletedPath,
        };
      }
    }
  } catch (e) {
    console.error('Error parsing delete data:', e);
    // Try to construct from arguments as fallback
    if (toolCall.arguments) {
      const deletedPath = toolCall.arguments.presentation_name || 
                         toolCall.arguments.path || 
                         'Unknown';
      deleteData = {
        message: 'Presentation deleted',
        deleted_path: deletedPath,
      };
    } else {
      error = 'Failed to parse delete data';
    }
  }

  const presentationName = deleteData?.deleted_path?.split('/').pop() || 
                          toolCall.arguments?.presentation_name?.split('/').pop() || 
                          'Unknown';

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg bg-gradient-to-br from-red-500/20 to-red-600/10 border border-red-500/20">
              <FolderX className="w-5 h-5 text-red-500 dark:text-red-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                Delete Presentation
              </CardTitle>
              {deleteData && (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {presentationName}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!isStreaming && !error && deleteData && (
              <Badge
                variant="secondary"
                className="bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
              >
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
                Deleted
              </Badge>
            )}
            {!isStreaming && (error || !isSuccess) && (
              <Badge
                variant="secondary"
                className="bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
              >
                <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                Failed
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={FolderX}
            iconColor="text-red-500 dark:text-red-400"
            bgColor="bg-gradient-to-b from-red-100 to-red-50 shadow-inner dark:from-red-800/40 dark:to-red-900/60 dark:shadow-red-950/20"
            title="Deleting presentation"
            filePath="Removing all files..."
            showProgress={true}
          />
        ) : error || !deleteData ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-rose-100 to-rose-50 shadow-inner dark:from-rose-800/40 dark:to-rose-900/60">
              <AlertTriangle className="h-10 w-10 text-rose-400 dark:text-rose-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              {error || 'Failed to delete presentation'}
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md">
              There was an error deleting the presentation. Please try again.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-emerald-100 to-emerald-50 shadow-inner dark:from-emerald-800/40 dark:to-emerald-900/60">
              <CheckCircle className="h-10 w-10 text-emerald-400 dark:text-emerald-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              Presentation deleted successfully
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md mb-6">
              {deleteData.message}
            </p>
            
            <Card className="p-6 w-full max-w-md">
              <div className="flex items-center gap-3">
                <div className="flex items-center justify-center w-12 h-12 rounded-lg bg-red-100 dark:bg-red-900/20">
                  <FolderX className="h-6 w-6 text-red-600 dark:text-red-400" />
                </div>
                <div className="flex-1">
                  <h4 className="font-medium text-zinc-900 dark:text-zinc-100 mb-1">
                    Deleted Path
                  </h4>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400 font-mono">
                    {deleteData.deleted_path}
                  </p>
                </div>
              </div>
            </Card>
            
            <p className="text-xs text-zinc-400 dark:text-zinc-500 text-center mt-4">
              All slides and metadata have been permanently removed
            </p>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-end items-center">
        <div className="flex items-center gap-2 text-xs text-zinc-400 dark:text-zinc-500">
          <Clock className="h-3 w-3" />
          <span>
            {formatTimestamp(toolTimestamp)}
          </span>
        </div>
      </div>
    </Card>
  );
}
