import { AlertTriangle } from 'lucide-react';

import { InfoBanner } from '@/components/ui/info-banner';

export function LegacyBanner({
  feature,
  message,
}: {
  feature: string;
  message?: string;
}) {
  return (
    <InfoBanner
      tone="warning"
      icon={AlertTriangle}
      title={`${feature} is legacy — not wired to the current backend`}
    >
      {message ??
        'This page is UI from the old platform. Treat any data here as stale — it will be reimplemented against the current backend.'}
    </InfoBanner>
  );
}
