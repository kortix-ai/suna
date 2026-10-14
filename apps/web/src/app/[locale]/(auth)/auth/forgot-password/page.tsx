'use client';

import { useTranslations } from '@/i18n/use-translations';

import { EnvelopeOpenIcon as MailCheck } from '@phosphor-icons/react';
import { FormEvent, Suspense, useRef, useState } from 'react';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InfoBanner } from '@/components/ui/info-banner';
import { errorToast } from '@/components/ui/toast';
import { AuthCardShell, BackToSignIn } from '@/features/auth/auth-card-shell';
import { submitAuthForm } from '@/lib/auth/submit-auth';

function ForgotPasswordContent() {
  const t = useTranslations('auth.passwordReset');
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setErrorMessage(null);
    setPending(true);

    const formData = new FormData(e.currentTarget);
    formData.set('origin', window.location.origin);
    const email = (formData.get('email') as string)?.trim();

    try {
      const outcome = await submitAuthForm('/api/auth/forgot-password', formData);
      if (outcome.ok && outcome.result.success) {
        setSentTo(email);
        return;
      }
      const message = outcome.ok ? outcome.result.message : outcome.message;
      const msg = typeof message === 'string' ? message : t('errors.sendFailed');
      setErrorMessage(msg);
      errorToast(msg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('errors.unexpected');
      setErrorMessage(msg);
      errorToast(msg);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  if (sentTo) {
    return (
      <AuthCardShell
        title={t('sent.title')}
        description={t('sent.description')}
        footer={<BackToSignIn />}
      >
        <div className="border-border bg-muted/60 text-muted-foreground flex items-center gap-2 rounded-md border px-3 py-2.5">
          <MailCheck className="size-4 shrink-0" />
          <span className="truncate text-sm">
            {t.rich('sent.address', {
              email: sentTo,
              address: (chunks) => <span className="text-foreground">{chunks}</span>,
            })}
          </span>
        </div>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell
      title={t('request.title')}
      description={t('request.description')}
      footer={<BackToSignIn />}
    >
      {errorMessage && <InfoBanner tone="destructive">{errorMessage}</InfoBanner>}
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-3">
          <label htmlFor="email" className="text-muted-foreground text-sm font-medium">
            {t('request.email')}
          </label>
          <Input
            id="email"
            aria-invalid={!!errorMessage || undefined}
            name="email"
            type="email"
            size="md"
            placeholder={t('request.emailPlaceholder')}
            required
            autoComplete="email"
            autoFocus
          />
        </div>
        <Button type="submit" size="lg" disabled={pending} className="w-full">
          {pending ? t('request.sending') : t('request.submit')}
        </Button>
      </form>
    </AuthCardShell>
  );
}

export default function ForgotPassword() {
  const t = useTranslations('auth.passwordReset');
  return (
    <Suspense fallback={<ConnectingScreen minimal title={t('loading')} />}>
      <ForgotPasswordContent />
    </Suspense>
  );
}
