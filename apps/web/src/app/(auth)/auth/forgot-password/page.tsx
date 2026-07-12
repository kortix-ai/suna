'use client';

import { useTranslations } from 'next-intl';

import { MailCheck } from 'lucide-react';
import { FormEvent, Suspense, useState } from 'react';

import { AuthCardShell, BackToSignIn } from '@/features/auth/auth-card-shell';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorToast } from '@/components/ui/toast';
import { forgotPassword } from '../actions';

function ForgotPasswordContent() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMessage(null);
    setPending(true);

    const formData = new FormData(e.currentTarget);
    formData.set('origin', window.location.origin);
    const email = (formData.get('email') as string)?.trim();

    try {
      const result = await forgotPassword(null, formData);
      if (result && typeof result === 'object' && 'success' in result && result.success) {
        setSentTo(email);
        return;
      }
      const msg = (result as any)?.message || 'Could not send reset link';
      setErrorMessage(msg);
      errorToast(msg);
    } catch (err: any) {
      const msg = err?.message || 'An unexpected error occurred';
      setErrorMessage(msg);
      errorToast(msg);
    } finally {
      setPending(false);
    }
  };

  if (sentTo) {
    return (
      <AuthCardShell
        title={tHardcodedUi.raw('appAuthForgotPasswordPage.line43JsxAttrTitleCheckYourEmail')}
        description={tHardcodedUi.raw(
          'appAuthForgotPasswordPage.line44JsxAttrDescriptionWeVeSentYouAPasswordResetLink',
        )}
        footer={<BackToSignIn />}
      >
        <div className="border-border bg-muted/60 text-foreground/80 flex items-center gap-2 rounded-md border px-3 py-2.5">
          <MailCheck className="size-4 shrink-0" />
          <span className="truncate text-sm">
            {tHardcodedUi.raw('appAuthForgotPasswordPage.line50JsxTextResetLinkSentTo')}
            <span className="text-foreground">{sentTo}</span>
          </span>
        </div>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell
      title={tHardcodedUi.raw('appAuthForgotPasswordPage.line59JsxAttrTitleResetYourPassword')}
      description={tHardcodedUi.raw(
        'appAuthForgotPasswordPage.line60JsxAttrDescriptionEnterYourEmailAndWeLlSendYou',
      )}
      footer={<BackToSignIn />}
    >

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-3">
          <label htmlFor="email" className="text-muted-foreground text-sm font-medium">
            Email
          </label>
          <Input
            id="email"
            aria-invalid={!!errorMessage || undefined}
            name="email"
            type="email"
            size="md"
            placeholder="Your email address"
            required
            autoComplete="email"
            autoFocus
          />
        </div>
        <Button type="submit" size="lg" disabled={pending} className="w-full">
          {pending ? 'Sending link…' : 'Send reset link'}
        </Button>
      </form>
    </AuthCardShell>
  );
}

export default function ForgotPassword() {
  return (
    <Suspense fallback={<ConnectingScreen forceConnecting minimal title="Loading" />}>
      <ForgotPasswordContent />
    </Suspense>
  );
}
