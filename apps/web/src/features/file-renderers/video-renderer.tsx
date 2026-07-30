'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import {
  DownloadIcon as Download,
  InfoIcon as Info,
  CornersOutIcon as Maximize,
  CornersInIcon as Minimize,
  PauseIcon as Pause,
  PlayIcon as Play,
  ArrowCounterClockwiseIcon as RotateCcw,
  SpeakerHighIcon as Volume2,
  SpeakerSlashIcon as VolumeX,
} from '@phosphor-icons/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

interface VideoRendererProps {
  url: string;
  className?: string;
  compact?: boolean; // For inline/thumbnail view
  autoPlay?: boolean;
  loop?: boolean;
  onDownload?: () => void;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function VideoRenderer({
  url,
  className,
  compact = false,
  autoPlay = false,
  loop = false,
  onDownload,
}: VideoRendererProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showInfo, setShowInfo] = useState(false);
  const [videoInfo, setVideoInfo] = useState<{
    width: number;
    height: number;
    duration: number;
  } | null>(null);

  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Handle fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Auto-hide controls
  const resetControlsTimeout = useCallback(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    setShowControls(true);
    if (isPlaying && !compact) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, 3000);
    }
  }, [isPlaying, compact]);

  useEffect(() => {
    resetControlsTimeout();
    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, [isPlaying, resetControlsTimeout]);

  // Video event handlers
  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (video) {
      setDuration(video.duration);
      setVideoInfo({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
      });
      setIsLoading(false);
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  const handleError = (e: React.SyntheticEvent<HTMLVideoElement, Event>) => {
    const videoElement = e.currentTarget;
    const error = videoElement.error;
    // Only log meaningful errors — skip aborted loads (e.g. blob URL revoked on file switch)
    if (error && error.code !== MediaError.MEDIA_ERR_ABORTED) {
      console.warn('[VideoRenderer] Video error:', {
        code: error.code,
        message: error.message,
        url: videoElement.src?.slice(0, 100),
        networkState: videoElement.networkState,
      });
    }
    setHasError(true);
    setIsLoading(false);
  };

  const handleCanPlay = () => {
    setIsLoading(false);
  };

  // Controls
  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  const handleVolumeChange = (value: number[]) => {
    const newVolume = value[0];
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
      setVolume(newVolume);
      setIsMuted(newVolume === 0);
    }
  };

  const handleSeek = (value: number[]) => {
    const time = value[0];
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const handleRestart = () => {
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      setCurrentTime(0);
      videoRef.current.play();
      setIsPlaying(true);
    }
  };

  const toggleFullscreen = async () => {
    if (!containerRef.current) return;

    if (isFullscreen) {
      await document.exitFullscreen();
    } else {
      await containerRef.current.requestFullscreen();
    }
  };

  // Compact view for inline display
  if (compact) {
    return (
      <div
        className={cn(
          'relative overflow-hidden rounded-2xl bg-black/5 dark:bg-black/20',
          className,
        )}
      >
        {isLoading && (
          <div className="bg-muted/50 absolute inset-0 flex items-center justify-center">
            <KortixLoader size="medium" />
          </div>
        )}
        {hasError ? (
          <div className="flex h-full flex-col items-center justify-center p-4 text-center">
            <p className="text-muted-foreground text-sm font-medium">
              {tHardcodedUi.raw(
                'componentsFileRenderersVideoRenderer.line201JsxTextFailedToLoadVideo',
              )}
            </p>
          </div>
        ) : (
          <div className="group relative">
            <video
              ref={videoRef}
              src={url}
              className="h-auto max-h-80 w-full object-contain"
              autoPlay={autoPlay}
              loop={loop}
              muted={isMuted}
              playsInline
              onLoadedMetadata={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              onError={handleError}
              onCanPlay={handleCanPlay}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
            />
            {/* Compact overlay controls */}
            <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100">
              <Button
                variant="ghost"
                size="icon"
                className="h-12 w-12 rounded-full bg-white/90 shadow-lg hover:bg-white dark:bg-black/90 dark:hover:bg-black"
                onClick={togglePlay}
              >
                {isPlaying ? <Pause className="h-6 w-6" /> : <Play className="ml-0.5 h-6 w-6" />}
              </Button>
            </div>
            {/* Progress bar at bottom */}
            <div className="absolute right-0 bottom-0 left-0 h-1 bg-black/30">
              <div
                className="h-full bg-white/80"
                style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // Full view for file viewer
  return (
    <div
      ref={containerRef}
      className={cn('group relative h-full w-full bg-black', className)}
      onMouseMove={resetControlsTimeout}
      onMouseEnter={() => setShowControls(true)}
    >
      {/* Loading state */}
      {isLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black">
          <KortixLoader size="large" variant="white" />
        </div>
      )}

      {/* Error state */}
      {hasError ? (
        <div className="flex h-full flex-col items-center justify-center p-6 text-center">
          <p className="mb-2 font-medium text-white">
            {tHardcodedUi.raw(
              'componentsFileRenderersVideoRenderer.line267JsxTextFailedToLoadVideo',
            )}
          </p>
          <p className="text-sm text-white/60">
            {tHardcodedUi.raw(
              'componentsFileRenderersVideoRenderer.line268JsxTextTheVideoCouldNotBePlayed',
            )}
          </p>
        </div>
      ) : (
        <>
          {/* Video element */}
          <video
            ref={videoRef}
            src={url}
            className="h-full w-full object-contain"
            autoPlay={autoPlay}
            loop={loop}
            muted={isMuted}
            playsInline
            onClick={togglePlay}
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={handleTimeUpdate}
            onError={handleError}
            onCanPlay={handleCanPlay}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={() => setIsPlaying(false)}
          />

          {/* Center play button (when paused) */}
          {!isPlaying && !isLoading && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm">
                <Play className="ml-1 h-10 w-10 text-white" />
              </div>
            </div>
          )}

          {/* Top controls */}
          <div
            className={cn(
              'absolute top-0 right-0 left-0 bg-gradient-to-b from-black/60 to-transparent p-4 transition-opacity duration-200',
              showControls ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
          >
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-8 p-0 text-white hover:bg-white/20"
                onClick={() => setShowInfo(!showInfo)}
              >
                <Info className="h-4 w-4" />
              </Button>
              {onDownload && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-auto gap-1.5 px-2.5 text-white hover:bg-white/20"
                  onClick={onDownload}
                >
                  <Download className="h-4 w-4" />
                  Download
                </Button>
              )}
            </div>
          </div>

          {/* Video info overlay */}
          {showInfo && videoInfo && (
            <div className="absolute top-14 right-4 z-10 min-w-[180px] rounded-2xl bg-black/80 p-4 text-sm text-white">
              <div className="space-y-2">
                <div className="flex justify-between gap-6">
                  <span className="text-white/60">Resolution</span>
                  <span className="font-medium">
                    {videoInfo.width} × {videoInfo.height}
                  </span>
                </div>
                <div className="flex justify-between gap-6">
                  <span className="text-white/60">Duration</span>
                  <span className="font-medium">{formatTime(videoInfo.duration)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Bottom controls */}
          <div
            className={cn(
              'absolute right-0 bottom-0 left-0 bg-gradient-to-t from-black/80 to-transparent p-4 transition-opacity duration-200',
              showControls ? 'opacity-100' : 'pointer-events-none opacity-0',
            )}
          >
            {/* Progress bar */}
            <div className="mb-3">
              <Slider
                value={[currentTime]}
                max={duration || 100}
                step={0.1}
                onValueChange={handleSeek}
                className="cursor-pointer [&_[data-slot=range]]:bg-white [&_[data-slot=thumb]]:h-3 [&_[data-slot=thumb]]:w-3 [&_[data-slot=thumb]]:border-0 [&_[data-slot=thumb]]:bg-white [&_[data-slot=track]]:bg-white/30"
              />
            </div>

            {/* Control buttons */}
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                className="w-9 p-0 text-white hover:bg-white/20"
                onClick={togglePlay}
              >
                {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
              </Button>

              <Button
                variant="ghost"
                size="sm"
                className="w-9 p-0 text-white hover:bg-white/20"
                onClick={handleRestart}
              >
                <RotateCcw className="h-4 w-4" />
              </Button>

              {/* Time display */}
              <span className="min-w-[90px] font-mono text-sm text-white">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>

              <div className="flex-1" />

              {/* Volume controls */}
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-9 p-0 text-white hover:bg-white/20"
                  onClick={toggleMute}
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="h-5 w-5" />
                  ) : (
                    <Volume2 className="h-5 w-5" />
                  )}
                </Button>
                <Slider
                  value={[isMuted ? 0 : volume]}
                  max={1}
                  step={0.1}
                  onValueChange={handleVolumeChange}
                  className="w-20 cursor-pointer [&_[data-slot=range]]:bg-white [&_[data-slot=thumb]]:h-3 [&_[data-slot=thumb]]:w-3 [&_[data-slot=thumb]]:border-0 [&_[data-slot=thumb]]:bg-white [&_[data-slot=track]]:bg-white/30"
                />
              </div>

              {/* Fullscreen */}
              <Button
                variant="ghost"
                size="sm"
                className="w-9 p-0 text-white hover:bg-white/20"
                onClick={toggleFullscreen}
              >
                {isFullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// Compact video player for inline tool views
export function InlineVideoPlayer({ url, className }: { url: string; className?: string }) {
  return (
    <VideoRenderer
      url={url}
      className={cn(
        'aspect-video w-80 rounded-2xl border border-neutral-200 dark:border-neutral-700/50',
        className,
      )}
      compact
      loop
    />
  );
}
