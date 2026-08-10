import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { useTranscription } from '@/hooks/transcription/use-transcription';
import { cn } from '@/lib/utils';
import { MicrophoneIcon as Mic, SquareIcon as Square } from '@phosphor-icons/react';
import React, { memo, useEffect, useRef, useState } from 'react';

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
      streamRef.current.getTracks().forEach((track) => track.stop());
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

  const getIcon = () => {
    switch (state) {
      case 'recording':
        return <Square weight="fill" className="size-4 shrink-0 rounded-sm" />;
      case 'processing':
        return <KortixLoader size="small" className="size-4 shrink-0" />;
      default:
        return <Mic className="size-4 shrink-0" />;
    }
  };

  return (
    <Hint
      side="top"
      label={
        state === 'recording'
          ? 'Click to stop recording'
          : state === 'processing'
            ? 'Processing...'
            : 'Record voice message'
      }
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-base"
        onClick={handleClick}
        onContextMenu={handleRightClick}
        disabled={disabled || state === 'processing'}
        className={cn(
          'hit-area-1 shrink-0 rounded-full p-0 duration-300 ease-out active:scale-[0.96] active:duration-150',
        )}
      >
        {getIcon()}
      </Button>
    </Hint>
  );
});
