'use client';

import { useTranslations } from 'next-intl';

import React from 'react';
import { SecretsManager } from '@/components/secrets/secrets-manager';

export default function SecretsPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="container mx-auto max-w-4xl px-3 sm:px-4 py-4 sm:py-8">
      <div className="space-y-4">
        <div>
          <h1 className="text-lg sm:text-xl font-semibold">{tHardcodedUi.raw('componentsPagesSettingsCredentialsPage.line11JsxTextSecretsManager')}</h1>
          <p className="text-sm text-muted-foreground mt-1">{tHardcodedUi.raw('componentsPagesSettingsCredentialsPage.line13JsxTextManageEnvironmentVariablesAndApiKeysForYour')}</p>
        </div>
        <div className="border rounded-2xl">
          <SecretsManager />
        </div>
      </div>
    </div>
  );
}
