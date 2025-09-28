'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { Icons } from './home/icons';
// Using proper GitHub brand icon from Icons component
import { useAuthMethodTracking } from '@/lib/stores/auth-tracking';
import { Loader2 } from 'lucide-react';

interface GitHubSignInProps {
  returnUrl?: string;
}

interface AuthMessage {
  type: 'github-auth-success' | 'github-auth-error';
  message?: string;
  returnUrl?: string;
}

export default function GitHubSignIn({ returnUrl }: GitHubSignInProps) {
  const [isLoading, setIsLoading] = useState(false);
  const { resolvedTheme } = useTheme();
  
  const { wasLastMethod, markAsUsed } = useAuthMethodTracking('github');

  const cleanupAuthState = useCallback(() => {
    sessionStorage.removeItem('isGitHubAuthInProgress');
    setIsLoading(false);
  }, []);

  const handleSuccess = useCallback(
    (data: AuthMessage) => {
      cleanupAuthState();

      markAsUsed();

      setTimeout(() => {
        window.location.href = data.returnUrl || returnUrl || '/dashboard';
      }, 100);
    },
    [cleanupAuthState, returnUrl, markAsUsed],
  );

  const handleError = useCallback(
    (data: AuthMessage) => {
      cleanupAuthState();
      toast.error(data.message || 'GitHub sign-in failed. Please try again.');
    },
    [cleanupAuthState],
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent<AuthMessage>) => {
      if (event.origin !== window.location.origin) {
        console.warn(
          'Rejected message from unauthorized origin:',
          event.origin,
        );
        return;
      }

      if (!event.data?.type || typeof event.data.type !== 'string') {
        return;
      }

      switch (event.data.type) {
        case 'github-auth-success':
          handleSuccess(event.data);
          break;
        case 'github-auth-error':
          handleError(event.data);
          break;
        default:
          break;
      }
    };

    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [handleSuccess, handleError]);

  useEffect(() => {
    return () => {
      cleanupAuthState();
    };
  }, [cleanupAuthState]);

  const handleGitHubSignIn = async () => {
    if (isLoading) return;

    let popupInterval: NodeJS.Timeout | null = null;

    try {
      setIsLoading(true);

      if (returnUrl) {
        sessionStorage.setItem('github-returnUrl', returnUrl || '/dashboard');
      }

      const popup = window.open(
        `${window.location.origin}/auth/github-popup`,
        'GitHubOAuth',
        'width=500,height=600,scrollbars=yes,resizable=yes,status=yes,location=yes',
      );

      if (!popup) {
        throw new Error(
          'Popup was blocked. Please enable popups and try again.',
        );
      }

      sessionStorage.setItem('isGitHubAuthInProgress', '1');

      popupInterval = setInterval(() => {
        if (popup.closed) {
          if (popupInterval) {
            clearInterval(popupInterval);
            popupInterval = null;
          }

          setTimeout(() => {
            if (sessionStorage.getItem('isGitHubAuthInProgress')) {
              cleanupAuthState();
              toast.error('GitHub sign-in was cancelled or not completed.');
            }
          }, 500);
        }
      }, 1000);
    } catch (error) {
      console.error('GitHub sign-in error:', error);
      if (popupInterval) {
        clearInterval(popupInterval);
      }
      cleanupAuthState();
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to start GitHub sign-in',
      );
    }
  };

  return (
    <div className="relative">
      <button
        onClick={handleGitHubSignIn}
        disabled={isLoading}
        className="w-full h-12 flex items-center justify-center text-sm font-medium tracking-wide rounded-full bg-background text-foreground border border-border hover:bg-accent/30 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed font-sans"
        aria-label={
          isLoading ? 'Signing in with GitHub...' : 'Sign in with GitHub'
        }
        type="button"
      >
        {isLoading ? (
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        ) : (
          <Icons.github className="w-4 h-4 mr-2" />
        )}
        <span className="font-medium">
          {isLoading ? 'Signing in...' : 'Continue with GitHub'}
        </span>
      </button>
      
      {wasLastMethod && (
        <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-background shadow-sm">
          <div className="w-full h-full bg-green-500 rounded-full animate-pulse" />
        </div>
      )}
    </div>
  );
}