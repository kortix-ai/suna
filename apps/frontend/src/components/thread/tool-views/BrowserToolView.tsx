import React, { useState } from 'react';
import Image from 'next/image';
import {
  Globe,
  MonitorPlay,
  ExternalLink,
  CheckCircle,
  AlertTriangle,
  RefreshCw,
  Code2,
  ImageIcon,
} from 'lucide-react';
import { ToolViewProps } from './types';
import {
  extractBrowserOperation,
  formatTimestamp,
  getToolTitle,
} from './utils';
import { safeJsonParse } from '@/components/thread/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ImageLoader } from './shared/ImageLoader';
import { JsonViewer } from './shared/JsonViewer';
import { ToolViewIconTitle } from './shared/ToolViewIconTitle';
import { ToolViewFooter } from './shared/ToolViewFooter';
import { KortixComputerHeader } from '../kortix-computer/KortixComputerHeader';
import { useSmoothToolField } from '@/hooks/messages';

interface BrowserHeaderProps {
  isConnected: boolean;
  onRefresh?: () => void;
  viewToggle?: React.ReactNode;
}

export const BrowserHeader: React.FC<BrowserHeaderProps> = ({ isConnected, onRefresh, viewToggle }) => {
  return (
    <KortixComputerHeader
      icon={Globe}
      title="Browser"
      actions={
        <>
          <Badge variant="outline" className="gap-1.5 p-2 rounded-3xl">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500/80 animate-pulse' : 'bg-gray-400'}`}></div>
            <span className="sm:inline">Live Preview</span>
          </Badge>
          {viewToggle}
          {isConnected && onRefresh && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              className="h-7 w-7 p-0 hover:bg-muted rounded-xl"
              title="Refresh browser view"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          )}
        </>
      }
    />
  );
};

export function BrowserToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
  agentStatus = 'idle',
  messages = [],
  currentIndex = 0,
  totalCalls = 1,
  viewToggle,
}: ToolViewProps) {
  // All hooks must be called unconditionally at the top - BEFORE any early returns
  const [showContext, setShowContext] = React.useState(false);
  const isRunning = isStreaming || agentStatus === 'running';
  const [progress, setProgress] = React.useState(100);
  const [isImageLoading, setIsImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  // Prepare raw arguments for hooks - must be done before hooks are called
  const rawArguments = toolCall?.rawArguments || toolCall?.arguments;

  // Apply smooth text streaming for URL/instruction fields - MUST be called unconditionally
  const smoothFields = useSmoothToolField(
    (typeof rawArguments === 'object' && rawArguments) ? rawArguments : {},
    { interval: 50 }
  );
  const smoothUrl = (smoothFields as any).url || (typeof rawArguments === 'object' ? rawArguments?.url : '') || '';
  const smoothInstruction = (smoothFields as any).instruction || (typeof rawArguments === 'object' ? rawArguments?.instruction : '') || '';
  const isUrlAnimating = isStreaming && !toolResult && !!toolCall;
  const isInstructionAnimating = isStreaming && !toolResult && !!toolCall;

  React.useEffect(() => {
    if (isRunning) {
      setProgress(0);
      const timer = setInterval(() => {
        setProgress((prevProgress) => {
          if (prevProgress >= 95) {
            clearInterval(timer);
            return prevProgress;
          }
          return prevProgress + 2;
        });
      }, 500);
      return () => clearInterval(timer);
    } else {
      setProgress(100);
    }
  }, [isRunning]);

  // Use useMemo to compute values that hooks depend on - this ensures hooks are always called
  const computedValues = React.useMemo(() => {
    if (!toolCall) {
      return {
        screenshotUrlFinal: null,
        browserStateMessageId: undefined,
        result: null,
      };
    }

    let browserStateMessageId: string | undefined;
    let screenshotUrlFinal: string | null = null;
    let result: Record<string, any> | null = null;

    if (toolResult?.output) {
      let output = toolResult.output;
      
      if (typeof output === 'string') {
        try {
          const parsed = JSON.parse(output);
          if (typeof parsed === 'object' && parsed !== null) {
            output = parsed;
          } else {
            result = { message: output };
            output = null;
          }
        } catch (e) {
          result = { message: output };
          output = null;
        }
      }
      
      if (output && typeof output === 'object' && output !== null) {
        if (output.image_url) {
          screenshotUrlFinal = String(output.image_url).trim().replace(/\?+$/, '');
        }
        if (output.message_id) {
          browserStateMessageId = String(output.message_id).trim();
        }
        
        result = Object.fromEntries(
          Object.entries(output).filter(([k]) => 
            k !== 'message_id' && 
            k !== 'image_url'
          )
        ) as Record<string, any>;
        
        if (Object.keys(result).length === 0 && output.message) {
          result = { message: output.message };
        }
      }
    }

    // Try to find browser state message if we have a message_id but no screenshot yet
    if (!screenshotUrlFinal && browserStateMessageId && messages && messages.length > 0) {
      const browserStateMessage = messages.find(
        (msg) =>
          (msg.type as string) === 'browser_state' &&
          msg.message_id === browserStateMessageId,
      );

      if (browserStateMessage) {
        const browserStateContent = safeJsonParse<{
          image_url?: string;
        }>(
          browserStateMessage.content,
          {},
        );
        
        if (browserStateContent?.image_url) {
          screenshotUrlFinal = String(browserStateContent.image_url).trim().replace(/\?+$/, '');
        }
      }
    }

    return {
      screenshotUrlFinal,
      browserStateMessageId,
      result,
    };
  }, [toolCall, toolResult?.output, messages]);

  // Log extracted data for debugging
  React.useEffect(() => {
    console.log('[BrowserToolView] Extracted data:', {
      screenshotUrl: computedValues.screenshotUrlFinal,
      browserStateMessageId: computedValues.browserStateMessageId,
      hasResult: !!computedValues.result,
      toolResultOutput: toolResult?.output,
      toolResultOutputType: typeof toolResult?.output,
    });
  }, [computedValues, toolResult?.output]);

  // Reset loading state when screenshot URL changes
  React.useEffect(() => {
    if (computedValues.screenshotUrlFinal) {
      console.log('[BrowserToolView] Screenshot URL:', computedValues.screenshotUrlFinal);
      setIsImageLoading(true);
      setImageError(false);
    }
  }, [computedValues.screenshotUrlFinal]);

  // Defensive check - handle cases where toolCall might be undefined
  if (!toolCall) {
    console.warn('BrowserToolView: toolCall is undefined. Tool views should use structured props.');
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const operation = extractBrowserOperation(name);
  const toolTitle = getToolTitle(name);

  // Extract data directly from structured props
  const url = toolCall.arguments?.url || toolCall.arguments?.target_url || null;
  const parameters = toolCall.arguments || null;

  // Use smooth URL/instruction when streaming
  const displayUrl = isStreaming && smoothUrl ? smoothUrl : url;
  const displayInstruction = isStreaming && smoothInstruction ? smoothInstruction : parameters?.instruction;

  // Use computed values from useMemo
  const screenshotUrlFinal = computedValues.screenshotUrlFinal;
  const browserStateMessageId = computedValues.browserStateMessageId;
  const result = computedValues.result;

  const renderScreenshot = () => {
    if (!screenshotUrlFinal) {
      return null;
    }

    return (
      <div className="flex items-center justify-center w-full h-full min-h-[600px] relative p-4" style={{ minHeight: '600px' }}>
        {isImageLoading && !imageError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-50 dark:bg-zinc-900">
            <ImageLoader />
          </div>
        )}
        {imageError ? (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-50 dark:bg-zinc-900">
            <div className="text-center text-zinc-500 dark:text-zinc-400">
              <AlertTriangle className="h-8 w-8 mx-auto mb-2" />
              <p className="font-medium mb-1">Failed to load screenshot</p>
              <p className="text-xs text-zinc-400 dark:text-zinc-500 max-w-md break-all px-4">
                {screenshotUrlFinal}
              </p>
            </div>
          </div>
        ) : (
          <Card className="p-0 overflow-hidden relative border">
            <Image
              src={screenshotUrlFinal}
              alt="Browser Screenshot"
              className="max-w-full max-h-full object-contain"
              width={1920}
              height={1080}
              unoptimized
              priority
              onLoadingComplete={() => setIsImageLoading(false)}
              onError={() => {
                setIsImageLoading(false);
                setImageError(true);
              }}
            />
          </Card>
        )}
      </div>
    );
  };

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-scroll bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle icon={MonitorPlay} title={toolTitle} />
          <div className='flex items-center gap-2'>
            {viewToggle}
            {(result || parameters) && <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowContext(!showContext)}
              className="h-7 w-7 hover:bg-muted rounded-xl"
              title={showContext ? "Show screenshot" : "Show INPUT/OUTPUT context"}
            >
              {showContext ? (
                <ImageIcon className="h-3.5 w-3.5" />
              ) : (
                <Code2 className="h-3.5 w-3.5" />
              )}
            </Button>}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0 flex-1 overflow-hidden relative" style={{ height: 'calc(100vh - 150px)'}}>
        <div className="flex-1 flex h-full items-center overflow-scroll bg-white dark:bg-black">
          {showContext && (result || parameters) ? (
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {parameters && <JsonViewer
                data={parameters}
                title="INPUT"
                defaultExpanded={true}
              />}
              {result && <JsonViewer
                data={result}
                title="OUTPUT"
                defaultExpanded={true}
              />}
            </div>
          )
          : screenshotUrlFinal ? (
            renderScreenshot()
          ) : (
            <div className="p-8 flex flex-col items-center justify-center w-full bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900 text-zinc-700 dark:text-zinc-400 min-h-600">
              <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60">
                <MonitorPlay className="h-10 w-10 text-zinc-500 dark:text-zinc-400" />
              </div>
              <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
                {isRunning ? 'Browser action in progress' : 'Browser action completed'}
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4 text-center">
                {isRunning 
                  ? 'Browser action in progress...'
                  : 'Screenshot will appear here when available.'}
              </p>
              {(displayUrl || url) && (
                <div className="mt-4">
                  <div className="mb-2">
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 font-mono break-all">
                      {displayUrl || url}
                      {isUrlAnimating && <span className="animate-pulse text-muted-foreground ml-1">▌</span>}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 shadow-sm hover:shadow-md transition-shadow"
                    asChild
                  >
                    <a href={displayUrl || url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-3.5 w-3.5 mr-2" />
                      Visit URL
                    </a>
                  </Button>
                </div>
              )}
              {displayInstruction && (
                <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <span className="font-medium">Instruction: </span>
                  <span className="font-mono">{displayInstruction}</span>
                  {isInstructionAnimating && <span className="animate-pulse text-muted-foreground ml-1">▌</span>}
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>

      <div className="px-4 py-2 h-10 bg-gradient-to-r from-zinc-50/90 to-zinc-100/90 dark:from-zinc-900/90 dark:to-zinc-800/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          {!isRunning && (
            <Badge className="h-6 py-0.5">
              <Globe className="h-3 w-3" />
              {operation}
            </Badge>
          )}
          {(displayUrl || url) && (
            <span className="text-xs truncate max-w-[200px] hidden sm:inline-block">
              {displayUrl || url}
              {isUrlAnimating && <span className="animate-pulse text-muted-foreground ml-1">▌</span>}
            </span>
          )}
        </div>

        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {toolTimestamp && !isRunning
            ? formatTimestamp(toolTimestamp)
            : assistantTimestamp
              ? formatTimestamp(assistantTimestamp)
              : ''}
        </div>
      </div>
    </Card>
  );
}