import React from 'react';
import { AlertTriangle } from 'lucide-react-native';
import { AlertBanner } from './AlertBanner';

interface TechnicalIssueBannerProps {
  message: string;
  statusUrl?: string;
  description?: string;
  estimatedResolution?: string;
  severity?: 'degraded' | 'outage' | 'maintenance';
  affectedServices?: string[];
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
    />
  );
}
