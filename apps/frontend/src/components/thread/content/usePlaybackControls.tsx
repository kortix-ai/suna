import { useCallback, useEffect, useState, useRef } from 'react';
import { UnifiedMessage } from '@/components/thread/types';

export interface PlaybackState {
    isPlaying: boolean;
    currentMessageIndex: number;
    visibleMessages: UnifiedMessage[];
    streamingText: string;
    isStreamingText: boolean;
}

interface UsePlaybackControlsProps {
    messages: UnifiedMessage[];
    enabled: boolean;
}

export function usePlaybackControls({ messages, enabled }: UsePlaybackControlsProps) {
    const [playbackState, setPlaybackState] = useState<PlaybackState>({
        isPlaying: false,
        currentMessageIndex: 0,
        visibleMessages: messages,
        streamingText: '',
        isStreamingText: false,
    });

    const playbackStateRef = useRef(playbackState);
    const isProcessingRef = useRef(false);

    // Keep ref in sync
    useEffect(() => {
        playbackStateRef.current = playbackState;
    }, [playbackState]);

    // Initialize with all messages visible for shared mode
    useEffect(() => {
        if (enabled && messages.length > 0) {
            setPlaybackState(prev => ({
                ...prev,
                visibleMessages: messages,
                currentMessageIndex: messages.length,
            }));
        }
    }, [enabled, messages.length]);

    const togglePlayback = useCallback(() => {
        setPlaybackState(prev => ({
            ...prev,
            isPlaying: !prev.isPlaying,
        }));
    }, []);

    const resetPlayback = useCallback(() => {
        setPlaybackState({
            isPlaying: false,
            currentMessageIndex: 0,
            visibleMessages: [],
            streamingText: '',
            isStreamingText: false,
        });
    }, []);

    return {
        playbackState,
        togglePlayback,
        resetPlayback,
    };
}
