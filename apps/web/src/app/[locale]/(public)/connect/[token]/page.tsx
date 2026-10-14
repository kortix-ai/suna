'use client';

import { ConnectorIntake } from '@/components/setup-links/connector-intake';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useTranslations } from '@/i18n/use-translations';
import { useParams } from 'next/navigation';

/** The quiet auth frame, like `/approve/[token]`: mark, left-aligned heading, the connect step. */
export default function ConnectIntakePage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const params = useParams();
  const token = Array.isArray(params.token) ? params.token[0] : (params.token as string);

  return (
    <AuthFrame footerVariant="none">
      <Rise>
        <StepHeader
          title={tI18nHardcoded.raw('autoAppPublicConnectTokenPageJsxTextConnectAnApp4c6083f8')}
          description={tI18nHardcoded.raw(
            'autoAppPublicConnectTokenPageJsxTextYourKortixAgent6efa22e3',
          )}
        />
      </Rise>
      <Rise delay={0.06}>
        <ConnectorIntake token={token} compact />
      </Rise>
    </AuthFrame>
  );
}
