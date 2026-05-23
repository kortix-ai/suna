'use client';

import { useTranslations } from 'next-intl';

import { FormEvent, Suspense, useState } from 'react';
import { AlertCircle, MailCheck } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AuthCardShell, BackToSignIn } from '@/components/auth/auth-card-shell';
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
      setErrorMessage((result as any)?.message || 'Could not send reset link');
    } catch (err: any) {
      setErrorMessage(err?.message || 'An unexpected error occurred');
    } finally {
      setPending(false);
    }
  };

  if (sentTo) {
    return (
      <AuthCardShell
        title={tHardcodedUi.raw('appAuthForgotPasswordPage.line43JsxAttrTitleCheckYourEmail')}
        description={tHardcodedUi.raw('appAuthForgotPasswordPage.line44JsxAttrDescriptionWeVeSentYouAPasswordResetLink')}
        footer={<BackToSignIn />}
      >
        <div className="p-3 rounded-2xl flex items-center gap-2 bg-foreground/[0.05] border border-foreground/[0.08] text-foreground/80">
          <MailCheck className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm truncate">{tHardcodedUi.raw('appAuthForgotPasswordPage.line50JsxTextResetLinkSentTo')}<span className="text-foreground/95">{sentTo}</span>
          </span>
        </div>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell
      title={tHardcodedUi.raw('appAuthForgotPasswordPage.line59JsxAttrTitleResetYourPassword')}
      description={tHardcodedUi.raw('appAuthForgotPasswordPage.line60JsxAttrDescriptionEnterYourEmailAndWeLlSendYou')}
      footer={<BackToSignIn />}
    >
      {errorMessage && (
        <div className="mb-4 p-3 rounded-2xl flex items-center gap-2 bg-destructive/10 border border-destructive/20 text-destructive">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm">{errorMessage}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <Input
          id="email"
          name="email"
          type="email"
          placeholder={tHardcodedUi.raw('appAuthForgotPasswordPage.line75JsxAttrPlaceholderEmailAddress')}
          required
          autoComplete="email"
          className="text-sm"
        />
        <Button
          type="submit"
          size="lg"
          disabled={pending}
          className="w-full text-sm"
        >
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
