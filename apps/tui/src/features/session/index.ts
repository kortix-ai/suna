/** The session feature's public surface: one screen, one hook call. */

export {
  COMPOSER_CHROME_ROWS,
  type ComposerMetrics,
  PROMPT_RESERVE_ROWS,
  SessionView,
  type SessionFocus,
  type SessionViewProps,
  TRANSCRIPT_MIN_ROWS,
  composerReserve,
  focusHints,
  phaseGlyph,
  terminalWidth,
  transcriptRows,
} from './session-view.tsx';
export { Composer, type ComposerProps } from './composer/composer.tsx';
export { COMPOSER_KEYMAP } from './composer/keys.ts';
export { DraftView, type DraftViewProps } from './draft-view.tsx';
export {
  PromptInput,
  type PromptInputMetrics,
  type PromptInputProps,
} from './composer/prompt-input.tsx';
export {
  SessionPrompts,
  type SessionState,
  TRANSCRIPT_KEYS,
  Transcript,
} from './transcript/index.ts';
