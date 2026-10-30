'use client';

import type { ChangeRequest } from '@kortix/sdk';
import { useTranslations } from '../../../i18n';
import { translateUiCatalogText } from '../../../i18n/ui-catalog/localize-ui-catalog';
import { REMAINING_UI_TRANSLATION_KEYS } from '../../../i18n/ui-catalog/remaining-ui-translation-keys.generated';
import { Badge } from '../../../primitives/badge';

/**
 * The word for what happened to a finished change request. An open one shows
 * nothing: its state is the two buttons at the bottom of the dialog.
 *
 * A request an agent replaced (closed, with a later request on the same
 * branch) names its replacement, and opens it when the host can (KRTX-3031).
 */
export function ChangeRequestStatusBadge({
  cr,
  onOpenChangeRequest,
}: {
  cr: ChangeRequest;
  onOpenChangeRequest?: (crId: string) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  if (cr.status === 'open') return null;

  const replacement = cr.status === 'closed' ? (cr.superseded_by ?? null) : null;
  if (replacement) {
    const label = tI18nComplete('textddcd87c21894', { number: replacement.number });
    if (!onOpenChangeRequest) {
      return (
        <Badge variant="secondary" size="sm" className="mt-0.5 shrink-0">
          {label}
        </Badge>
      );
    }
    return (
      <Badge asChild variant="secondary" size="sm" className="mt-0.5 shrink-0 cursor-pointer hover:underline">
        <button type="button" onClick={() => onOpenChangeRequest(replacement.cr_id)}>
          {label}
        </button>
      </Badge>
    );
  }

  return (
    <Badge variant={cr.status === 'merged' ? 'badgeSuccess' : 'secondary'} size="sm" className="mt-0.5 shrink-0">
      {translateUiCatalogText(
        cr.status === 'merged' ? 'Applied' : 'Dismissed',
        tI18nComplete,
        REMAINING_UI_TRANSLATION_KEYS,
      )}
    </Badge>
  );
}
