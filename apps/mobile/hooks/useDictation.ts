/**
 * useDictation — the composer's voice input. The platform speech
 * recogniser (`expo-speech-recognition`) writes the words into the text field
 * as they are spoken; the user edits and sends as normal. No backend.
 *
 * - `start()` asks for the microphone and speech permissions, then listens.
 *   Words are appended to what was typed before (`dictationDraft`).
 * - `finish()` keeps the words. `cancel()` puts the text back as it was.
 * - `levels` is the input volume history for the waveform, on the UI thread.
 *
 * OTA safety: `runtimeVersion` is a fixed string, so an OTA update can reach a
 * binary built before this native module, and Expo Go never has it. The
 * package calls `requireNativeModule` at import and throws when the module is
 * missing, so it is required only after `requireOptionalNativeModule` finds
 * it. Without the module `available` is false and the mic button is hidden.
 */
import * as React from 'react';
import { Linking, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';

import { useToast } from '@/components/kortix/toast-provider';
import { haptics } from '@/lib/haptics';
import { log } from '@/lib/logger';
import {
  DICTATION_BAR_COUNT,
  EMPTY_TRANSCRIPT,
  dictationDraft,
  dictationErrorMessage,
  dictationLocale,
  levelFromVolume,
  pushLevel,
  reduceTranscript,
  transcriptText,
  type Transcript,
} from '@/lib/session/dictation';
import { resetAudioMode } from '@/lib/sounds';

type SpeechModule = typeof import('expo-speech-recognition').ExpoSpeechRecognitionModule;

const NATIVE_MODULE_PRESENT = requireOptionalNativeModule('ExpoSpeechRecognition') != null;

function speechModule(): SpeechModule | null {
  if (!NATIVE_MODULE_PRESENT) return null;
  return (require('expo-speech-recognition') as typeof import('expo-speech-recognition'))
    .ExpoSpeechRecognitionModule;
}

/** After `stop()`, the recogniser's final result and `end` normally arrive within ~300 ms. */
const FINISH_TIMEOUT_MS = 2000;

/** How often the recogniser reports the input volume: one waveform bar per sample. */
const VOLUME_INTERVAL_MS = 80;

export type DictationState = 'idle' | 'starting' | 'listening' | 'stopping';

const SILENT_LEVELS = Array.from({ length: DICTATION_BAR_COUNT }, () => 0);

function deviceLocale(): string {
  try {
    return dictationLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return 'en-US';
  }
}

export interface Dictation {
  /** This binary has the recogniser. In a dev build without it the button still shows and explains. */
  available: boolean;
  state: DictationState;
  /** `state !== 'idle'`: the control row shows the listening bar. */
  active: boolean;
  levels: SharedValue<number[]>;
  start: () => void;
  finish: () => void;
  cancel: () => void;
}

export function useDictation({
  value,
  onChangeText,
}: {
  value: string;
  onChangeText: (text: string) => void;
}): Dictation {
  const toast = useToast();
  const [state, setState] = React.useState<DictationState>('idle');
  const levels = useSharedValue<number[]>(SILENT_LEVELS);

  // The session reads the latest props without restarting on every keystroke.
  const valueRef = React.useRef(value);
  valueRef.current = value;
  const onChangeRef = React.useRef(onChangeText);
  onChangeRef.current = onChangeText;

  const session = React.useRef<{
    base: string;
    transcript: Transcript;
    cancelled: boolean;
    lang: string;
    retriedLang: boolean;
    /** `language-not-supported` arrived: the next `end` restarts in English. */
    restartInEnglish: boolean;
    subscriptions: { remove: () => void }[];
    finishTimer: ReturnType<typeof setTimeout> | null;
  } | null>(null);

  const teardown = React.useCallback(() => {
    const s = session.current;
    if (!s) return;
    s.subscriptions.forEach((sub) => sub.remove());
    if (s.finishTimer) clearTimeout(s.finishTimer);
    session.current = null;
    levels.value = SILENT_LEVELS;
    resetAudioMode();
    setState('idle');
  }, [levels]);

  const begin = React.useCallback((module: SpeechModule, lang: string) => {
    const s = session.current;
    if (!s) return;
    s.lang = lang;
    module.start({
      lang,
      interimResults: true,
      // Listens until the user taps Done; on Android 13+ it also mutes the start beep.
      continuous: true,
      addsPunctuation: true,
      // Apple's server recogniser stops after about a minute; on-device has no limit.
      requiresOnDeviceRecognition: Platform.OS === 'ios' && module.supportsOnDeviceRecognition(),
      iosTaskHint: 'dictation',
      volumeChangeEventOptions: { enabled: true, intervalMillis: VOLUME_INTERVAL_MS },
    });
  }, []);

  const start = React.useCallback(async () => {
    if (session.current) return;
    const module = speechModule();
    if (!module) {
      toast.info('Dictation needs a new app build', {
        description: 'Expo Go and older builds do not include speech recognition.',
      });
      return;
    }
    if (!module.isRecognitionAvailable()) {
      toast.error('Speech recognition is not available on this device.');
      return;
    }

    haptics.tap();
    setState('starting');
    const s = {
      base: valueRef.current,
      transcript: EMPTY_TRANSCRIPT,
      cancelled: false,
      lang: deviceLocale(),
      retriedLang: false,
      restartInEnglish: false,
      subscriptions: [] as { remove: () => void }[],
      finishTimer: null as ReturnType<typeof setTimeout> | null,
    };
    session.current = s;

    let permission;
    try {
      permission = await module.getPermissionsAsync();
      if (!permission.granted && permission.canAskAgain) {
        permission = await module.requestPermissionsAsync();
      }
    } catch (error) {
      log.warn('[dictation] permission check failed', error);
      permission = null;
    }
    if (session.current !== s) return; // cancelled while the prompt was up
    if (!permission?.granted) {
      teardown();
      toast.error('Kortix cannot use the microphone', {
        description: 'Allow microphone and speech recognition in Settings.',
        action: { label: 'Settings', onPress: () => void Linking.openSettings() },
      });
      return;
    }

    s.subscriptions.push(
      module.addListener('start', () => {
        if (session.current === s) setState((prev) => (prev === 'starting' ? 'listening' : prev));
      }),
      module.addListener('result', (event) => {
        if (session.current !== s || s.cancelled) return;
        s.transcript = reduceTranscript(s.transcript, {
          isFinal: event.isFinal,
          transcript: event.results[0]?.transcript ?? '',
        });
        onChangeRef.current(dictationDraft(s.base, transcriptText(s.transcript)));
      }),
      module.addListener('volumechange', (event) => {
        if (session.current !== s) return;
        levels.value = pushLevel(levels.value, levelFromVolume(event.value));
      }),
      module.addListener('error', (event) => {
        if (session.current !== s) return;
        // The device locale may have no recogniser; English always does.
        if (event.error === 'language-not-supported' && !s.retriedLang && s.lang !== 'en-US') {
          s.retriedLang = true;
          s.restartInEnglish = true;
          return;
        }
        log.warn('[dictation] error', event.error, event.message);
        const message = s.cancelled ? null : dictationErrorMessage(event.error);
        if (message) {
          haptics.error();
          toast.error(message);
        }
      }),
      module.addListener('end', () => {
        if (session.current !== s) return;
        if (s.restartInEnglish) {
          s.restartInEnglish = false;
          try {
            begin(module, 'en-US');
            return;
          } catch (error) {
            log.warn('[dictation] English restart failed', error);
          }
        }
        teardown();
      })
    );

    try {
      begin(module, s.lang);
    } catch (error) {
      log.warn('[dictation] start failed', error);
      teardown();
      toast.error('Dictation stopped. Try again.');
    }
  }, [begin, levels, teardown, toast]);

  const finish = React.useCallback(() => {
    const s = session.current;
    const module = speechModule();
    if (!s || !module) return;
    haptics.selection();
    setState('stopping');
    module.stop();
    // `end` normally tears down; this covers a recogniser that never sends it.
    s.finishTimer = setTimeout(() => {
      if (session.current !== s) return;
      module.abort();
      teardown();
    }, FINISH_TIMEOUT_MS);
  }, [teardown]);

  const cancel = React.useCallback(() => {
    const s = session.current;
    if (!s) return;
    haptics.selection();
    s.cancelled = true;
    onChangeRef.current(s.base);
    speechModule()?.abort();
    teardown();
  }, [teardown]);

  // Leaving the screen mid-dictation stops the microphone.
  React.useEffect(
    () => () => {
      if (!session.current) return;
      session.current.cancelled = true;
      speechModule()?.abort();
      teardown();
    },
    [teardown]
  );

  return {
    available: NATIVE_MODULE_PRESENT || __DEV__,
    state,
    active: state !== 'idle',
    levels,
    start: () => void start(),
    finish,
    cancel,
  };
}
