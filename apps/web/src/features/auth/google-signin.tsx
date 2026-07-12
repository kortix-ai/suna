'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { authRedirectUrl } from '@/lib/desktop';
import { createClient } from '@/lib/supabase/client';
import { toast } from '@/lib/toast';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Icon } from '../icon/icon';

interface GoogleSignInProps {
  returnUrl?: string;
  referralCode?: string;
  mobileCallbackState?: string;
}

export default function GoogleSignIn({
  returnUrl,
  referralCode,
  mobileCallbackState,
}: GoogleSignInProps) {
  const [isLoading, setIsLoading] = useState(false);
  const supabase = createClient();
  const t = useTranslations('auth');

  const handleGoogleSignIn = async () => {
    try {
      setIsLoading(true);

      if (referralCode) {
        document.cookie = `pending-referral-code=${referralCode.trim().toUpperCase()}; path=/; max-age=600; SameSite=Lax`;
      }

      const callbackParams = new URLSearchParams();
      if (returnUrl) callbackParams.set('returnUrl', returnUrl);
      if (mobileCallbackState) {
        callbackParams.set('mobile_callback', '1');
        callbackParams.set('state', mobileCallbackState);
      }
      const callbackPath = `${mobileCallbackState ? '/auth/mobile/callback' : '/auth/callback'}${callbackParams.size ? `?${callbackParams.toString()}` : ''}`;
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          // Desktop: bounce back via the kortix:// scheme so the OS hands
          // the callback to the desktop app. The OAuth navigation itself is
          // intercepted by the Tauri shell and opened in the system browser
          // (Google rejects embedded webviews with `disallowed_useragent`).
          redirectTo: authRedirectUrl(callbackPath),
        },
      });

      if (error) {
        throw error;
      }
    } catch (error: any) {
      console.error('Google sign-in error:', error);
      toast.error(error.message || 'Failed to sign in with Google');
      setIsLoading(false);
    }
  };

  return (
    <Button
      onClick={handleGoogleSignIn}
      disabled={isLoading}
      variant="secondary"
      size="lg"
      className="w-full"
      type="button"
    >
      {isLoading ? <Loading /> : <Icon.NewGoogle className="h-4 w-4" />}
      <span>{isLoading ? t('signingIn') : t('continueWithGoogle')}</span>
    </Button>
  );
}
