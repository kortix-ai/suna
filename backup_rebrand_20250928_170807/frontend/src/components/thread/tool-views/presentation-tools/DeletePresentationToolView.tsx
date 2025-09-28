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
import { formatTimestamp, extractToolData } from '../utils';
import { LoadingState } from '../shared/LoadingState';

interface DeletePresentationData {
  message: string;
  deleted_path: string;
}

export function DeletePresentationToolView({
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  name,
  project,
}: ToolViewProps) {
  const { toolResult } = extractToolData(toolContent);
  
  let deleteData: DeletePresentationData | null = null;
  let error: string | null = null;

  try {
    if (toolResult && toolResult.toolOutput && toolResult.toolOutput !== 'STREAMING') {
      const output = toolResult.toolOutput;
      if (typeof output === 'string') {
        try {
          deleteData = JSON.parse(output);
        } catch (e) {
          console.error('Failed to parse tool output:', e);
          error = 'Failed to parse delete data';
        }
      } else {
        deleteData = output as unknown as DeletePresentationData;
      }
    }
  } catch (e) {
    console.error('Error parsing delete data:', e);
    error = 'Failed to parse delete data';
  }

  const presentationName = deleteData?.deleted_path?.split('/').pop() || 'Unknown';

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
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
