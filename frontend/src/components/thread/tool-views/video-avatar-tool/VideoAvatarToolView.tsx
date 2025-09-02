import React, { useState, useMemo } from 'react';
import { ToolViewProps } from '../types';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  CheckCircle, 
  AlertTriangle, 
  Download, 
  Play, 
  Video, 
  Clock, 
  User, 
  Mic, 
  FileVideo,
  Loader2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseToolResult } from '../tool-result-parser';
import { useAuth } from '@/components/AuthProvider';
import { toast } from 'sonner';

function getVideoUrl(sandboxId: string | undefined, path: string): string {
  if (!sandboxId) return path;
  if (!path.startsWith('/workspace')) {
    path = `/workspace/${path.startsWith('/') ? path.substring(1) : path}`;
  }
  try {
    path = path.replace(/\\u([0-9a-fA-F]{4})/g, (_, hexCode) => String.fromCharCode(parseInt(hexCode, 16)));
  } catch {}
  const url = new URL(`${process.env.NEXT_PUBLIC_BACKEND_URL}/sandboxes/${sandboxId}/files/content`);
  url.searchParams.append('path', path);
  return url.toString();
}

function toObject(val: any): any | null {
  if (!val) return null;
  try {
    return typeof val === 'string' ? JSON.parse(val) : val;
  } catch {
    return null;
  }
}

const VideoPlayer: React.FC<{ videoUrl: string; title: string; className?: string }> = ({ 
  videoUrl, 
  title, 
  className 
}) => {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  const handleLoadStart = () => {
    setIsLoading(true);
    setHasError(false);
  };

  const handleCanPlay = () => {
    setIsLoading(false);
  };

  const handleError = () => {
    setIsLoading(false);
    setHasError(true);
  };

  if (hasError) {
    return (
      <div className="flex flex-col items-center justify-center w-full h-64 bg-gradient-to-b from-red-50 to-red-100 dark:from-red-950/30 dark:to-red-900/20 rounded-lg border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300">
        <AlertTriangle className="h-8 w-8 mb-2" />
        <p className="text-sm font-medium">Unable to load video</p>
        <p className="text-xs text-red-600/70 dark:text-red-400/70 mt-1">
          {title}
        </p>
      </div>
    );
  }

  return (
    <div className={cn("relative w-full", className)}>
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100 dark:bg-gray-800 rounded-lg">
          <div className="flex flex-col items-center">
            <Loader2 className="h-8 w-8 animate-spin text-violet-600 mb-2" />
            <p className="text-sm text-muted-foreground">Loading video...</p>
          </div>
        </div>
      )}
      <video
        controls
        className="w-full h-auto rounded-lg shadow-sm"
        preload="metadata"
        onLoadStart={handleLoadStart}
        onCanPlay={handleCanPlay}
        onError={handleError}
        style={{ display: isLoading ? 'none' : 'block' }}
      >
        <source src={videoUrl} type="video/mp4" />
        Your browser does not support the video element.
      </video>
    </div>
  );
};

export function VideoAvatarToolView({
  name = 'generate_avatar_video',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
}: ToolViewProps) {
  
  const { session } = useAuth();
  const [isDownloading, setIsDownloading] = useState(false);

  const parsedResult = useMemo(() => {
    return parseToolResult(toolContent);
  }, [toolContent]);

  // Extract video information from the tool result
  const videoData = useMemo(() => {
    if (!parsedResult || !isSuccess) return null;

    const content = parsedResult.toolOutput || '';
    
    // Look for video file information in the content - support multiple formats
    const videoFileMatch = content.match(/(?:Video saved as:?\s*|File:\s*`?)([^\s\n`]+\.mp4)/i);
    const videoIdMatch = content.match(/Video ID:?\s*`?([a-f0-9-]+)`?/i);
    const titleMatch = content.match(/Title:?\s*([^\n]+)/i);
    const avatarMatch = content.match(/Avatar:?\s*([^\n]+)/i);
    const textMatch = content.match(/Text:?\s*"?([^\n"]+)"?/i);

    return {
      video_file: videoFileMatch?.[1],
      video_id: videoIdMatch?.[1],
      title: titleMatch?.[1]?.trim(),
      avatar_info: avatarMatch?.[1]?.trim(),
      text_content: textMatch?.[1]?.trim(),
      full_content: content
    };
  }, [parsedResult, isSuccess]);

  // Create video URL for streaming
  const videoUrl = useMemo(() => {
    if (!videoData?.video_file || !project?.sandbox?.id) return null;
    return getVideoUrl(project.sandbox.id, videoData.video_file);
  }, [videoData?.video_file, project?.sandbox?.id]);

  const handleDownload = async () => {
    if (!videoData?.video_file || !project?.sandbox?.id || isDownloading) return;

    try {
      setIsDownloading(true);

      const videoUrl = getVideoUrl(project.sandbox.id, videoData.video_file);
      
      // Fetch the video file
      const response = await fetch(videoUrl, {
        headers: session?.access_token ? {
          'Authorization': `Bearer ${session.access_token}`
        } : {}
      });

      if (!response.ok) {
        throw new Error(`Failed to download video: ${response.statusText}`);
      }

      const blob = await response.blob();
      const fileName = videoData.title 
        ? `${videoData.title.replace(/[^\w\s-]/g, '_')}.mp4`
        : videoData.video_file || 'avatar_video.mp4';

      // Download the file
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(downloadUrl);

      toast.success(`Downloaded: ${fileName}`);
    } catch (error) {
      console.error('Download failed:', error);
      toast.error('Failed to download video');
    } finally {
      setIsDownloading(false);
    }
  };

  const getStatusIcon = () => {
    if (isStreaming) {
      return <Clock className="h-4 w-4 text-violet-600 animate-pulse" />;
    }
    return isSuccess ? (
      <CheckCircle className="h-4 w-4 text-green-600" />
    ) : (
      <AlertTriangle className="h-4 w-4 text-red-600" />
    );
  };

  const getStatusColor = () => {
    if (isStreaming) return 'bg-violet-100 text-violet-800 dark:bg-violet-900/20 dark:text-violet-300';
    return isSuccess 
      ? 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-300'
      : 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-300';
  };

  const getStatusText = () => {
    if (isStreaming) return 'Generating...';
    return isSuccess ? 'Success' : 'Failed';
  };

  const isVideoGeneration = name === 'generate_avatar_video';
  const isAvatarSession = name === 'create_avatar_session';
  const isAvatarSpeak = name === 'make_avatar_speak';

  const getToolTitle = () => {
    switch (name) {
      case 'generate_avatar_video': return 'Avatar Video Generation';
      case 'create_avatar_session': return 'Avatar Session Created';
      case 'make_avatar_speak': return 'Avatar Speech';
      case 'check_video_status': return 'Video Status Check';
      case 'list_avatar_options': return 'Available Avatars';
      case 'close_avatar_session': return 'Avatar Session Closed';
      default: return 'Video Avatar Tool';
    }
  };

  const getToolIcon = () => {
    switch (name) {
      case 'generate_avatar_video': return <Video className="h-4 w-4" />;
      case 'create_avatar_session': return <User className="h-4 w-4" />;
      case 'make_avatar_speak': return <Mic className="h-4 w-4" />;
      default: return <FileVideo className="h-4 w-4" />;
    }
  };

  return (
    <Card className="w-full border-l-4 border-l-violet-500 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-violet-100 dark:bg-violet-900/20 flex items-center justify-center">
              {getToolIcon()}
            </div>
            <div>
              <CardTitle className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {getToolTitle()}
              </CardTitle>
              <div className="flex items-center gap-2 mt-1">
                <Badge variant="outline" className={getStatusColor()}>
                  <div className="flex items-center gap-1">
                    {getStatusIcon()}
                    <span className="text-xs font-medium">{getStatusText()}</span>
                  </div>
                </Badge>
                {assistantTimestamp && (
                  <Badge variant="secondary" className="text-xs">
                    {new Date(assistantTimestamp).toLocaleTimeString()}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0 flex-1 overflow-hidden">
        <div className="flex flex-col h-full">
          <div className="flex-1 min-w-0">
            <ScrollArea className="h-full">
              <div className="p-4 flex flex-col space-y-4">
                {/* Video Information */}
                {videoData && (
                  <div className="bg-violet-50 dark:bg-violet-950/20 rounded-lg p-4 border border-violet-200 dark:border-violet-800">
                    <div className="flex items-center gap-2 mb-3">
                      <Video className="h-4 w-4 text-violet-600" />
                      <span className="font-medium text-sm">Video Details</span>
                    </div>
                    <div className="space-y-2 text-sm">
                      {videoData.title && (
                        <div>
                          <span className="font-medium text-muted-foreground">Title:</span>
                          <span className="ml-2">{videoData.title}</span>
                        </div>
                      )}
                      {videoData.avatar_info && (
                        <div>
                          <span className="font-medium text-muted-foreground">Avatar:</span>
                          <span className="ml-2">{videoData.avatar_info}</span>
                        </div>
                      )}
                      {videoData.text_content && (
                        <div>
                          <span className="font-medium text-muted-foreground">Speech:</span>
                          <span className="ml-2 italic">"{videoData.text_content}"</span>
                        </div>
                      )}
                      {videoData.video_id && (
                        <div>
                          <span className="font-medium text-muted-foreground">Video ID:</span>
                          <span className="ml-2 font-mono text-xs">{videoData.video_id}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Action Buttons */}
                {videoData?.video_file && (
                  <div className="flex flex-col sm:flex-row gap-3">
                    <Button 
                      onClick={handleDownload}
                      disabled={isDownloading}
                      className="flex-1 bg-violet-600 hover:bg-violet-700 text-white"
                      size="lg"
                    >
                      {isDownloading ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin mr-2" />
                          Downloading...
                        </>
                      ) : (
                        <>
                          <Download className="h-4 w-4 mr-2" />
                          Download Video ({videoData.video_file})
                        </>
                      )}
                    </Button>
                  </div>
                )}
                
                {/* Show video ID even if no file yet (for processing videos) */}
                {!videoData?.video_file && videoData?.video_id && (
                  <div className="bg-yellow-50 dark:bg-yellow-950/20 rounded-lg p-4 border border-yellow-200 dark:border-yellow-800">
                    <div className="flex items-center gap-2 mb-2">
                      <Clock className="h-4 w-4 text-yellow-600" />
                      <span className="font-medium text-sm text-yellow-800 dark:text-yellow-200">Video Processing</span>
                    </div>
                    <p className="text-sm text-yellow-700 dark:text-yellow-300">
                      Video ID: <code className="bg-yellow-100 dark:bg-yellow-900/30 px-1 rounded">{videoData.video_id}</code>
                    </p>
                    <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-1">
                      The video is being generated. Download button will appear when ready.
                    </p>
                  </div>
                )}

                {/* Video Player */}
                {videoUrl && (
                  <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 border">
                    <div className="flex items-center gap-2 mb-3">
                      <Play className="h-4 w-4 text-violet-600" />
                      <span className="font-medium text-sm">Video Player</span>
                    </div>
                    <VideoPlayer 
                      videoUrl={videoUrl} 
                      title={videoData?.title || 'Avatar Video'} 
                      className="w-full"
                    />
                  </div>
                )}

                {/* Tool Output */}
                <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-4 border">
                  <div className="flex items-center gap-2 mb-3">
                    <FileVideo className="h-4 w-4 text-gray-600 dark:text-gray-400" />
                    <span className="font-medium text-sm">Tool Output</span>
                  </div>
                  <div className="text-sm font-mono whitespace-pre-wrap break-words leading-relaxed text-gray-700 dark:text-gray-300">
                    {parsedResult?.toolOutput || 'No output available'}
                  </div>
                </div>

                {/* Session Information for session-related calls */}
                {(isAvatarSession || isAvatarSpeak) && parsedResult?.toolOutput && (
                  <div className="bg-blue-50 dark:bg-blue-950/20 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
                    <div className="flex items-center gap-2 mb-3">
                      <User className="h-4 w-4 text-blue-600" />
                      <span className="font-medium text-sm">Avatar Session</span>
                    </div>
                    <div className="text-sm text-blue-700 dark:text-blue-300">
                      {parsedResult.toolOutput}
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Export the video player for reuse
export { VideoPlayer };