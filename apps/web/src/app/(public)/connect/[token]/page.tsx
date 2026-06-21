'use client';

import { ConnectorIntake } from '@/components/setup-links/connector-intake';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';

export default function ConnectIntakePage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const params = useParams();
  const token = Array.isArray(params.token) ? params.token[0] : (params.token as string);

  return (
    <div className="bg-background flex min-h-screen w-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <KortixLogo />
        </div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {tI18nHardcoded.raw('autoAppPublicConnectTokenPageJsxTextConnectAnApp4c6083f8')}
            </CardTitle>
            <CardDescription>
              {tI18nHardcoded.raw('autoAppPublicConnectTokenPageJsxTextYourKortixAgent6efa22e3')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ConnectorIntake token={token} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
