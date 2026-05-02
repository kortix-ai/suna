'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { authRedirectUrl } from '@/lib/desktop';
import { toast } from '@/lib/toast';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';

function GoogleIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        d="M21.8 12.23c0-.68-.06-1.33-.17-1.95H12v3.69h5.5a4.7 4.7 0 0 1-2.04 3.08v2.56h3.3c1.93-1.78 3.04-4.4 3.04-7.38Z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.76 0 5.07-.91 6.76-2.47l-3.3-2.56c-.91.61-2.07.98-3.46.98-2.66 0-4.92-1.8-5.72-4.21H2.87v2.64A10 10 0 0 0 12 22Z"
        fill="#34A853"
      />
      <path
        d="M6.28 13.74A5.99 5.99 0 0 1 6 12c0-.6.1-1.18.28-1.74V7.62H2.87A10 10 0 0 0 2 12c0 1.61.39 3.13 1.08 4.38l3.2-2.64Z"
        fill="#FBBC05"
      />
      <path
        d="M12 6.05c1.5 0 2.84.52 3.9 1.53l2.92-2.92C17.06 2.98 14.75 2 12 2a10 10 0 0 0-9.13 5.62l3.41 2.64c.8-2.41 3.06-4.21 5.72-4.21Z"
        fill="#EA4335"
      />
    </svg>
  )
}

interface GoogleSignInProps {
  returnUrl?: string;
  referralCode?: string;
}

export default function GoogleSignIn({ returnUrl, referralCode }: GoogleSignInProps) {
  const [isLoading, setIsLoading] = useState(false);
  const supabase = createClient();
  const t = useTranslations('auth');

  const handleGoogleSignIn = async () => {
    try {
      setIsLoading(true);
      
      if (referralCode) {
        document.cookie = `pending-referral-code=${referralCode.trim().toUpperCase()}; path=/; max-age=600; SameSite=Lax`;
      }
      
      const callbackPath = `/auth/callback${returnUrl ? `?returnUrl=${encodeURIComponent(returnUrl)}` : ''}`;
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
      variant="outline"
      size="lg"
      className="w-full h-11 rounded-xl"
      type="button"
    >
      {isLoading ? (
        <KortixLoader size="small" />
      ) : (
        <GoogleIcon className="w-4 h-4" />
      )}
      <span>
        {isLoading ? t('signingIn') : t('continueWithGoogle')}
      </span>
    </Button>
  );
}
