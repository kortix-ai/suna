/** The session feature's public surface: one screen, one hook call. */

export {
  COMPOSER_CHROME_ROWS,
  type ComposerMetrics,
  OVERLAY_RESERVE_ROWS,
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
export type { AppCommandId } from './composer/slash-commands.ts';
export {
  SessionPrompts,
  type SessionState,
  TRANSCRIPT_KEYS,
  Transcript,
} from './transcript/index.ts';
