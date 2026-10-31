'use client';

import type { App } from '@kortix/sdk';

import { useTranslations } from '../../../i18n';
import { Input } from '../../../primitives/input';
import { Label } from '../../../primitives/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../primitives/select';
import { InlineError, type PatchDraft } from './composer-parts';
import type { ComposerDraft } from './trigger-composer-logic';

const APP_ERROR_ID = 'trigger-kortix-app-error';

/**
 * When: one of the project's Kortix Apps sends an event. The App posts it to
 * `KORTIX_APP_EVENTS_URL` with its `KORTIX_APP_TOKEN`; an empty event name
 * fires on every event of the App.
 */
export function WhenApp({
  apps,
  draft,
  patch,
  error,
}: {
  /** The project's Apps that can send events. */
  apps: App[];
  draft: ComposerDraft;
  patch: PatchDraft;
  error?: string;
}) {
  const t = useTranslations('triggerComposer');
  // A saved trigger whose App is gone still shows its slug, so the form never reads as blank.
  const unknown = draft.kortixApp && !apps.some((app) => app.slug === draft.kortixApp);
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="trigger-kortix-app" className="text-xs">
          {t('appLabel')}
        </Label>
        <Select value={draft.kortixApp ?? ''} onValueChange={(kortixApp) => patch({ kortixApp })}>
          <SelectTrigger
            id="trigger-kortix-app"
            className="w-full cursor-pointer text-sm"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? APP_ERROR_ID : undefined}
          >
            <SelectValue placeholder={t('appPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {unknown ? (
              <SelectItem value={draft.kortixApp!} className="cursor-pointer">
                {draft.kortixApp}
              </SelectItem>
            ) : null}
            {apps.map((app) => (
              <SelectItem key={app.app_id} value={app.slug} className="cursor-pointer">
                {app.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <InlineError id={APP_ERROR_ID} message={error} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="trigger-app-event" className="text-xs">
          {t('appEventLabel')}
        </Label>
        <Input
          id="trigger-app-event"
          value={draft.appEvent}
          onChange={(e) => patch({ appEvent: e.target.value })}
          placeholder={t('appEventPlaceholder')}
          maxLength={128}
          className="font-mono text-sm"
        />
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
          {t.rich('appEventHelp', {
            code: (chunks) => (
              <code className="bg-muted text-foreground rounded-sm px-1 py-0.5 font-mono text-xs">
                {chunks}
              </code>
            ),
          })}
        </p>
      </div>
    </div>
  );
}
