import { describe, expect, test } from 'bun:test';
import { speechRecognitionConstructor } from './composer-dictation';

describe('composer dictation availability', () => {
  test('hides the microphone when no browser recognizer exists', () => {
    expect(speechRecognitionConstructor({} as Window)).toBeUndefined();
  });
  test('accepts standard and prefixed browser recognizers', () => {
    const recognizer = class {};
    expect(speechRecognitionConstructor({ SpeechRecognition: recognizer } as never)).toBe(recognizer);
    expect(speechRecognitionConstructor({ webkitSpeechRecognition: recognizer } as never)).toBe(recognizer);
  });
});
