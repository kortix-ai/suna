'use client';

import { getAuthToken, getSandboxUrlForExternalId, probePreviewPort } from '@kortix/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

import { CallAudio } from './call-audio';
import { canShareScreen, sampleScreen, SCREEN_MEDIA, type ScreenSampler } from './screen-share';
import {
  AUDIBLE_RMS,
  createPlayback,
  DIAL_MS,
  INITIAL_CALL,
  reduceCall,
  REDIAL_MS,
  SPEAKING_HOLD_MS,
  type CallEvent,
  type CallState,
} from './voice-call-state';
import { useVoiceCallStore } from './voice-call-store';
import { VOICE_PORT, voiceCallSocketUrl, voiceRelayHealthUrl } from './voice-call-url';

/** The relay asks for a fresh screen frame at most this often (`{type:'snap'}`). */
const SNAP_GAP_MS = 700;

interface RelayMessage {
  type?: string;
  on?: boolean;
  role?: string;
  who?: string;
  text?: string;
  inRate?: number;
  outRate?: number;
}

/** What the share and mute controls reach of the call the effect runs. */
interface LiveCall {
  send(message: object): boolean;
  mute(on: boolean): void;
}

/**
 * One voice call with the session `sessionId` (the Kortix session id) on its box `sandboxId` (the sandbox's external
 * id), for as long as the caller is mounted. It dials the box's relay, plays the voice, sends the microphone and a
 * shared screen, redials a live call that drops, and releases everything on unmount and when the tab closes.
 */
export function useVoiceCall(sessionId: string, sandboxId: string) {
  const [state, setState] = useState<CallState>(INITIAL_CALL);
  const [muted, setMuted] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mutedRef = useRef(false);
  const liveRef = useRef<LiveCall | null>(null);
  const shareRef = useRef<{ sampler: ScreenSampler; stop: (tell: boolean) => void } | null>(null);

  useEffect(() => {
    if (!sandboxId) return;
    const portUrl = getSandboxUrlForExternalId(sandboxId, VOICE_PORT);
    let current = INITIAL_CALL;
    let disposed = false;
    let socket: WebSocket | undefined;
    let audio: CallAudio | undefined;
    let redial: ReturnType<typeof setTimeout> | undefined;
    let frame = 0;
    let heardAt = -Infinity;
    let snapAt = -Infinity;

    const send = (message: object) => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    };
    const playback = createPlayback({ post: (m) => audio?.post(m), level: (v) => audio?.level(v) });
    const dropAudio = () => {
      cancelAnimationFrame(frame);
      audio?.stop();
      audio = undefined;
    };
    const step = (event: CallEvent) => {
      current = reduceCall(current, event);
      setState(current);
      if (current.phase === 'ended') {
        clearTimeout(redial);
        dropAudio();
        shareRef.current?.stop(false);
        socket?.close();
      }
      return current;
    };
    liveRef.current = { send, mute: (on) => audio?.mute(on) };

    const listen = (target: CallAudio) => {
      const now = performance.now();
      if (target.voiceLevel() > AUDIBLE_RMS) heardAt = now;
      const speaking = now - heardAt < SPEAKING_HOLD_MS;
      if (speaking !== current.speaking) step({ type: 'speaking', on: speaking });
      frame = requestAnimationFrame(() => listen(target));
    };

    const onReady = (message: RelayMessage) => {
      step({ type: 'ready', at: Date.now() });
      // A redialed call is a new call on the relay: it sees the shared screen again.
      shareRef.current?.sampler.snap();
      const started = (audio = new CallAudio());
      started
        .start({
          inRate: message.inRate ?? 0,
          outRate: message.outRate ?? 0,
          ...playback.current(),
          muted: () => mutedRef.current,
          onFrame: (pcm) => {
            if (socket?.readyState === WebSocket.OPEN) socket.send(pcm);
          },
        })
        .then((microphone) => {
          if (audio === started && !microphone) step({ type: 'mic-blocked' });
        })
        .catch(() => {
          if (audio === started) step({ type: 'audio-failed' });
        });
      frame = requestAnimationFrame(() => listen(started));
    };

    const onMessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) return void audio?.play(event.data);
      let message: RelayMessage;
      try {
        message = JSON.parse(event.data as string) as RelayMessage;
      } catch {
        return;
      }
      if (playback.handle(message)) return;
      switch (message.type) {
        case 'ready':
          return onReady(message);
        case 'text':
          return void step({ type: 'text', role: message.role, who: message.who, text: message.text });
        case 'snap': {
          const share = shareRef.current;
          if (!share || performance.now() - snapAt < SNAP_GAP_MS) return;
          snapAt = performance.now();
          return void share.sampler.snap();
        }
        case 'closed':
          return void step({ type: 'closed' });
      }
    };

    const dial = async (again: boolean) => {
      const token = await getAuthToken().catch(() => null);
      if (disposed) return;
      const opened = new WebSocket(
        voiceCallSocketUrl(portUrl, { session: sessionId, token, redial: again, securePage: location.protocol === 'https:' }),
      );
      opened.binaryType = 'arraybuffer';
      socket = opened;
      opened.onmessage = onMessage;
      opened.onclose = () => {
        if (disposed || socket !== opened) return;
        dropAudio();
        if (current.phase === 'connecting') {
          // Before the first `ready`: dialed again while a box that just started opens the relay's port (DIAL_MS).
          // After the last try, a port nothing listens on is a sandbox without the relay: the proxy answers that
          // itself (502/503/504), and the probe tells it from a failed dial.
          void probePreviewPort(voiceRelayHealthUrl(portUrl)).then((relay) => {
            if (disposed) return;
            const next = step({ type: 'drop', relay });
            if (next.phase === 'connecting') redial = setTimeout(() => void dial(false), DIAL_MS[next.redials - 1]);
          });
          return;
        }
        const next = step({ type: 'drop' });
        if (next.phase === 'reconnecting') redial = setTimeout(() => void dial(true), REDIAL_MS[next.redials]);
      };
    };

    const teardown = () => {
      disposed = true;
      clearTimeout(redial);
      dropAudio();
      shareRef.current?.stop(false);
      socket?.close();
      liveRef.current = null;
    };
    // Closing the tab (or leaving it for the back-forward cache) ends the call and its bar.
    const onPageHide = () => {
      teardown();
      useVoiceCallStore.getState().end(sessionId);
    };
    window.addEventListener('pagehide', onPageHide);
    void dial(false);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      teardown();
    };
  }, [sandboxId, sessionId, attempt]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    liveRef.current?.mute(next);
  }, []);

  const toggleShare = useCallback(async () => {
    if (shareRef.current) return shareRef.current.stop(true);
    const stream = await navigator.mediaDevices.getDisplayMedia(SCREEN_MEDIA).catch(() => null);
    if (!stream) return;
    const call = liveRef.current;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play().catch(() => {});
    if (!call || liveRef.current !== call || shareRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const sampler = sampleScreen(video, (data) => liveRef.current?.send({ type: 'image', data, from: 'screen' }));
    const stop = (tell: boolean) => {
      if (shareRef.current?.stop !== stop) return;
      shareRef.current = null;
      sampler.stop();
      stream.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
      if (tell) liveRef.current?.send({ type: 'image', data: '', from: 'screen' });
      setSharing(false);
    };
    shareRef.current = { sampler, stop };
    // The browser's own "Stop sharing" ends the track.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => stop(true), { once: true });
    setSharing(true);
  }, []);

  const callAgain = useCallback(() => {
    setState(INITIAL_CALL);
    setAttempt((n) => n + 1);
  }, []);

  return { state, muted, toggleMute, sharing, canShare: canShareScreen(), toggleShare, callAgain };
}
