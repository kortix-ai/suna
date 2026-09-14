'use client';

import { SystemFaultView } from '@/components/common/system-fault';
import { useTranslations } from '@/i18n/use-translations';

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta
          name="viewport"
          content={"width=device-width, initial-scale=1"}
        />
        <title>{tI18nHardcoded.raw('autoAppGlobalErrorJsxTextSystemFaulta2da19e4')}</title>
      </head>
      <body style={{ margin: 0 }}>
        <SystemFaultView error={error} />
      </body>
    </html>
  );
}
