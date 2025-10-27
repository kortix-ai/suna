'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function MasterLoginPage() {
  const [email, setEmail] = useState('');
  const [masterPassword, setMasterPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/admin/master-login/authenticate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          master_password: masterPassword,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Authentication failed');
      }

      const data = await response.json();
      
      console.log('Response data:', data);
      
      if (data.action_link) {
        console.log('Raw action_link:', data.action_link);
        const url = new URL(data.action_link);
        console.log('Action link URL:', url.href);
        console.log('Hash:', url.hash);
        console.log('Hash length:', url.hash.length);
        
        const hash = url.hash.substring(1);
        console.log('Hash after substring:', hash);
        console.log('Hash substring length:', hash.length);
        
        const params = new URLSearchParams(hash);
        console.log('All params:', Array.from(params.entries()));
        
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');
        
        console.log('Extracted tokens:', { 
          hasAccess: !!accessToken, 
          hasRefresh: !!refreshToken,
          accessTokenStart: accessToken?.substring(0, 20),
          refreshToken: refreshToken
        });
        
        if (accessToken && refreshToken) {
          console.log('Setting session with extracted tokens...');
          const supabase = createClient();
          const { error: sessionError, data: sessionData } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });

          if (sessionError) {
            console.error('Session error:', sessionError);
            throw new Error(`Failed to set session: ${sessionError.message}`);
          }

          console.log('Session set successfully!', sessionData);
          console.log('Redirecting to dashboard...');
          window.location.href = '/dashboard';
        } else {
          console.warn('No tokens found in hash, redirecting to action_link');
          window.location.href = data.action_link;
        }
      } else if (data.access_token && data.refresh_token) {
        const supabase = createClient();
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
        });

        if (sessionError) {
          throw new Error(`Failed to set session: ${sessionError.message}`);
        }

        window.location.href = '/dashboard';
      } else {
        throw new Error('No authentication method provided in response');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-md space-y-6 p-8">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-bold">Master Password Login</h1>
          <p className="text-muted-foreground">
            Admin access to any user account
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium">
              User Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2 border border-input rounded-md bg-background text-foreground"
              placeholder="user@example.com"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="master-password" className="text-sm font-medium">
              Master Password
            </label>
            <input
              id="master-password"
              type="password"
              value={masterPassword}
              onChange={(e) => setMasterPassword(e.target.value)}
              required
              className="w-full px-3 py-2 border border-input rounded-md bg-background text-foreground"
              placeholder="Enter master password"
            />
          </div>

          {error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 px-4 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Authenticating...' : 'Login as User'}
          </button>
        </form>

        <div className="text-center text-xs text-muted-foreground">
          <p>⚠️ This is an admin-only feature</p>
          <p>Works with both OAuth and standard users</p>
        </div>
      </div>
    </div>
  );
}

