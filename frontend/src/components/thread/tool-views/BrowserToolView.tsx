import React, { useMemo } from 'react';
import Image from 'next/image';
import {
  Globe,
  MonitorPlay,
  ExternalLink,
  CheckCircle,
  AlertTriangle,
  CircleDashed,
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
import { ParsedContent } from '../types';
import { JsonViewer } from './shared/JsonViewer';
import { KortixComputerHeader } from '../kortix-computer/KortixComputerHeader';

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
  // All hooks must be called unconditionally at the top
  const [showContext, setShowContext] = React.useState(false);
  // Add loading states for images
  const [imageLoading, setImageLoading] = React.useState(true);
  const [imageError, setImageError] = React.useState(false);
  const isRunning = isStreaming || agentStatus === 'running';

  const [progress, setProgress] = React.useState(100);

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

  // Reset loading state when screenshot changes (use optional chaining for safety)
  const screenshotUrl = toolResult?.output?.image_url || null;
  const screenshotBase64 = toolResult?.output?.screenshot_base64 || null;
  React.useEffect(() => {
    if (screenshotUrl || screenshotBase64) {
      setImageLoading(true);
      setImageError(false);
    }
  }, [screenshotUrl, screenshotBase64]);

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

  // Extract result data from toolResult
  let browserStateMessageId: string | undefined;
  let screenshotUrlFinal: string | null = screenshotUrl;
  let screenshotBase64Final: string | null = screenshotBase64;
  let result: Record<string, any> | null = null;

  if (toolResult?.output) {
    const output = toolResult.output;
    
    if (typeof output === 'object' && output !== null) {
      // Extract screenshot URL and message ID from output
      if (output.image_url) {
        screenshotUrlFinal = output.image_url;
      }
      if (output.message_id) {
        browserStateMessageId = output.message_id;
      }
      
      // Set result, excluding message_id
      result = Object.fromEntries(
        Object.entries(output).filter(([k]) => k !== 'message_id')
      ) as Record<string, any>;
    } else if (typeof output === 'string') {
      result = { message: output };
    }
  }

  // Try to find browser state message if we have a message_id
  if (!screenshotUrlFinal && !screenshotBase64Final && browserStateMessageId && messages.length > 0) {
    const browserStateMessage = messages.find(
      (msg) =>
        (msg.type as string) === 'browser_state' &&
        msg.message_id === browserStateMessageId,
    );

    if (browserStateMessage) {
      const browserStateContent = safeJsonParse<{
        screenshot_base64?: string;
        image_url?: string;
      }>(
        browserStateMessage.content,
        {},
      );
      screenshotBase64Final = browserStateContent?.screenshot_base64 || null;
      screenshotUrlFinal = browserStateContent?.image_url || null;
    }
  }

  const handleImageLoad = () => {
    setImageLoading(false);
    setImageError(false);
  };

  const handleImageError = () => {
    setImageLoading(false);
    setImageError(true);
  };

  const renderScreenshot = () => {

    if (screenshotUrlFinal) {
      return (
        <div className="flex items-center justify-center w-full h-full min-h-[600px] relative p-4" style={{ minHeight: '600px' }}>
          {imageLoading && (
            <ImageLoader />
          )}
          <Card className={`p-0 overflow-hidden relative border ${imageLoading ? 'hidden' : 'block'}`}>
            <Image
              src={screenshotUrlFinal}
              alt="Browser Screenshot"
              className="max-w-full max-h-full object-contain"
              onLoad={handleImageLoad}
              onError={handleImageError}
              width={1920}
              height={1080}
              unoptimized
            />
          </Card>
          {imageError && !imageLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-50 dark:bg-zinc-900">
              <div className="text-center text-zinc-500 dark:text-zinc-400">
                <AlertTriangle className="h-8 w-8 mx-auto mb-2" />
                <p>Failed to load screenshot</p>
              </div>
            </div>
          )}
        </div>
      );
    } else if (screenshotBase64Final) {
      return (
        <div className="flex items-center justify-center w-full h-full min-h-[600px] relative p-4" style={{ minHeight: '600px' }}>
          {imageLoading && (
            <ImageLoader />
          )}
          <Card className={`overflow-hidden border ${imageLoading ? 'hidden' : 'block'}`}>
            <Image
              src={`data:image/jpeg;base64,${screenshotBase64Final}`}
              alt="Browser Screenshot"
              className="max-w-full max-h-full object-contain"
              onLoad={handleImageLoad}
              onError={handleImageError}
              width={1920}
              height={1080}
              unoptimized
            />
          </Card>
          {imageError && !imageLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-50 dark:bg-zinc-900">
              <div className="text-center text-zinc-500 dark:text-zinc-400">
                <AlertTriangle className="h-8 w-8 mx-auto mb-2" />
                <p>Failed to load screenshot</p>
              </div>
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-scroll bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-purple-500/20 to-purple-600/10 border border-purple-500/20">
              <MonitorPlay className="w-5 h-5 text-purple-500 dark:text-purple-400" />
            </div>
            <div className='flex items-center gap-2'>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
            </div>
          </div>

          <div className='flex items-center gap-2'>
            {!isRunning && (
              <Badge
              variant="secondary"
              className={
                isSuccess
                ? "bg-gradient-to-b from-emerald-200 to-emerald-100 text-emerald-700 dark:from-emerald-800/50 dark:to-emerald-900/60 dark:text-emerald-300"
                : "bg-gradient-to-b from-rose-200 to-rose-100 text-rose-700 dark:from-rose-800/50 dark:to-rose-900/60 dark:text-rose-300"
              }
              >
                {isSuccess ? (
                  <CheckCircle className="h-3.5 w-3.5 mr-1" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                )}
                {isSuccess ? 'Browser action completed' : 'Browser action failed'}
              </Badge>
            )}
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
          :(screenshotUrlFinal || screenshotBase64Final) ? (
            renderScreenshot()
          ) : (
            <div className="p-8 flex flex-col items-center justify-center w-full bg-gradient-to-b from-white to-zinc-50 dark:from-zinc-950 dark:to-zinc-900 text-zinc-700 dark:text-zinc-400 min-h-600">
              <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-gradient-to-b from-purple-100 to-purple-50 shadow-inner dark:from-purple-800/40 dark:to-purple-900/60">
                <MonitorPlay className="h-10 w-10 text-purple-400 dark:text-purple-600" />
              </div>
              <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
                {isRunning ? 'Browser action in progress' : 'Browser action completed'}
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4 text-center">
                {isRunning 
                  ? 'Switch to the Browser tab to see the live browser view.'
                  : 'Screenshot will appear here when available.'}
              </p>
              {url && (
                <div className="mt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    className="bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 shadow-sm hover:shadow-md transition-shadow"
                    asChild
                  >
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-3.5 w-3.5 mr-2" />
                      Visit URL
                    </a>
                  </Button>
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
          {url && (
            <span className="text-xs truncate max-w-[200px] hidden sm:inline-block">
              {url}
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