'use client';

import { SystemFaultView } from '@/components/common/system-fault';
import { reloadForChunkLoadError } from '@/lib/chunk-load-recovery';
import { useTranslations } from '@/i18n/use-translations';
import { useEffect, useState } from 'react';

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  // A stale-deploy chunk-load failure self-heals with exactly one reload; while
  // it lands this boundary renders an empty document instead of the fault view.
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (reloadForChunkLoadError(error)) setReloading(true);
  }, [error]);

  if (reloading) return null;

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
