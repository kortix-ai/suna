'use client';

import React from 'react';
import {
  Trash2,
  CheckCircle,
  AlertTriangle,
  FileText,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LoadingState } from '../shared/LoadingState';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  extractDocsData,
  extractParametersFromAssistant,
} from './_utils';

export function DeleteDocumentToolView({
  name = 'delete_document',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
}: ToolViewProps) {
  const data = extractDocsData(toolContent);
  const assistantParams = extractParametersFromAssistant(assistantContent);

  if (isStreaming || !data) {
    return <LoadingState title="Deleting Document..." />;
  }
  
  const getStatusIcon = () => {
    if (!data || !data.success || data.error) {
      return <AlertTriangle className="w-2 h-2 text-rose-500" />;
    }
    return <CheckCircle className="w-2 h-2 text-emerald-500" />;
  };

  // Extract document info from assistant params if available
  const docId = assistantParams?.doc_id;
  
  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-rose-500/20 to-orange-600/10 border border-rose-500/20">
              <Trash2 className="w-5 h-5 text-rose-500 dark:text-rose-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                Delete Document
              </CardTitle>
            </div>
          </div>
          
          <Badge
            variant="secondary"
            className={cn(
              data && data.success && !data.error
                ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
            )}
          >
            {getStatusIcon()}
            {data && data.success && !data.error ? 'Deleted' : 'Failed'}
          </Badge>
        </div>
      </CardHeader>
      
      <CardContent className="p-4 space-y-4">
        {data.error ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {data.error}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {data.success && data.message && (
              <Alert className="border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-900/20">
                <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <AlertDescription className="text-emerald-800 dark:text-emerald-200">
                  {data.message}
                </AlertDescription>
              </Alert>
            )}
            
            {docId && (
              <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
                <div className="p-2 rounded-lg bg-background">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="flex-1">
                  <p className="text-sm text-muted-foreground">Document ID</p>
                  <p className="text-sm font-mono">{docId}</p>
                </div>
              </div>
            )}
            
            <div className="pt-2 border-t">
              <p className="text-xs text-muted-foreground">
                This document has been permanently removed from the workspace.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
} 