'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useTheme } from 'next-themes';

interface MicrosoftSignInProps {
  returnUrl?: string;
}

export default function MicrosoftSignIn({ returnUrl }: MicrosoftSignInProps) {
  const [isLoading, setIsLoading] = useState(false);
  const { resolvedTheme } = useTheme();

  const handleMicrosoftSignIn = async () => {
    try {
      setIsLoading(true);
      const supabase = createClient();

      console.log('Starting Microsoft sign in process');

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'azure',
        options: {
          scopes: 'email',
          redirectTo: `${window.location.origin}/auth/callback?returnUrl=${encodeURIComponent(returnUrl || '/dashboard')}`,
        },
      });

      if (error) throw error;

      console.log('Microsoft sign in initiated, redirecting to Azure...');
    } catch (error) {
      console.error('Error signing in with Microsoft:', error);
      setIsLoading(false);
    }
  };

  return (
    <button
      onClick={handleMicrosoftSignIn}
      disabled={isLoading}
      className="w-full h-12 flex items-center justify-center gap-2 text-sm font-medium tracking-wide rounded-full bg-background border border-border hover:bg-accent/20 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <svg className="w-5 h-5" viewBox="0 0 24 24">
        <path
          d="M11.4 24H0V12.6h11.4V24zM24 24H12.6V12.6H24V24zM11.4 11.4H0V0h11.4v11.4zM24 11.4H12.6V0H24v11.4z"
          fill={resolvedTheme === 'dark' ? '#ffffff' : '#f25022'}
        />
      </svg>
      {isLoading ? 'Signing in...' : 'Continue with Microsoft'}
    </button>
  );
} 