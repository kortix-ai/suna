'use client';

import { RouteErrorFallback } from '@/components/common/route-error';
import { useTranslations } from '@/i18n/use-translations';

export default function ShareError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <RouteErrorFallback
      {...props}
      description={tI18nHardcoded.raw(
        'autoAppPublicShareShareIdErrorJsxAttrDescriptionWeCouldn67117bd7',
      )}
    />
  );
}
