import React from 'react';
import {
  Shield,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  Image as ImageIcon,
  Music,
  Video,
  File,
  Info,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { extractRealityDefenderData } from './_utils';

export function RealityDefenderToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const {
    filePath,
    mediaType,
    isDeepfake,
    confidence,
    verdict,
    indicators,
    analysisId,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp,
  } = extractRealityDefenderData(
    toolCall,
    toolResult,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const name = toolCall?.function_name?.replace(/_/g, '-').toLowerCase() || 'detect-deepfake';
  const toolTitle = getToolTitle(name);

  const getMediaIcon = () => {
    switch (mediaType) {
      case 'image':
        return ImageIcon;
      case 'audio':
        return Music;
      case 'video':
        return Video;
      default:
        return File;
    }
  };

  const getMediaTypeLabel = () => {
    switch (mediaType) {
      case 'image':
        return 'Image';
      case 'audio':
        return 'Audio';
      case 'video':
        return 'Video';
      default:
        return 'Media';
    }
  };

  const getVerdictInfo = () => {
    if (verdict === 'likely_manipulated' || isDeepfake) {
      return {
        label: 'Likely Manipulated',
        icon: AlertTriangle,
        color: 'text-zinc-600 dark:text-zinc-400',
      };
    } else if (verdict === 'likely_authentic') {
      return {
        label: 'Likely Authentic',
        icon: CheckCircle2,
        color: 'text-zinc-600 dark:text-zinc-400',
      };
    } else {
      return {
        label: 'Uncertain',
        icon: HelpCircle,
        color: 'text-zinc-600 dark:text-zinc-400',
      };
    }
  };

  const verdictInfo = getVerdictInfo();
  const MediaIcon = getMediaIcon();
  const VerdictIcon = verdictInfo.icon;

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-lg border shrink-0 bg-zinc-200/60 dark:bg-zinc-900 border-zinc-300 dark:border-zinc-700">
              <Shield className="w-5 h-5 text-zinc-500 dark:text-zinc-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
            </div>
          </div>

        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming && !filePath ? (
          <LoadingState
            icon={Shield}
            iconColor="text-zinc-500 dark:text-zinc-400"
            bgColor="bg-linear-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
            title="Analyzing media file"
            filePath=""
            showProgress={true}
          />
        ) : actualIsSuccess && filePath ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 py-0 my-4">
              {/* File Info */}
              <div className="mb-6">
                <div className="flex items-center gap-3 mb-2">
                  <div className="p-2 rounded-lg bg-zinc-100 dark:bg-zinc-800">
                    <MediaIcon className="w-5 h-5 text-zinc-600 dark:text-zinc-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {filePath.split('/').pop() || filePath}
                    </p>
                    <Badge variant="outline" className="text-xs mt-1">
                      {getMediaTypeLabel()}
                    </Badge>
                  </div>
                </div>
              </div>

              {/* Verdict */}
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                  <VerdictIcon className={`w-5 h-5 ${verdictInfo.color}`} />
                  <h3 className="text-sm font-medium text-foreground">Detection Result</h3>
                </div>
                <div className="rounded-lg p-4 border border-border bg-card">
                  <div className="flex items-center justify-between mb-2">
                    <span className={`font-semibold ${verdictInfo.color}`}>{verdictInfo.label}</span>
                    <span className="text-sm text-muted-foreground">
                      {(confidence * 100).toFixed(1)}% confidence
                    </span>
                  </div>
                  <Progress 
                    value={confidence * 100} 
                    className="h-2 mt-2"
                  />
                </div>
              </div>

              {/* Indicators */}
              {indicators.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-sm font-medium text-foreground mb-3 flex items-center">
                    <Info className="h-4 w-4 mr-2 opacity-70" />
                    Detection Indicators ({indicators.length})
                  </h3>
                  <div className="space-y-2">
                    {indicators.map((indicator, idx) => (
                      <div
                        key={idx}
                        className="bg-card border border-border rounded-lg p-3 hover:border-border/80 transition-colors"
                      >
                        <div className="flex items-start justify-between mb-1">
                          <span className="text-sm font-medium text-foreground">
                            {indicator.name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                          </span>
                          <Badge variant="outline" className="text-xs">
                            {(indicator.score * 100).toFixed(0)}%
                          </Badge>
                        </div>
                        {indicator.description && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {indicator.description}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Analysis ID */}
              {analysisId && (
                <div className="text-xs text-muted-foreground">
                  Analysis ID: {analysisId}
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-linear-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-linear-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60">
              <Shield className="h-10 w-10 text-zinc-400 dark:text-zinc-600" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              {actualIsSuccess ? 'No Analysis Results' : 'Analysis Failed'}
            </h3>
            {filePath && (
              <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 w-full max-w-md text-center mb-4 shadow-sm">
                <code className="text-sm font-mono text-zinc-700 dark:text-zinc-300 break-all">
                  {filePath}
                </code>
              </div>
            )}
            <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center max-w-sm">
              {actualIsSuccess
                ? 'No detection results available for this file'
                : 'Failed to analyze the media file. Please check the file format and try again.'}
            </p>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 h-10 bg-linear-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          {!isStreaming && actualIsSuccess && verdict && (
            <Badge variant="outline" className="h-6 py-0.5">
              <VerdictIcon className="h-3 w-3 mr-1" />
              {verdictInfo.label}
            </Badge>
          )}
        </div>

        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {actualToolTimestamp && !isStreaming
            ? formatTimestamp(actualToolTimestamp)
            : actualAssistantTimestamp
              ? formatTimestamp(actualAssistantTimestamp)
              : ''}
        </div>
      </div>
    </Card>
  );
}
