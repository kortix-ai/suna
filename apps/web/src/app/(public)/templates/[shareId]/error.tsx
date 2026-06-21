'use client';

import { RouteErrorFallback } from '@/components/common/route-error';
import { useTranslations } from 'next-intl';

export default function TemplateError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <RouteErrorFallback
      {...props}
      description={tI18nHardcoded.raw(
        'autoAppPublicTemplatesShareIdErrorJsxAttrDescriptionWeCouldn8189e2ca',
      )}
    />
  );
}
