'use client';

import { useTranslations } from 'next-intl';

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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const dismissKey = updatedAt 
    ? `technical-issue-${updatedAt}` 
    : `technical-issue-${message.slice(0, 20)}`;

  return (
    <AlertBanner
      title={tHardcodedUi.raw('componentsAnnouncementsTechnicalIssueBanner.line23JsxAttrTitleTechnicalIssue')}
      message={message}
      variant="error"
      icon={AlertTriangle}
      dismissKey={dismissKey}
      statusUrl={statusUrl}
      statusLabel={tHardcodedUi.raw('componentsAnnouncementsTechnicalIssueBanner.line29JsxAttrStatuslabelViewStatus')}
    />
  );
}
