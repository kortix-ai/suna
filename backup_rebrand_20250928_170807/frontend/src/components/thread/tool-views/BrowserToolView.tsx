import React, { useMemo } from 'react';
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
  extractBrowserUrl,
  extractBrowserOperation,
  formatTimestamp,
  getToolTitle,
  extractToolData,
} from './utils';
import { safeJsonParse } from '@/components/thread/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ImageLoader } from './shared/ImageLoader';
import { ParsedContent } from '../types';
import { JsonViewer } from './shared/JsonViewer';

interface BrowserHeaderProps {
  isConnected: boolean;
  onRefresh?: () => void;
  viewToggle?: React.ReactNode;
}

export const BrowserHeader: React.FC<BrowserHeaderProps> = ({ isConnected, onRefresh, viewToggle }) => {
  return (
    <div className={`flex items-center justify-between px-3 md:px-4 py-2 border border-border ${!isConnected ? 'bg-muted/30 border-b' : ''}`}>
      <div className="flex items-center gap-2 justify-between min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="relative p-2 rounded-xl bg-gradient-to-br from-purple-500/20 to-purple-600/10 border border-purple-500/20">
            <Globe className="w-5 h-5 text-purple-500 dark:text-purple-400" />
          </div>
          <div>
            <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
              Browser
            </CardTitle>
          </div>
        </div>
        <div className='flex items-center gap-1'>
        <Badge variant="outline" className="gap-1.5 p-2 rounded-3xl mr-2">
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
        </div>
      </div>
    </div>
  );
};

export function BrowserToolView({
  name = 'browser-operation',
  assistantContent,
  toolContent,
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
  // Try to extract data using the new parser first
  const assistantToolData = extractToolData(assistantContent);
  const toolToolData = extractToolData(toolContent);

  let url: string | null = null;

  // Use data from the new format if available
  if (assistantToolData.toolResult) {
    url = assistantToolData.url;
  } else if (toolToolData.toolResult) {
    url = toolToolData.url;
  }

  // If not found in new format, fall back to legacy extraction
  if (!url) {
    url = extractBrowserUrl(assistantContent);
  }

  const operation = extractBrowserOperation(name);
  const toolTitle = getToolTitle(name);

  let browserStateMessageId: string | undefined;
  let screenshotUrl: string | null = null;
  let screenshotBase64: string | null = null;
  let result: Record<string, string> | null = null;
  let parameters: Record<string, string> | null = null;
  const [showContext, setShowContext] = React.useState(false);
  // Add loading states for images
  const [imageLoading, setImageLoading] = React.useState(true);
  const [imageError, setImageError] = React.useState(false);

  try {
    const topLevelParsed = safeJsonParse<{ content?: any }>(toolContent, {});
    const innerContentString = topLevelParsed?.content || toolContent;
    if (innerContentString && typeof innerContentString === 'string') {
      const toolResultMatch = innerContentString.match(/ToolResult\([^)]*output='([\s\S]*?)'(?:\s*,|\s*\))/);
      if (toolResultMatch) {
        const outputString = toolResultMatch[1];
        try {
          const cleanedOutput = outputString.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\u([0-9a-fA-F]{4})/g, (_match, grp) => String.fromCharCode(parseInt(grp, 16)));
          const outputJson = JSON.parse(cleanedOutput);

          if (outputJson.image_url) {
            screenshotUrl = outputJson.image_url;
          }
          if (outputJson.message_id) {
            browserStateMessageId = outputJson.message_id;
          }
        } catch (parseError) {
        }
      }

      if (!screenshotUrl) {
        const imageUrlMatch = innerContentString.match(/"image_url":\s*"([^"]+)"/);
        if (imageUrlMatch) {
          screenshotUrl = imageUrlMatch[1];
        }
      }

      if (!browserStateMessageId) {
        const messageIdMatch = innerContentString.match(/"message_id":\s*"([^"]+)"/);
        if (messageIdMatch) {
          browserStateMessageId = messageIdMatch[1];
        }
      }

      if (!browserStateMessageId && !screenshotUrl) {
        const outputMatch = innerContentString.match(/\boutput='(.*?)'(?=\s*\))/);
        const outputString = outputMatch ? outputMatch[1] : null;

        if (outputString) {
          const unescapedOutput = outputString
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"');

          const finalParsedOutput = safeJsonParse<{ message_id?: string; image_url?: string }>(
            unescapedOutput,
            {},
          );
          browserStateMessageId = finalParsedOutput?.message_id;
          screenshotUrl = finalParsedOutput?.image_url || null;
        }
      }
    } else if (innerContentString && typeof innerContentString === "object") {
      screenshotUrl = (() => {
        if (!innerContentString) return null;
        if (!("tool_execution" in innerContentString)) return null;
        if (!("result" in innerContentString.tool_execution)) return null;
        if (!("output" in innerContentString.tool_execution.result)) return null;
        if (!("image_url" in innerContentString.tool_execution.result.output)) return null;
        if (typeof innerContentString.tool_execution.result.output.image_url !== "string") return null;
        return innerContentString.tool_execution.result.output.image_url;
      })()
    }

  } catch (error) {
  }

  if (!screenshotUrl && !screenshotBase64 && browserStateMessageId && messages.length > 0) {
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
      screenshotBase64 = browserStateContent?.screenshot_base64 || null;
      screenshotUrl = browserStateContent?.image_url || null;
    }
  }

  if ((!result || !parameters) && messages.length > 0 && browserStateMessageId) {

    // Process browser state messages
    const latestBrowserStateMessage = messages.filter(
      (msg) => msg.type === 'browser_state' && msg.message_id === browserStateMessageId
    );

    for (const msg of latestBrowserStateMessage) {
      const content = safeJsonParse<ParsedContent>(msg.content, {});
      if (content) {
        result = Object.fromEntries(Object.entries(content).filter(([k, v]) => k !== 'input'));
      }
      if (content.input) {
        parameters = content.input;
      }
    }
  }
  if (!result || !parameters) {
    const browserToolMessages = messages.filter(
      m => m.type === 'tool' &&
      safeJsonParse<ParsedContent>(m.content, {})?.tool_execution?.function_name?.startsWith('browser')
    );

    let matchingToolMessage = null;
    const currentToolTimestamp = toolTimestamp;
    
    // First try to find exact match by timestamp correlation
    if (currentToolTimestamp) {
      matchingToolMessage = browserToolMessages.find((msg) => {
        const msgTime = new Date(msg.created_at).getTime();
        const toolTime = new Date(currentToolTimestamp).getTime();
        return msgTime === toolTime;
      });
    }
    
    if (matchingToolMessage) {
      const toolContent = safeJsonParse<ParsedContent>(matchingToolMessage.content, {});
        if (toolContent?.tool_execution?.result?.output) {
          // result = toolContent.tool_execution.result.output;
          // Handle if output is a string or object
          const output = toolContent.tool_execution.result.output;
          if (typeof output === 'string') {
            result = { message: output };
          } else if (output && typeof output === 'object') {
            result = Object.fromEntries(Object.entries(output).filter(([k, v]) => k !== 'message_id')) as Record<string, string>;
          } else {
            result = {};
          }
        }
        if (toolContent?.tool_execution?.arguments) {
          parameters = toolContent.tool_execution.arguments;
        }
    }
  }
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

  // Reset loading state when screenshot changes
  React.useEffect(() => {
    if (screenshotUrl || screenshotBase64) {
      setImageLoading(true);
      setImageError(false);
    }
  }, [screenshotUrl, screenshotBase64]);

  const handleImageLoad = () => {
    setImageLoading(false);
    setImageError(false);
  };

  const handleImageError = () => {
    setImageLoading(false);
    setImageError(true);
  };

  const renderScreenshot = () => {

    if (screenshotUrl) {
      return (
        <div className="flex items-center justify-center w-full h-full min-h-[600px] relative p-4" style={{ minHeight: '600px' }}>
          {imageLoading && (
            <ImageLoader />
          )}
          <Card className={`p-0 overflow-hidden relative border ${imageLoading ? 'hidden' : 'block'}`}>
            <img
              src={screenshotUrl}
              alt="Browser Screenshot"
              className="max-w-full max-h-full object-contain"
              onLoad={handleImageLoad}
              onError={handleImageError}
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
    } else if (screenshotBase64) {
      return (
        <div className="flex items-center justify-center w-full h-full min-h-[600px] relative p-4" style={{ minHeight: '600px' }}>
          {imageLoading && (
            <ImageLoader />
          )}
          <Card className={`overflow-hidden border ${imageLoading ? 'hidden' : 'block'}`}>
            <img
              src={`data:image/jpeg;base64,${screenshotBase64}`}
              alt="Browser Screenshot"
              className="max-w-full max-h-full object-contain"
              onLoad={handleImageLoad}
              onError={handleImageError}
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
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-scroll bg-card">
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
          :(screenshotUrl || screenshotBase64) ? (
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