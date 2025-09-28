'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Loader2 } from 'lucide-react';

interface AuthMessage {
  type: 'github-auth-success' | 'github-auth-error';
  message?: string;
  returnUrl?: string;
}

export default function GitHubOAuthPopup() {
  const [status, setStatus] = useState<'loading' | 'processing' | 'error'>(
    'loading',
  );
  const [errorMessage, setErrorMessage] = useState<string>('');

  useEffect(() => {
    const supabase = createClient();

    // Get return URL from sessionStorage (set by parent component)
    const returnUrl =
      sessionStorage.getItem('github-returnUrl') || '/dashboard';

    const postMessage = (message: AuthMessage) => {
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(message, window.location.origin);
        }
      } catch (err) {
        console.error('Failed to post message to opener:', err);
      }
    };

    const handleSuccess = () => {
      setStatus('processing');
      postMessage({
        type: 'github-auth-success',
        returnUrl,
      });

      // Close popup after short delay
      setTimeout(() => {
        window.close();
      }, 500);
    };

    const handleError = (message: string) => {
      setStatus('error');
      setErrorMessage(message);
      postMessage({
        type: 'github-auth-error',
        message,
      });

      // Close popup after delay to show error
      setTimeout(() => {
        window.close();
      }, 2000);
    };

    const handleOAuth = async () => {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const isCallback = urlParams.has('code');
        const hasError = urlParams.has('error');

        // Handle OAuth errors
        if (hasError) {
          const error = urlParams.get('error');
          const errorDescription = urlParams.get('error_description');
          throw new Error(errorDescription || error || 'GitHub OAuth error');
        }

        if (isCallback) {
          // This is the callback from GitHub
          setStatus('processing');

          try {
            // Wait a moment for Supabase to process the session
            await new Promise((resolve) => setTimeout(resolve, 1000));

            const {
              data: { session },
              error,
            } = await supabase.auth.getSession();

            if (error) {
              throw error;
            }

            if (session?.user) {
              handleSuccess();
              return;
            }

            // If no session yet, listen for auth state change
            const {
              data: { subscription },
            } = supabase.auth.onAuthStateChange(async (event, session) => {
              if (event === 'SIGNED_IN' && session?.user) {
                subscription.unsubscribe();
                handleSuccess();
              } else if (event === 'SIGNED_OUT') {
                subscription.unsubscribe();
                handleError('Authentication failed - please try again');
              }
            });

            // Cleanup subscription after timeout
            setTimeout(() => {
              subscription.unsubscribe();
              handleError('Authentication timeout - please try again');
            }, 10000); // 10 second timeout
          } catch (authError: any) {
            console.error('Auth processing error:', authError);
            handleError(authError.message || 'Authentication failed');
          }
        } else {
          // Start the OAuth flow
          setStatus('loading');

          const { error } = await supabase.auth.signInWithOAuth({
            provider: 'github',
            options: {
              redirectTo: `${window.location.origin}/auth/github-popup`,
              queryParams: {
                access_type: 'online',
                prompt: 'select_account',
              },
            },
          });

          if (error) {
            throw error;
          }
        }
      } catch (err: any) {
        console.error('OAuth error:', err);
        handleError(err.message || 'Failed to authenticate with GitHub');
      }
    };

    // Cleanup sessionStorage when popup closes
    const handleBeforeUnload = () => {
      sessionStorage.removeItem('github-returnUrl');
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    // Start OAuth process
    handleOAuth();

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  const getStatusMessage = () => {
    switch (status) {
      case 'loading':
        return 'Starting GitHub authentication...';
      case 'processing':
        return 'Completing sign-in...';
      case 'error':
        return errorMessage || 'Authentication failed';
      default:
        return 'Processing...';
    }
  };

  const getStatusColor = () => {
    switch (status) {
      case 'error':
        return 'text-red-500';
      case 'processing':
        return 'text-green-500';
      default:
        return 'text-muted-foreground';
    }
  };

  return (
    <main className="flex flex-col items-center justify-center h-screen bg-background p-8">
      <div className="flex flex-col items-center gap-4 text-center max-w-sm">
        {status !== 'error' && (
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        )}

        <div className="space-y-2">
          <h1 className="text-lg font-medium">GitHub Sign-In</h1>
          <p className={`text-sm ${getStatusColor()}`}>{getStatusMessage()}</p>
        </div>

        {status === 'error' && (
          <button
            onClick={() => window.close()}
            className="mt-4 px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            Close
          </button>
        )}
      </div>
    </main>
  );
}