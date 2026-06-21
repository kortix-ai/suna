'use client';

import { SecretIntakeForm } from '@/components/setup-links/secret-intake-form';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';

export default function SecretIntakePage() {
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
              {tI18nHardcoded.raw('autoAppPublicSecretIntakeTokenPageJsxTextAddA71a8394a')}
            </CardTitle>
            <CardDescription>
              {tI18nHardcoded.raw('autoAppPublicSecretIntakeTokenPageJsxTextYourKortix7bc8f4ee')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SecretIntakeForm token={token} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
