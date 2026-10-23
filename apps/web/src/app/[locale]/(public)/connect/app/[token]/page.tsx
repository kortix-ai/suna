'use client';

import { AppCredentialsForm } from '@/components/setup-links/app-credentials-form';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useTranslations } from '@/i18n/use-translations';
import { useParams } from 'next/navigation';

/** The quiet auth frame, like `/connect/[token]`: mark, left-aligned heading, the form. */
export default function ConnectAppPage() {
  const t = useTranslations('connectAppForm');
  const params = useParams();
  const token = Array.isArray(params.token) ? params.token[0] : (params.token as string);

  return (
    <AuthFrame footerVariant="none">
      <Rise>
        <StepHeader title={t.raw('title')} description={t.raw('description')} />
      </Rise>
      <Rise delay={0.06}>
        <AppCredentialsForm token={token} />
      </Rise>
    </AuthFrame>
  );
}
