'use client';

import { useTranslations } from '@/i18n/use-translations';

import type { EventApp } from './event-trigger-copy';
import { eventAppSource } from './trigger-composer-logic';

/** "3 events", or for an MCP app not connected yet, that its events come with the connection (its list and search tools). */
export function EventCount({ app }: { app: EventApp }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tComposer = useTranslations('triggerComposer');
  return eventAppSource(app) === 'mcp' && app.event_count === 0 && !app.connected
    ? tComposer('mcpEventsOnConnect')
    : tI18nComplete('text6e4a170bdf81', { count: app.event_count });
}

