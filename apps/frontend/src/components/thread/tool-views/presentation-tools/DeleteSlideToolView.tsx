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
  FileText,
  Hash,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp } from '../utils';
import { LoadingState } from '../shared/LoadingState';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';

interface DeleteSlideData {
  message: string;
  presentation_name: string;
  deleted_slide: number;
  deleted_title: string;
  remaining_slides: number;
}

export function DeleteSlideToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
}: ToolViewProps) {
  // Extract from toolResult.output (from metadata)
  let deleteData: DeleteSlideData | null = null;
  let error: string | null = null;

  try {
    if (toolResult?.output) {
      let output = toolResult.output;
      if (typeof output === 'string') {
        try {
          deleteData = JSON.parse(output);
        } catch (e) {
          console.error('Failed to parse tool output:', e);
          error = 'Failed to parse delete data';
        }
      } else {
        deleteData = output as unknown as DeleteSlideData;
      }
    }
  } catch (e) {
    console.error('Error parsing delete data:', e);
    error = 'Failed to parse delete data';
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle icon={Trash2} title="Delete Slide" subtitle={deleteData?.deleted_title} />
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Trash2}
            iconColor="text-red-500 dark:text-red-400"
            bgColor="bg-gradient-to-b from-red-100 to-red-50 shadow-inner dark:from-red-800/40 dark:to-red-900/60 dark:shadow-red-950/20"
            title="Deleting slide"
            filePath="Removing slide file..."
            showProgress={true}
          />
        ) : error || !deleteData ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-rose-100 to-rose-50 shadow-inner dark:from-rose-800/40 dark:to-rose-900/60">
              <AlertTriangle className="h-10 w-10 text-rose-400 dark:text-rose-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              {error || 'Failed to delete slide'}
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md">
              There was an error deleting the slide. Please try again.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-emerald-100 to-emerald-50 shadow-inner dark:from-emerald-800/40 dark:to-emerald-900/60">
              <CheckCircle className="h-10 w-10 text-zinc-500 dark:text-zinc-400" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              Slide deleted successfully
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md mb-6">
              {deleteData.message}
            </p>
            
            <div className="grid grid-cols-2 gap-4 w-full max-w-md">
              <Card className="p-4 text-center">
                <div className="flex items-center justify-center gap-2 mb-2">
                  <Hash className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Deleted Slide</span>
                </div>
                <p className="text-lg font-semibold text-red-600 dark:text-red-400">
                  #{deleteData.deleted_slide}
                </p>
              </Card>
              
              <Card className="p-4 text-center">
                <div className="flex items-center justify-center gap-2 mb-2">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Remaining</span>
                </div>
                <p className="text-lg font-semibold text-zinc-700 dark:text-zinc-300">
                  {deleteData.remaining_slides}
                </p>
              </Card>
            </div>
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
