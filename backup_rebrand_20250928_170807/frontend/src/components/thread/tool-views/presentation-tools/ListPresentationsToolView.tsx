import React from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Presentation,
  Folder,
  Clock,
  CheckCircle,
  AlertTriangle,
  FileText,
  Calendar,
  FolderOpen,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, extractToolData } from '../utils';
import { LoadingState } from '../shared/LoadingState';

interface PresentationInfo {
  folder: string;
  title: string;
  description: string;
  total_slides: number;
  created_at: string;
  updated_at: string;
}

interface ListPresentationsData {
  message: string;
  presentations: PresentationInfo[];
  presentations_directory: string;
}

export function ListPresentationsToolView({
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
  
  let presentationsData: ListPresentationsData | null = null;
  let error: string | null = null;

  try {
    if (toolResult && toolResult.toolOutput && toolResult.toolOutput !== 'STREAMING') {
      const output = toolResult.toolOutput;
      if (typeof output === 'string') {
        try {
          presentationsData = JSON.parse(output);
        } catch (e) {
          console.error('Failed to parse tool output:', e);
          error = 'Failed to parse presentations data';
        }
      } else {
        presentationsData = output as unknown as ListPresentationsData;
      }
    }
  } catch (e) {
    console.error('Error parsing presentations data:', e);
    error = 'Failed to parse presentations data';
  }

  const formatDate = (dateString: string) => {
    try {
      return new Date(dateString).toLocaleDateString();
    } catch {
      return 'Unknown';
    }
  };

  const formatDateTime = (dateString: string) => {
    try {
      return new Date(dateString).toLocaleString();
    } catch {
      return 'Unknown';
    }
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20">
              <FolderOpen className="w-5 h-5 text-blue-500 dark:text-blue-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                All Presentations
              </CardTitle>
              {presentationsData && (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {presentationsData.presentations.length} presentations found
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!isStreaming && !error && presentationsData && (
              <Badge
                variant="secondary"
                className="bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
              >
                <CheckCircle className="h-3.5 w-3.5 mr-1" />
                {presentationsData.presentations.length} found
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
            icon={FolderOpen}
            iconColor="text-blue-500 dark:text-blue-400"
            bgColor="bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
            title="Loading presentations"
            filePath="Scanning workspace..."
            showProgress={true}
          />
        ) : error || !presentationsData ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-rose-100 to-rose-50 shadow-inner dark:from-rose-800/40 dark:to-rose-900/60">
              <AlertTriangle className="h-10 w-10 text-rose-400 dark:text-rose-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              {error || 'Failed to load presentations'}
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md">
              There was an error loading the presentations. Please try again.
            </p>
          </div>
        ) : presentationsData.presentations.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60">
              <Presentation className="h-10 w-10 text-blue-400 dark:text-blue-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No presentations found
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-md">
              You haven't created any presentations yet. Use the create_slide tool to start building your first presentation.
            </p>
          </div>
        ) : (
          <div className="h-full flex flex-col">
            {/* Directory Info Header */}
            <div className="px-4 py-3 border-b bg-muted/30">
              <div className="flex items-center gap-2">
                <Folder className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  {presentationsData.presentations_directory}
                </span>
              </div>
            </div>

            {/* Presentations List */}
            <ScrollArea className="flex-1">
              <div className="p-4 space-y-4">
                {presentationsData.presentations.map((presentation) => (
                  <Card key={presentation.folder} className="p-6 hover:shadow-md transition-shadow">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-4 flex-1">
                        <div className="flex items-center justify-center w-12 h-12 rounded-lg bg-blue-100 dark:bg-blue-900/20 flex-shrink-0">
                          <Presentation className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                        </div>
                        
                        <div className="flex-1 min-w-0">
                          <h4 className="font-semibold text-lg text-zinc-900 dark:text-zinc-100 mb-1">
                            {presentation.title}
                          </h4>
                          
                          {presentation.description && (
                            <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3 line-clamp-2">
                              {presentation.description}
                            </p>
                          )}
                          
                          <div className="flex items-center gap-4 text-sm text-zinc-500 dark:text-zinc-400">
                            <div className="flex items-center gap-1">
                              <FileText className="h-3 w-3" />
                              <span className="font-medium">{presentation.folder}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <Presentation className="h-3 w-3" />
                              {presentation.total_slides} slides
                            </div>
                            <div className="flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              Created {formatDate(presentation.created_at)}
                            </div>
                          </div>
                          
                          {presentation.updated_at !== presentation.created_at && (
                            <div className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                              Last updated: {formatDateTime(presentation.updated_at)}
                            </div>
                          )}
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-2 ml-4">
                        <Badge 
                          variant="outline" 
                          className={`h-6 py-0.5 ${
                            presentation.total_slides > 0 
                              ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
                              : 'bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800'
                          }`}
                        >
                          {presentation.total_slides > 0 ? 'Ready' : 'Empty'}
                        </Badge>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </ScrollArea>
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
