import React from 'react';
import { Button } from '@/components/ui/button';
import { 
  Play, 
  Pause, 
  RotateCcw, 
  SkipForward, 
  FileText,
  PanelRightOpen 
} from 'lucide-react';
import Link from 'next/link';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

interface SimplePlaybackControlsProps {
  projectName: string;
  messageCount: number;
  isSidePanelOpen: boolean;
  onToggleSidePanel: () => void;
}

export function SimplePlaybackControls({ 
  projectName, 
  messageCount,
  isSidePanelOpen,
  onToggleSidePanel 
}: SimplePlaybackControlsProps) {
  const [isPlaying, setIsPlaying] = React.useState(false);

  const controlsPositionClass = isSidePanelOpen
    ? 'left-1/2 -translate-x-1/4 sm:left-[calc(50%-225px)] md:left-[calc(50%-250px)] lg:left-[calc(50%-275px)] xl:left-[calc(50%-325px)]'
    : 'left-1/2 -translate-x-1/2';

  return (
    <div className={`fixed top-4 ${controlsPositionClass} z-50 transition-all duration-200`}>
      <div className="flex items-center gap-2 rounded-full border border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 px-3 py-2 shadow-lg">
        {/* Kortix Logo */}
        <Link
          href="https://kortix.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm font-medium hover:opacity-80 transition-opacity"
        >
          <KortixLogo className="h-5 w-5" />
          <span className="hidden sm:inline">Kortix</span>
        </Link>

        <div className="h-4 w-px bg-border/40" />

        {/* Project Name */}
        <div className="flex items-center gap-2 text-sm">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium max-w-[150px] sm:max-w-[200px] truncate">{projectName}</span>
        </div>

        <div className="h-4 w-px bg-border/40" />

        {/* Playback Controls */}
        <div className="flex items-center gap-1">
          {/* Reset */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => {
              setIsPlaying(false);
              // Just visual feedback, no actual playback logic
            }}
            aria-label="Reset"
          >
            <RotateCcw className="h-4 w-4" />
          </Button>

          {/* Play/Pause */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setIsPlaying(!isPlaying)}
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </Button>

          {/* Skip to End */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => {
              setIsPlaying(false);
              // Just visual feedback
            }}
            aria-label="Skip to End"
          >
            <SkipForward className="h-4 w-4" />
          </Button>
        </div>

        <div className="h-4 w-px bg-border/40" />

        {/* Message Count */}
        <div className="text-sm text-muted-foreground hidden sm:block">
          {messageCount} {messageCount === 1 ? 'msg' : 'msgs'}
        </div>

        {/* Toggle Side Panel */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onToggleSidePanel}
          aria-label="Toggle Tool Panel"
        >
          <PanelRightOpen className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
