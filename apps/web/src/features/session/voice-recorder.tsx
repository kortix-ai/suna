'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { useTranscription } from '@/hooks/transcription/use-transcription';
import { cn } from '@/lib/utils';
import { MicrophoneIcon as Mic, SquareIcon as Square } from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';

interface VoiceRecorderProps {
  onTranscription: (text: string) => void;
  disabled?: boolean;
  /**
   * Starts a recording from OUTSIDE the button — the `/` palette's "Start voice
   * input" row. A monotonically increasing counter, not a boolean: two
   * consecutive requests must both fire, and a boolean that is already `true`
   * produces no change to react to. `null`/`0` never starts anything, so a
   * toolbar rendered without it behaves exactly as before.
   */
  startRequestId?: number | null;
}

const MAX_RECORDING_TIME = 15 * 60 * 1000; // 15 minutes in milliseconds

/** `mm:ss`, zero-padded, so the readout never changes width mid-recording. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Icon state swaps cross-fade rather than cutting — same values everywhere. */
const ICON_SWAP = {
  initial: { scale: 0.25, opacity: 0, filter: 'blur(4px)' },
  animate: { scale: 1, opacity: 1, filter: 'blur(0px)' },
  exit: { scale: 0.25, opacity: 0, filter: 'blur(4px)' },
  transition: { type: 'spring', duration: 0.3, bounce: 0 },
} as const;

export const VoiceRecorder: React.FC<VoiceRecorderProps> = memo(function VoiceRecorder({
  onTranscription,
  disabled = false,
  startRequestId = null,
}) {
  const [state, setState] = useState<'idle' | 'recording' | 'processing'>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingStartTimeRef = useRef<number | null>(null);
  const maxTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const transcriptionMutation = useTranscription();

  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  // The 15-minute cap, plus the elapsed readout that makes it legible. Without
  // the readout the cap is invisible: a recording just ends.
  useEffect(() => {
    if (state !== 'recording') {
      recordingStartTimeRef.current = null;
      setElapsedMs(0);
      if (maxTimeoutRef.current) {
        clearTimeout(maxTimeoutRef.current);
        maxTimeoutRef.current = null;
      }
      return;
    }

    const startedAt = Date.now();
    recordingStartTimeRef.current = startedAt;
    setElapsedMs(0);
    maxTimeoutRef.current = setTimeout(() => stopRecording(), MAX_RECORDING_TIME);
    const tick = setInterval(() => setElapsedMs(Date.now() - startedAt), 250);

    return () => {
      clearInterval(tick);
      if (maxTimeoutRef.current) {
        clearTimeout(maxTimeoutRef.current);
        maxTimeoutRef.current = null;
      }
    };
  }, [state, stopRecording]);

  // The microphone must not outlive this component. Without this the stream
  // stays open after the composer unmounts — the OS recording indicator keeps
  // burning and the tab holds the mic until it is closed.
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };
  }, []);

  const startRecording = useCallback(async () => {
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
          // No toast here: `useTranscription`'s own `onError` already routes
          // the failure through `handleApiError`, which toasts it. A second
          // one would stack two cards for one failure.
          onError: () => setState('idle'),
        });

        cleanupStream();
      };

      mediaRecorder.start();
      setState('recording');
    } catch (error) {
      // The common case here is a denied or missing microphone. It used to be
      // `console.error` only, so the button lit up, went dark, and never said
      // why.
      cleanupStream();
      setState('idle');
      const name = error instanceof Error ? error.name : '';
      errorToast(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Microphone access denied'
          : 'Could not start recording',
        {
          description:
            name === 'NotAllowedError' || name === 'SecurityError'
              ? 'Allow microphone access for this site, then try again.'
              : 'No microphone was available. Check your input device and try again.',
        },
      );
    }
  }, [cleanupStream, onTranscription, transcriptionMutation]);

  const cancelRecording = () => {
    if (mediaRecorderRef.current && state === 'recording') {
      chunksRef.current = []; // Clear chunks to signal cancellation
      mediaRecorderRef.current.stop();
      cleanupStream();
      setState('idle');
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

  // An external start request (the `/` palette). Guarded on `idle` so a request
  // that lands mid-recording is ignored rather than restarting the take.
  const lastStartRequestRef = useRef<number | null>(startRequestId ?? null);
  useEffect(() => {
    if (startRequestId == null) return;
    if (lastStartRequestRef.current === startRequestId) return;
    lastStartRequestRef.current = startRequestId;
    if (disabled || state !== 'idle') return;
    startRecording();
  }, [startRequestId, disabled, state, startRecording]);

  const label =
    state === 'recording'
      ? 'Stop recording — right-click to discard'
      : state === 'processing'
        ? 'Transcribing…'
        : 'Start voice input';

  return (
    <Hint side="top" label={label}>
      <Button
        type="button"
        variant="ghost"
        size={state === 'recording' ? 'sm' : 'icon-base'}
        onClick={handleClick}
        onContextMenu={handleRightClick}
        disabled={disabled || state === 'processing'}
        aria-label={label}
        className={cn(
          'hit-area-1 shrink-0 duration-300 ease-out active:scale-[0.96] active:duration-150',
          state === 'recording' ? 'gap-1.5 px-2' : 'p-0',
        )}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <m.span key={state} className="flex items-center gap-1.5" {...ICON_SWAP}>
            {state === 'recording' ? (
              <Square weight="fill" className="size-4 shrink-0 rounded-sm" />
            ) : state === 'processing' ? (
              <Loading className="size-4 shrink-0" />
            ) : (
              <Mic className="size-4 shrink-0" />
            )}
            {state === 'recording' && (
              <span className="text-xs tabular-nums">{formatElapsed(elapsedMs)}</span>
            )}
          </m.span>
        </AnimatePresence>
      </Button>
    </Hint>
  );
});
