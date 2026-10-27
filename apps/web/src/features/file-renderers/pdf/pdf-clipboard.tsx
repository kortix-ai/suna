import { useSelectionCapability } from '@embedpdf/plugin-selection/react';
import { useEffect } from 'react';

import { errorToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { copyToClipboard } from '@/lib/utils/clipboard';

/** The upstream React utility leaves denied clipboard writes unhandled. */
export function PdfClipboard() {
  const { provides: selection } = useSelectionCapability();
  const t = useTranslations('commandPalette');

  useEffect(() => {
    if (!selection) return;
    return selection.onCopyToClipboard(({ text }) => {
      void copyToClipboard(text).then((copied) => {
        if (!copied) errorToast(t('copyFailed'));
      });
    });
  }, [selection, t]);

  return null;
}
