'use client';

import { useEffect, useRef, useState } from 'react';
import { MicrophoneIcon, CheckIcon, XIcon } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { errorToast } from '@/components/ui/toast';

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

export function speechRecognitionConstructor(win: SpeechWindow) {
  return win.SpeechRecognition ?? win.webkitSpeechRecognition;
}

/** Browser speech recognition is the web equivalent of mobile's native on-device recognizer. */
export function ComposerDictation({ getText, setText }: { getText: () => string; setText: (text: string) => void }) {
  const available = typeof window !== 'undefined' && !!speechRecognitionConstructor(window);
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const original = useRef('');
  const latest = useRef({ getText, setText });
  latest.current = { getText, setText };

  useEffect(() => {
    return () => {
      if (recognition.current) {
        recognition.current.onend = null;
        recognition.current.abort();
        recognition.current = null;
      }
    };
  }, []);

  if (!available) return null;

  const start = () => {
    const Constructor = speechRecognitionConstructor(window);
    if (!Constructor) return;
    const instance = new Constructor();
    original.current = latest.current.getText();
    instance.lang = navigator.language || 'en-US';
    instance.continuous = true;
    instance.interimResults = true;
    instance.onresult = (event) => {
      const spoken = Array.from(event.results, (result) => result[0]?.transcript ?? '').join(' ').trim();
      latest.current.setText(original.current + (spoken ? `${/\s$/.test(original.current) || !original.current ? '' : ' '}${spoken}` : ''));
    };
    instance.onerror = (event) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') errorToast(`Dictation stopped: ${event.error}`);
    };
    instance.onend = () => { recognition.current = null; setListening(false); };
    recognition.current = instance;
    try { instance.start(); setListening(true); }
    catch { recognition.current = null; errorToast('Could not start dictation. Check microphone access.'); }
  };

  return listening ? (
    <div className="flex items-center gap-1" role="group" aria-label="Dictation controls">
      <Button type="button" variant="ghost" size="icon-base" aria-label="Cancel dictation" onClick={() => {
        const current = recognition.current;
        if (current) { current.onend = null; current.abort(); recognition.current = null; }
        latest.current.setText(original.current);
        setListening(false);
      }}><XIcon className="size-4" /></Button>
      <span className="text-xs text-muted-foreground" role="status">Listening…</span>
      <Button type="button" variant="ghost" size="icon-base" aria-label="Done dictating" onClick={() => recognition.current?.stop()}><CheckIcon className="size-4" /></Button>
    </div>
  ) : (
    <Button type="button" variant="ghost" size="icon-base" aria-label="Dictate message" title="Dictate message" onClick={start}><MicrophoneIcon className="size-4" /></Button>
  );
}
