'use client';

/**
 * "Apps with events": every app that can start an agent, the project's own
 * apps first. Under the App events list, so a person sees what else they can
 * listen to. A click opens the create form on that app.
 */

import { AppLogo } from '@/components/projects/onboarding/app-logo';
import { Label } from '@/components/ui/label';
import { useTranslations } from '@/i18n/use-translations';
import { useProjectTriggerEventApps } from '@kortix/sdk/react';

import type { EventApp } from './event-trigger-copy';
import { eventAppStrip } from './trigger-filter';

export function EventAppsStrip({
  projectId,
  disabled,
  onPick,
}: {
  projectId: string;
  /** No right to create: the apps are listed, not clickable. */
  disabled: boolean;
  onPick: (app: EventApp) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const query = useProjectTriggerEventApps(projectId);
  const apps = eventAppStrip(query.data?.apps ?? []);
  if (apps.length === 0) return null;
  return (
    <section className="space-y-2" aria-label={tI18nComplete.raw('text07fb9f8661dc')}>
      <Label>{tI18nComplete.raw('text07fb9f8661dc')}</Label>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {apps.map((app) => (
          <li key={app.app}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(app)}
              className="hover:bg-accent/50 flex w-full cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors duration-fast disabled:cursor-default disabled:opacity-60"
            >
              <AppLogo src={app.logo} />
              <span className="min-w-0 flex-1">
                <span className="text-foreground block truncate text-sm font-medium">
                  {app.name}
                </span>
                <span className="text-muted-foreground block text-xs">
                  {tI18nComplete('text6e4a170bdf81', { count: app.event_count })}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
