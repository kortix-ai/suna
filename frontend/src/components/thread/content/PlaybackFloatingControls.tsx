import React from 'react';
import { Button } from '@/components/ui/button';
import {
    Play,
    Pause,
    ArrowUp,
    ArrowDown,
} from 'lucide-react';

interface PlaybackFloatingControlsProps {
    messageCount: number;
    currentMessageIndex: number;
    isPlaying: boolean;
    isSidePanelOpen: boolean;
    onTogglePlayback: () => void;
    onReset: () => void;
    onSkipToEnd: () => void;
    onForwardOne: () => void;
    onBackwardOne: () => void;
}

export function PlaybackFloatingControls({
    messageCount,
    currentMessageIndex,
    isPlaying,
    isSidePanelOpen,
    onTogglePlayback,
    onReset,
    onSkipToEnd,
    onForwardOne,
    onBackwardOne,
}: PlaybackFloatingControlsProps) {
    const controlsPositionClass = isSidePanelOpen
        ? 'left-1/2 -translate-x-1/4 sm:left-[calc(50%-225px)] md:left-[calc(50%-250px)] lg:left-[calc(50%-275px)] xl:left-[calc(50%-325px)]'
        : 'left-1/2 -translate-x-1/2';

    return (
        <div
            className={`fixed bottom-4 z-10 transform bg-background/90 backdrop-blur rounded-full border px-3 py-1.5 transition-all duration-200 ${controlsPositionClass}`}
        >
            <div className="flex items-center gap-2">
                {/* Play/Pause */}
                <Button
                    variant="ghost"
                    disabled={currentMessageIndex === messageCount}
                    size="icon"
                    onClick={onTogglePlayback}
                    className="h-8 w-8"
                    aria-label={isPlaying ? 'Pause Replay' : 'Play Replay'}
                >
                    {isPlaying ? (
                        <Pause className="h-4 w-4" />
                    ) : (
                        <Play className="h-4 w-4" />
                    )}
                </Button>

                {/* Message Progress */}
                <div className="flex items-center text-xs text-muted-foreground">
                    <span>
                        {Math.max(1, Math.min(currentMessageIndex, messageCount))}/{messageCount}
                    </span>
                </div>

                {/* Backward One Step */}
                <Button
                    variant="ghost"
                    size="icon"
                    disabled={currentMessageIndex === 0}
                    onClick={onBackwardOne}
                    className="h-8 w-8"
                    aria-label="Previous Message"
                >
                    <ArrowDown className="h-4 w-4 rotate-90" />
                </Button>

                {/* Forward One Step */}
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={onForwardOne}
                    disabled={currentMessageIndex >= messageCount}
                    className="h-8 w-8"
                    aria-label="Next Message"
                >
                    <ArrowUp className="h-4 w-4 rotate-90" />
                </Button>

                {/* Skip to End */}
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={onSkipToEnd}
                    className="text-xs"
                >
                    Skip to end
                </Button>
            </div>
        </div>
    );
}
