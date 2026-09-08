import type { SessionSourceKind } from '@/components/projects/session-label';
import { Email } from '@/features/icon/icons/email';
import { Schedule } from '@/features/icon/icons/schedule';
import { Slack } from '@/features/icon/icons/slack';
import { Telegram } from '@/features/icon/icons/telegram';
import { WebhooksLogoIcon } from '@phosphor-icons/react';
import type { ComponentType } from 'react';

/**
 * One glyph per session source, for every surface that shows one.
 *
 * This lived twice — once in the sidebar row, once in the hover card — and the
 * copies had already drifted apart in name (`EnvelopeIcon as Mail` against a
 * bare `EnvelopeIcon`) while still resolving to the same icon. Two maps that
 * happen to agree is not the same as one map: the row and its own hover card
 * describe the same session, so a reader seeing two glyphs for it would have no
 * way to tell which one was true.
 *
 * `chat` is deliberately absent. It is the fallback every session lands in when
 * nothing else claims it, and it renders no icon at all — the `Exclude` makes
 * that a type error rather than a blank square.
 */
export const SOURCE_ICONS: Record<
  Exclude<SessionSourceKind, 'chat'>,
  ComponentType<{ className?: string }>
> = {
  slack: Slack,
  telegram: Telegram,
  email: Email,
  schedule: Schedule,
  webhook: WebhooksLogoIcon,
};
