'use client';

import { AlertTriangle } from 'lucide-react';
import { AlertBanner } from './alert-banner';

interface TechnicalIssueBannerProps {
  message: string;
  statusUrl?: string;
  updatedAt?: string;
}

export function TechnicalIssueBanner({
  message,
  statusUrl,
  updatedAt,
}: TechnicalIssueBannerProps) {
  const dismissKey = updatedAt 
    ? `technical-issue-${updatedAt}` 
    : `technical-issue-${message.slice(0, 20)}`;

  return (
    <AlertBanner
      title="Technical Issue"
      message={message}
      variant="error"
      icon={AlertTriangle}
      dismissKey={dismissKey}
      statusUrl={statusUrl}
      statusLabel="View Status"
    />
  );
}
