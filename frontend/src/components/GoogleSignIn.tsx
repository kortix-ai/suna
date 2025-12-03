'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { Icons } from './home/icons';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';

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
      
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/auth/callback${returnUrl ? `?returnUrl=${encodeURIComponent(returnUrl)}` : ''
            }`,
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
      className="w-full h-12"
      type="button"
    >
      {isLoading ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <Icons.google className="w-4 h-4" />
      )}
      <span>
        {isLoading ? t('signingIn') : t('continueWithGoogle')}
      </span>
    </Button>
  );
}