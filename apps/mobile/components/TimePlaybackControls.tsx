import { useTheme } from '@/hooks/useThemeColor';
import { useExitTimePlayback, useSetPlaybackIndex, useToolViewState } from '@/stores/ui-store';
import { ChevronLeft, ChevronRight, SkipBack, SkipForward } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { Body, Caption } from './Typography';

export const TimePlaybackControls: React.FC = () => {
    const theme = useTheme();
    const toolViewState = useToolViewState();
    const setPlaybackIndex = useSetPlaybackIndex();
    const exitTimePlayback = useExitTimePlayback();

    const { playbackIndex, playbackMessages, isTimePlaybackMode } = toolViewState;

    if (!isTimePlaybackMode) return null;

    const styles = StyleSheet.create({
        container: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
            paddingVertical: 12,
            backgroundColor: theme.muted + '20',
            borderRadius: 8,
            marginBottom: 16,
        },
        controls: {
            flexDirection: 'row',
            alignItems: 'center',
        },
        controlButton: {
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: theme.primary + '20',
            justifyContent: 'center' as const,
            alignItems: 'center' as const,
            marginHorizontal: 4,
        },
        controlButtonDisabled: {
            opacity: 0.5,
        },
        info: {
            flexDirection: 'row',
            alignItems: 'center',
        },
        counter: {
            color: theme.foreground,
            fontFamily: 'monospace',
            fontSize: 12,
            marginHorizontal: 8,
        },
        exitButton: {
            paddingHorizontal: 12,
            paddingVertical: 6,
            backgroundColor: theme.destructive + '20',
            borderRadius: 4,
        },
        exitText: {
            color: theme.destructive,
            fontSize: 12,
            fontWeight: '600',
        },
    });

    const canGoPrevious = playbackIndex > 0;
    const canGoNext = playbackIndex < playbackMessages.length - 1;

    const handlePrevious = () => {
        if (canGoPrevious) {
            setPlaybackIndex(playbackIndex - 1);
        }
    };

    const handleNext = () => {
        if (canGoNext) {
            setPlaybackIndex(playbackIndex + 1);
        }
    };

    const handleFirst = () => {
        setPlaybackIndex(0);
    };

    const handleLast = () => {
        setPlaybackIndex(playbackMessages.length - 1);
    };

    return (
        <View style={styles.container}>
            <View style={styles.controls}>
                <TouchableOpacity
                    style={[styles.controlButton, !canGoPrevious && styles.controlButtonDisabled]}
                    onPress={handleFirst}
                    disabled={!canGoPrevious}
                >
                    <SkipBack size={16} color={theme.primary} />
                </TouchableOpacity>

                <TouchableOpacity
                    style={[styles.controlButton, !canGoPrevious && styles.controlButtonDisabled]}
                    onPress={handlePrevious}
                    disabled={!canGoPrevious}
                >
                    <ChevronLeft size={16} color={theme.primary} />
                </TouchableOpacity>

                <TouchableOpacity
                    style={[styles.controlButton, !canGoNext && styles.controlButtonDisabled]}
                    onPress={handleNext}
                    disabled={!canGoNext}
                >
                    <ChevronRight size={16} color={theme.primary} />
                </TouchableOpacity>

                <TouchableOpacity
                    style={[styles.controlButton, !canGoNext && styles.controlButtonDisabled]}
                    onPress={handleLast}
                    disabled={!canGoNext}
                >
                    <SkipForward size={16} color={theme.primary} />
                </TouchableOpacity>
            </View>

            <View style={styles.info}>
                <Body style={styles.counter}>
                    {playbackIndex + 1} / {playbackMessages.length}
                </Body>
            </View>

            <TouchableOpacity style={styles.exitButton} onPress={exitTimePlayback}>
                <Caption style={styles.exitText}>Exit</Caption>
            </TouchableOpacity>
        </View>
    );
}; 