'use client';

/**
 * The runtime half of the Triggers page: triggers stored in the database, not
 * kortix.yaml — loops, and rows an agent or the CLI created with
 * `POST /triggers/runtime`. Each row reads as name, source, target, next run, last
 * run, on/off. The kortix.yaml half above it keeps its own editor; a runtime
 * row only pauses, runs once, or goes.
 *
 * It renders nothing while the project has none, so a project without runtime
 * triggers sees the page it saw before.
 */
import type { UnifiedTrigger } from '@kortix/sdk';
import { useUnifiedTriggers } from '@kortix/sdk/react';
import { PlayIcon, TrashIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { relativeTime } from '../../internal/lib/relative-time';
import { Button } from '../../primitives/button';
import { ButtonGroup } from '../../primitives/button-group';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { Hint } from '../../primitives/hint';
import { InlineMeta } from '../../primitives/inline-meta';
import { Label } from '../../primitives/label';
import Loading from '../../primitives/loading';
import { Switch } from '../../primitives/switch';
import { errorToast } from '../../primitives/toast';

/** Source labels: the strings the trigger kinds already show, plus the merge. */
const SOURCE_KEY: Record<UnifiedTrigger['source']['type'], string> = {
  schedule: 'textf4830a1dae29',
  webhook: 'text4814f62c108d',
  event: 'textca395c4d19b2',
  app: 'text5441e7146193',
  change_request: 'text5ffd973e20ed',
};

/** `true` for a row this page lists: runtime, and (on an agent's page) one that starts that agent. */
export function runtimeRowsFor(triggers: readonly UnifiedTrigger[], agentName: string | null): UnifiedTrigger[] {
  return triggers.filter(
    (a) => a.origin === 'runtime' && (!agentName || (a.target.kind === 'agent' && a.target.agent === agentName)),
  );
}

function scheduleText(source: UnifiedTrigger['source']): string | null {
  if (source.type !== 'schedule') return null;
  return source.cron ?? source.every ?? null;
}

export function RuntimeTriggers({ projectId, agentName = null }: { projectId: string; agentName?: string | null }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const triggers = useUnifiedTriggers(projectId);
  const [deleteTarget, setDeleteTarget] = useState<UnifiedTrigger | null>(null);
  const rows = runtimeRowsFor(triggers.data?.triggers ?? [], agentName);
  if (rows.length === 0) return null;

  const onError = (error: unknown) => errorToast((error as Error)?.message ?? String(error));
  const target = (a: UnifiedTrigger) =>
    a.target.kind === 'session'
      ? t('text89919c510d89', { value0: a.target.session_name || a.target.session_id.slice(0, 8) })
      : a.target.kind === 'agent'
        ? t('textba6393ea2b12', { value0: a.target.agent })
        : t('textd7846b4e605e', { value0: a.target.app });

  return (
    <section className="space-y-2 pt-4">
      <div className="space-y-0.5">
        <Label>{t.raw('text41bec5c0977c')}</Label>
        <p className="text-muted-foreground text-xs">{t.raw('text8898c02a816e')}</p>
      </div>
      <ul className="space-y-2">
        {rows.map((a) => {
          const busy =
            (triggers.update.isPending && triggers.update.variables?.triggerId === a.id) ||
            (triggers.run.isPending && triggers.run.variables?.triggerId === a.id);
          return (
            <li key={a.id} className="bg-popover flex items-center gap-3 rounded-md border px-4 py-2">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-foreground truncate text-sm font-medium">{a.name ?? a.prompt}</p>
                <InlineMeta>
                  <span>{t.raw(SOURCE_KEY[a.source.type])}</span>
                  {scheduleText(a.source) ? <span className="font-mono">{scheduleText(a.source)}</span> : null}
                  <span className="truncate">{target(a)}</span>
                  {a.state === 'active' && a.next_fire_at ? (
                    <span>
                      {t.raw('textb3c0ab96930c')} {relativeTime(a.next_fire_at, locale)}
                    </span>
                  ) : null}
                  <span>
                    {t.raw('text512a48218ba2')}{' '}
                    {a.last_fired_at ? relativeTime(a.last_fired_at, locale) : t.raw('text6300ef800bb8')}
                  </span>
                </InlineMeta>
                {a.last_error ? <p className="text-destructive truncate text-xs">{a.last_error}</p> : null}
              </div>
              {busy ? <Loading className="size-4 shrink-0" /> : null}
              <Switch
                checked={a.state === 'active'}
                disabled={a.state === 'done' || busy}
                aria-label={a.state === 'active' ? t.raw('text858e4ba7a29f') : t.raw('textd640c7421da0')}
                onCheckedChange={(enabled) =>
                  triggers.update.mutate({ triggerId: a.id, enabled }, { onError })
                }
              />
              <ButtonGroup>
                <Hint label={t.raw('text0991397702fa')}>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t.raw('text0991397702fa')}
                    disabled={busy}
                    onClick={() => triggers.run.mutate({ triggerId: a.id }, { onError })}
                  >
                    <PlayIcon className="size-4 shrink-0" />
                  </Button>
                </Hint>
                <Hint label={t.raw('texte2d0a54968ea')}>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t.raw('texte2d0a54968ea')}
                    onClick={() => setDeleteTarget(a)}
                  >
                    <TrashIcon className="size-4 shrink-0" />
                  </Button>
                </Hint>
              </ButtonGroup>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        title={t.raw('text08a462df4350')}
        description={t.raw('textf4f30f5b483c')}
        confirmLabel={t.raw('texte2d0a54968ea')}
        confirmVariant="destructive"
        isPending={triggers.remove.isPending}
        onConfirm={() =>
          deleteTarget &&
          triggers.remove.mutate(
            { triggerId: deleteTarget.id },
            { onError, onSettled: () => setDeleteTarget(null) },
          )
        }
      />
    </section>
  );
}
