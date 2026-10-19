'use client';

import { SecretIntakeForm } from '@/components/setup-links/secret-intake-form';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useTranslations } from '@/i18n/use-translations';
import { useParams } from 'next/navigation';

/** The quiet auth frame, like `/approve/[token]`: mark, left-aligned heading, the form. */
export default function SecretIntakePage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const params = useParams();
  const token = Array.isArray(params.token) ? params.token[0] : (params.token as string);

  return (
    <AuthFrame footerVariant="none">
      <Rise>
        <StepHeader
          title={tI18nHardcoded.raw('autoAppPublicSecretIntakeTokenPageJsxTextAddA71a8394a')}
          description={tI18nHardcoded.raw(
            'autoAppPublicSecretIntakeTokenPageJsxTextEnterThec744a068',
          )}
        />
      </Rise>
      <Rise delay={0.06}>
        {/* The header above already states the encryption promise. */}
        <SecretIntakeForm token={token} compact />
      </Rise>
    </AuthFrame>
  );
}
