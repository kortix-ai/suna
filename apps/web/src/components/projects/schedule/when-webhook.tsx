'use client';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { ArrowsClockwiseIcon } from '@phosphor-icons/react';

import { InlineError, type PatchDraft } from './composer-parts';
import { type ComposerDraft, generateSigningKey } from './trigger-composer-logic';

/** When: another app calls a private address. The signing key proves the caller. */
export function WhenWebhook({
  draft,
  patch,
  error,
}: {
  draft: ComposerDraft;
  patch: PatchDraft;
  error?: string;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="space-y-2">
      <Label htmlFor="trigger-signing-key" className="text-foreground">
        {tI18nComplete.raw('text49395b9594c2')}
      </Label>
      <div className="flex gap-2">
        <Input
          id="trigger-signing-key"
          value={draft.signingKey}
          onChange={(e) => patch({ signingKey: e.target.value })}
          placeholder={tI18nComplete.raw('text74414cb4f277')}
          aria-invalid={error ? true : undefined}
          className="font-mono text-sm"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 shrink-0 gap-1.5"
          onClick={() => patch({ signingKey: generateSigningKey() })}
        >
          <ArrowsClockwiseIcon className="size-3.5 shrink-0" />
          {tI18nComplete.raw('text49e49bb4401e')}
        </Button>
      </div>
      <InlineError message={error} />
      <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
        {tI18nComplete.raw('textcbdd5dc3da21')}
      </p>
      <InfoBanner tone="info" className="text-xs">
        {tI18nComplete.raw('textc22e9b2269f5')}
      </InfoBanner>
    </div>
  );
}
