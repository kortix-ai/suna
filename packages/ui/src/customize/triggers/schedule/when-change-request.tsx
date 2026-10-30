'use client';

import { useTranslations } from '../../../i18n';
import { Input } from '../../../primitives/input';
import { Label } from '../../../primitives/label';
import type { PatchDraft } from './composer-parts';
import type { ComposerDraft } from './trigger-composer-logic';

/**
 * When: a change request of the project merges. An empty branch fires on every
 * merge; a branch fires on merges into it only (kortix.yaml `filter.base`).
 */
export function WhenChangeRequest({ draft, patch }: { draft: ComposerDraft; patch: PatchDraft }) {
  const t = useTranslations('triggerComposer');
  return (
    <div className="space-y-1.5">
      <Label htmlFor="trigger-cr-branch" className="text-xs">
        {t('crBranchLabel')}
      </Label>
      <Input
        id="trigger-cr-branch"
        value={draft.crBase}
        onChange={(e) => patch({ crBase: e.target.value })}
        placeholder={t('crBranchPlaceholder')}
        maxLength={255}
        className="font-mono text-sm"
      />
      <p className="text-muted-foreground text-xs leading-relaxed text-pretty">
        {t.rich('crBranchHelp', {
          code: (chunks) => (
            <code className="bg-muted text-foreground rounded-sm px-1 py-0.5 font-mono text-xs">{chunks}</code>
          ),
        })}
      </p>
    </div>
  );
}
