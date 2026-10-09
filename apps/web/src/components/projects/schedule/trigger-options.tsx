'use client';

import { Disclosure, DisclosureContent } from '@/components/ui/disclosure';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { SharingPicker } from '@/features/workspace/shared/sharing-picker';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { PROJECT_SESSION_NAME_LOOKUP_LIMIT, listProjectSessions } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import { FoldTrigger, InlineError, type PatchDraft } from './composer-parts';
import { ConditionsEditor, RunLocationFields } from './schedule-fields';
import { type ComposerDraft, slugify } from './trigger-composer-logic';
import { triggerSessionAccessCopy } from './trigger-session-access-copy';

function OptionField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <p className="text-foreground text-sm font-medium">{label}</p>
      {children}
      {hint ? (
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">{hint}</p>
      ) : null}
    </section>
  );
}

/** Options: everything with a sane default, folded away until asked for. */
export function TriggerOptions({
  projectId,
  draft,
  patch,
  name,
  open,
  onOpenChange,
  error,
}: {
  projectId: string;
  draft: ComposerDraft;
  patch: PatchDraft;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  error?: string;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const sessions = useQuery({
    queryKey: qk.project.sessions(projectId),
    queryFn: () => listProjectSessions(projectId, { limit: PROJECT_SESSION_NAME_LOOKUP_LIMIT }),
    enabled: draft.mode === 'pinned',
    ...contract('inventory'),
  });
  const isCron = draft.kind === 'cron';
  return (
    <Disclosure className="group" open={open} onOpenChange={onOpenChange}>
      <FoldTrigger>{tI18nComplete.raw('textd0db8b5e364b')}</FoldTrigger>
      <DisclosureContent>
        <div className="space-y-6 pt-4">
          <OptionField
            label={tI18nComplete.raw('text345e6cf10469')}
            hint={tI18nComplete.raw('text319d909352ff')}
          >
            <RunLocationFields
              mode={draft.mode}
              onModeChange={(mode) =>
                patch({
                  mode,
                  ...(mode !== 'pinned' ? { pinnedSessionId: null } : {}),
                  ...(mode !== 'keyed' ? { sessionKey: '' } : {}),
                })
              }
              pinnedSessionId={draft.pinnedSessionId}
              onPinnedSessionChange={(pinnedSessionId) => patch({ pinnedSessionId })}
              sessionKey={draft.sessionKey}
              onSessionKeyChange={(sessionKey) => patch({ sessionKey })}
              sessions={sessions.data ?? []}
              sessionsLoading={sessions.isLoading}
            />
            <InlineError message={error} />
          </OptionField>

          <OptionField
            label={tI18nComplete.raw('textbc9424d3f527')}
            hint={tI18nComplete.raw('text8493c3761028')}
          >
            <SharingPicker
              projectId={projectId}
              value={draft.sessionAccess}
              onChange={(sessionAccess) => patch({ sessionAccess })}
              showHeading={false}
              copy={triggerSessionAccessCopy(tI18nComplete)}
            />
          </OptionField>

          {!isCron && (
            <OptionField
              label={tI18nComplete.raw('text94c7226773af')}
              hint={tI18nComplete.raw('text8e47e838d897')}
            >
              <ConditionsEditor
                rows={draft.conditions}
                onChange={(conditions) => patch({ conditions })}
              />
            </OptionField>
          )}

          {draft.kind === 'webhook' && (
            <OptionField
              label={tI18nComplete.raw('text301cd463a175')}
              hint={tI18nComplete.raw('text432020e4f157')}
            >
              <Input
                value={draft.secretName}
                onChange={(e) => patch({ secretName: e.target.value.toUpperCase() })}
                placeholder="WEBHOOK_MY_TRIGGER_SECRET"
                className="font-mono text-sm"
              />
            </OptionField>
          )}

          <OptionField
            label={tI18nComplete.raw('text7396f100afdf')}
            hint={
              isCron ? tI18nComplete.raw('textfb2536db879a') : tI18nComplete.raw('text9f2198f23b84')
            }
          >
            <Input
              value={draft.customId}
              onChange={(e) => patch({ customId: e.target.value })}
              placeholder={name.trim() ? slugify(name.trim()) : 'daily-standup-digest'}
              maxLength={128}
              className="font-mono text-sm"
            />
          </OptionField>

          <OptionField
            label={tI18nComplete.raw('textd90c143bf007')}
            hint={tI18nComplete.raw('textbed03adbb73f')}
          >
            <div className="bg-card flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
              <Label htmlFor="trigger-start-active" className="text-sm font-normal">
                {draft.startActive ? 'Active' : 'Paused'}
              </Label>
              <Switch
                id="trigger-start-active"
                checked={draft.startActive}
                onCheckedChange={(startActive) => patch({ startActive })}
              />
            </div>
          </OptionField>
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}
