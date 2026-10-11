'use client';

import { Disclosure, DisclosureContent } from '@/components/ui/disclosure';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslations } from '@/i18n/use-translations';
import type { ProjectTrigger } from '@kortix/sdk';
import { buildWebhookSampleRequest } from '@kortix/shared';
import { useMemo } from 'react';

import { FoldTrigger, type PatchDraft } from './composer-parts';
import { describeSecurity } from './schedule-copy';
import { CopyBlock } from './schedule-fields';
import type { ComposerDraft } from './trigger-composer-logic';

/** When, for a saved webhook: the address to give the other app, and the saved secret that signs it. */
export function WhenWebhookAddress({
  trigger,
  draft,
  patch,
  canWrite,
}: {
  trigger: ProjectTrigger;
  draft: ComposerDraft;
  patch: PatchDraft;
  canWrite: boolean;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const url = trigger.webhook_url ?? '';
  const sample = useMemo(() => buildWebhookSampleRequest(url), [url]);
  const security = describeSecurity(trigger, t);
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
          {t.raw('text8e3784778668')}
        </p>
        <CopyBlock
          value={url}
          label={t.raw('text7c4e5224f9d4')}
          copiedLabel={t.raw('texta26175817712')}
        />
      </div>

      <InfoBanner tone={security.signed ? 'success' : 'warning'} className="text-xs">
        {security.detail}
      </InfoBanner>

      {canWrite ? (
        <div className="space-y-1.5">
          <Label htmlFor="webhook-signing-key">{t.raw('text49395b9594c2')}</Label>
          <Input
            id="webhook-signing-key"
            value={draft.secretName}
            onChange={(e) => patch({ secretName: e.target.value.toUpperCase() })}
            placeholder="WEBHOOK_MY_TRIGGER_SECRET"
            className="font-mono text-sm"
          />
          <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
            {t.raw('texte5c253036018')}
          </p>
        </div>
      ) : null}

      <Disclosure className="group">
        <FoldTrigger>{t.raw('text4b8aec6e6cd2')}</FoldTrigger>
        <DisclosureContent>
          <div className="space-y-2 pt-2">
            <CopyBlock
              value={sample}
              multiline
              label={t.raw('text87365b87dda3')}
              copiedLabel={t.raw('textc6092ea6beec')}
            />
            <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
              {t.raw('text75110f412649')}
            </p>
          </div>
        </DisclosureContent>
      </Disclosure>
    </div>
  );
}
