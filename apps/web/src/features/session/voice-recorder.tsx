import { cn } from '@/lib/utils';
import React, { useState, useRef, useEffect, memo } from 'react';
import { Mic, Square } from 'lucide-react';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Button } from '@/components/ui/button';
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import { useTranscription } from '@/hooks/transcription/use-transcription';

interface VoiceRecorderProps {
    onTranscription: (text: string) => void;
    disabled?: boolean;
}

const MAX_RECORDING_TIME = 15 * 60 * 1000; // 15 minutes in milliseconds

export const VoiceRecorder: React.FC<VoiceRecorderProps> = memo(function VoiceRecorder({
    onTranscription,
    disabled = false,
}) {
    const [state, setState] = useState<'idle' | 'recording' | 'processing'>('idle');
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const streamRef = useRef<MediaStream | null>(null);
    const recordingStartTimeRef = useRef<number | null>(null);
    const maxTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const transcriptionMutation = useTranscription();

    // Auto-stop recording after 15 minutes
    useEffect(() => {
        if (state === 'recording') {
            recordingStartTimeRef.current = Date.now();
            maxTimeoutRef.current = setTimeout(() => {
                stopRecording();
            }, MAX_RECORDING_TIME);
        } else {
            recordingStartTimeRef.current = null;
            if (maxTimeoutRef.current) {
                clearTimeout(maxTimeoutRef.current);
                maxTimeoutRef.current = null;
            }
        }

        return () => {
            if (maxTimeoutRef.current) {
                clearTimeout(maxTimeoutRef.current);
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state]);

    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;

            const options = { mimeType: 'audio/webm' };
            const mediaRecorder = new MediaRecorder(stream, options);
            mediaRecorderRef.current = mediaRecorder;
            chunksRef.current = [];

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    chunksRef.current.push(event.data);
                }
            };

            mediaRecorder.onstop = async () => {
                if (chunksRef.current.length === 0) {
                    // Recording was cancelled
                    cleanupStream();
                    setState('idle');
                    return;
                }

                setState('processing');
                const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm' });
                const audioFile = new File([audioBlob], 'recording.webm', { type: 'audio/webm' });

                transcriptionMutation.mutate(audioFile, {
                    onSuccess: (data) => {
                        onTranscription(data.text);
                        setState('idle');
                    },
                    onError: (error) => {
                        console.error('Transcription failed:', error);
                        setState('idle');
                    },
                });

                cleanupStream();
            };

            mediaRecorder.start();
            setState('recording');
        } catch (error) {
            console.error('Error starting recording:', error);
            setState('idle');
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && state === 'recording') {
            mediaRecorderRef.current.stop();
        }
    };

    const cancelRecording = () => {
        if (mediaRecorderRef.current && state === 'recording') {
            chunksRef.current = []; // Clear chunks to signal cancellation
            mediaRecorderRef.current.stop();
            cleanupStream();
            setState('idle');
        }
    };

    const cleanupStream = () => {
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
    };

    const handleClick = () => {
        if (state === 'idle') {
            startRecording();
        } else if (state === 'recording') {
            stopRecording();
        }
    };

    const handleRightClick = (e: React.MouseEvent) => {
        e.preventDefault();
        if (state === 'recording') {
            cancelRecording();
        }
    };

    const getButtonClass = () => {
        if (state === 'recording') return 'text-red-500 hover:text-red-600';
        return '';
    };

    const getIcon = () => {
        switch (state) {
            case 'recording':
                return <Square className="h-4 w-4" />;
            case 'processing':
                return <KortixLoader size="small" />;
            default:
                return <Mic className="h-4 w-4" />;
        }
    };

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleClick}
                    onContextMenu={handleRightClick}
                    disabled={disabled || state === 'processing'}
                    className={cn('h-8 w-8 p-0 bg-transparent border-none text-muted-foreground hover:text-foreground hover:bg-muted/50 flex items-center justify-center transition-colors', getButtonClass())}
                >
                    {getIcon()}
                </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
                <p>
                    {state === 'recording'
                        ? 'Click to stop recording'
                        : state === 'processing'
                            ? 'Processing...'
                            : 'Record voice message'
                    }
                </p>
            </TooltipContent>
        </Tooltip>
    );
}); 