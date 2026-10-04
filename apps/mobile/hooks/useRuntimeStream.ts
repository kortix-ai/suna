/**
 * Mounts the app's side of the live session stream (`lib/session/runtime-stream.ts`):
 * cues, the "Live updates paused" state, and the lifecycle signals the SDK
 * cannot observe on React Native. Mounted once, by `SandboxProvider`.
 */
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { notifyHostSignal } from '@kortix/sdk';
import { subscribeRuntimeStream } from '@kortix/sdk/react';
import { haptics } from '@/lib/haptics';
import { subscribeOnlineStatus } from '@/lib/network/use-online-status';
import { playSound } from '@/lib/sounds';
import { useStreamHealthStore } from '@/lib/session/live-updates';
import { createStreamSignalBridge } from '@/lib/session/runtime-stream';

export function useRuntimeStream(): void {
  useEffect(() => {
    const health = useStreamHealthStore.getState();
    const stopStream = subscribeRuntimeStream(
      createStreamSignalBridge({
        dispatch: (event) => useStreamHealthStore.getState().dispatch(event),
        // `playSound` and `haptics` read the Sounds settings.
        playCue: (cue) => {
          void playSound(cue.sound);
          if (cue.haptic === 'success') haptics.success();
        },
        isForeground: () => AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
      }),
    );
    // The pill's Reconnect.
    const stopReconnect = health.registerReconnect(() => notifyHostSignal('retry'));
    // React Native has no `visibilitychange` or `online` event: report both.
    // The SDK reconnects only when the stream has been silent for a minute.
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') notifyHostSignal('visible');
    });
    // The status source notifies only on a change, so `true` is always an
    // offline → online transition.
    const stopOnline = subscribeOnlineStatus((isOnline) => {
      if (isOnline) notifyHostSignal('online');
    });
    return () => {
      stopStream();
      stopReconnect();
      appState.remove();
      stopOnline();
    };
  }, []);
}
