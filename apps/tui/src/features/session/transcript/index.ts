/** The transcript feature's public surface. Nothing else in `transcript/` is
 *  imported from outside this folder. */

export {
  ErrorBanner,
  type BannerContent,
  type ErrorBannerProps,
  describeSendError,
  describeStartError,
  describeTurnError,
} from './error-banner.tsx';
export {
  TRANSCRIPT_KEYS,
  type TranscriptBindingId,
  matchesTranscriptBinding,
} from './keys.ts';
export { StepsGroup, type StepsGroupProps } from './steps-group.tsx';
export { ToolCard, type ToolCardProps } from './tool-card.tsx';
export {
  SessionPrompts,
  Transcript,
  type SessionPromptsProps,
  type SessionState,
  type TranscriptProps,
} from './transcript.tsx';
export { Turn, type TurnProps } from './turn.tsx';
export { WorkingLine, type WorkingLineProps } from './working-line.tsx';
