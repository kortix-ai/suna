'use client';

import { useState, useEffect, FormEvent } from 'react';
import { AlertCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { selfHostedSignIn, installOwner } from '@/app/auth/actions';
import { resetClient } from '@/lib/opencode-sdk';
import { invalidateTokenCache } from '@/lib/auth-token';
import { setBootstrapAuthToken } from '@/lib/auth-token';
import { createClient as createBrowserSupabaseClient } from '@/lib/supabase/client';
import { getEnv } from '@/lib/env-config';
import { sanitizeAuthReturnUrl } from '@/lib/auth/return-url';

/* ─── Installer Form Component ─────────────────────────────────────────────── */

interface InstallerFormProps {
  onSuccess: () => void;
  onError: (message: string) => void;
}

function InstallerForm({ onSuccess, onError }: InstallerFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pending, setPending] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    onError('');

    if (password !== confirmPassword) {
      onError('Passwords do not match');
      setPending(false);
      return;
    }

    if (password.length < 6) {
      onError('Password must be at least 6 characters');
      setPending(false);
      return;
    }

    const formData = new FormData();
    formData.append('email', email);
    formData.append('password', password);
    formData.append('confirmPassword', confirmPassword);

    try {
      const result = await installOwner(null, formData);
      if (result.success && result.accessToken) {
        setBootstrapAuthToken(result.accessToken);
        invalidateTokenCache();
        resetClient();
        onSuccess();
      } else {
        onError(result.message || 'Failed to create owner account');
      }
    } catch (err: any) {
      console.error('[InstallerForm] Error:', err);
      onError(err?.message || 'An unexpected error occurred');
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <Input
        id="install-email"
        name="email"
        type="email"
        placeholder="Email address"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="h-11 text-[15px] bg-foreground/[0.04] border-foreground/[0.08] rounded-xl shadow-none"
      />
      <Input
        id="install-password"
        name="password"
        type="password"
        placeholder="Password"
        required
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="h-11 text-[15px] bg-foreground/[0.04] border-foreground/[0.08] rounded-xl shadow-none"
      />
      <Input
        id="install-confirm-password"
        name="confirmPassword"
        type="password"
        placeholder="Confirm password"
        required
        autoComplete="new-password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        className="h-11 text-[15px] bg-foreground/[0.04] border-foreground/[0.08] rounded-xl shadow-none"
      />

      <Button
        type="submit"
        disabled={pending}
        className="w-full h-11 text-[13px] rounded-xl shadow-none"
      >
        {pending ? 'Creating account…' : 'Create owner account'}
      </Button>
    </form>
  );
}

/* ─── Install Status Hook ──────────────────────────────────────────────────── */

export type SandboxProviderName = 'local_docker' | 'daytona' | 'justavps';

export function useInstallStatus() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [sandboxProviders, setSandboxProviders] = useState<SandboxProviderName[]>([]);
  const [defaultProvider, setDefaultProvider] = useState<SandboxProviderName>('local_docker');

  useEffect(() => {
    const backendUrl = getEnv().BACKEND_URL || 'http://localhost:8008/v1';
    let retries = 0;
    const MAX_RETRIES = 3;

    const fetchStatus = async () => {
      try {
        const [statusRes, providerRes] = await Promise.all([
          fetch(`${backendUrl}/setup/install-status`),
          fetch(`${backendUrl}/setup/sandbox-providers`).catch(() => null),
        ]);

        if (statusRes.status === 503) {
          if (retries < MAX_RETRIES) {
            retries++;
            setTimeout(fetchStatus, 1500 * retries);
            return;
          }
          setInstalled(true);
          setLoading(false);
          return;
        }

        if (!statusRes.ok) {
          if (retries < MAX_RETRIES) {
            retries++;
            setTimeout(fetchStatus, 1500 * retries);
            return;
          }
          setInstalled(true);
          setLoading(false);
          return;
        }

        const statusData = await statusRes.json();

        if (statusData.installed === null || statusData.installed === undefined) {
          if (retries < MAX_RETRIES) {
            retries++;
            setTimeout(fetchStatus, 1500 * retries);
            return;
          }
          setInstalled(true);
          setLoading(false);
          return;
        }

        const providerData = providerRes?.ok
          ? await providerRes.json().catch(() => null)
          : null;

        setInstalled(statusData.installed === true);
        setSandboxProviders(providerData?.providers || ['local_docker']);
        setDefaultProvider(providerData?.default || 'local_docker');
        setLoading(false);
      } catch {
        if (retries < MAX_RETRIES) {
          retries++;
          setTimeout(fetchStatus, 1500 * retries);
          return;
        }
        setInstalled(true);
        setLoading(false);
      }
    };

    fetchStatus();
  }, []);

  return { installed, loading, sandboxProviders, defaultProvider };
}

/* ─── Self-Hosted Form Panel ───────────────────────────────────────────────── */

/**
 * SelfHostedForm — handles only authentication (installer + sign-in).
 * After successful auth, redirects to /instances which handles sandbox
 * provisioning and setup (provider config, tool keys) via /instances/[id].
 */

interface SelfHostedFormProps {
  returnUrl: string | null;
  installed: boolean | null;
}

export function SelfHostedForm({ returnUrl, installed }: SelfHostedFormProps) {
  const safeReturnUrl = sanitizeAuthReturnUrl(returnUrl);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (installed === null) {
    return <KortixLoader size="medium" />;
  }

  const isInstaller = !installed;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMessage(null);
    setPending(true);

    const form = e.currentTarget;
    const email = (form.elements.namedItem('email') as HTMLInputElement).value.trim().toLowerCase();
    const password = (form.elements.namedItem('password') as HTMLInputElement).value;

    if (!email || !email.includes('@')) {
      setErrorMessage('Please enter a valid email address');
      setPending(false);
      return;
    }

    if (!password || password.length < 6) {
      setErrorMessage('Password must be at least 6 characters');
      setPending(false);
      return;
    }

    try {
      if (!isInstaller) {
        let signedInJwt: string | null = null;
        try {
          const supabase = createBrowserSupabaseClient();
          await supabase.auth.signOut({ scope: 'local' });
          const { data: clientSignInData, error: clientSignInError } = await supabase.auth.signInWithPassword({
            email,
            password,
          });

          if (!clientSignInError && clientSignInData.session) {
            invalidateTokenCache();
            setBootstrapAuthToken(clientSignInData.session.access_token);
            signedInJwt = clientSignInData.session.access_token;
          }
        } catch {
          // Best-effort cleanup of stale local auth state.
        }

        if (!signedInJwt) {
          invalidateTokenCache();
          setBootstrapAuthToken(null);

          const formData = new FormData();
          formData.set('email', email);
          formData.set('password', password);
          formData.set('returnUrl', safeReturnUrl);

          const result = await selfHostedSignIn(null, formData);

          if (result.message) {
            setErrorMessage(result.message);
            setPending(false);
            return;
          }

          if (result.accessToken) {
            signedInJwt = result.accessToken;
          }

          if (result.accessToken && result.refreshToken) {
            try {
              const supabase = createBrowserSupabaseClient();
              await supabase.auth.setSession({
                access_token: result.accessToken,
                refresh_token: result.refreshToken,
              });
            } catch {
              // Fallback to server cookies + full reload below.
            }
          }

          if (!signedInJwt) {
            window.location.href = result.redirectTo || safeReturnUrl;
            return;
          }
        }

        // Auth successful — redirect to /instances.
        // The /instances page handles sandbox creation, and
        // /instances/[id] handles setup (provider config, tool keys).
        window.location.href = safeReturnUrl;
        return;
      } else {
        setErrorMessage('This instance still needs its initial owner account. Run the Kortix installer/CLI bootstrap first.');
        setPending(false);
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'An unexpected error occurred');
      setPending(false);
    }
  };

  // ── Installer: create owner account ──
  if (isInstaller) {
    return (
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <h1 className="text-[17px] font-medium text-foreground/90 tracking-tight">
            Create owner account
          </h1>
          <p className="text-[13px] text-foreground/40 mt-0.5">
            Set up the first admin account for this instance
          </p>
        </div>

        {errorMessage && (
          <div className="mb-4 p-3 rounded-xl flex items-center gap-2 bg-destructive/10 border border-destructive/20 text-destructive">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span className="text-[13px]">{errorMessage}</span>
          </div>
        )}

        <InstallerForm
          onSuccess={() => {
            // After creating owner account, redirect to /instances
            // which will auto-create sandbox and redirect to /instances/[id]
            window.location.href = '/instances';
          }}
          onError={setErrorMessage}
        />
      </div>
    );
  }

  // ── Returning user sign-in ──
  return (
    <div className="w-full max-w-sm">
      <div className="flex flex-col items-center mb-6">
        <h1 className="text-[17px] font-medium text-foreground/90 tracking-tight">
          Sign in to Kortix
        </h1>
        <p className="text-[13px] text-foreground/40 mt-0.5">
          Your AI Computer
        </p>
      </div>

      {errorMessage && (
        <div className="mb-4 p-3 rounded-xl flex items-center gap-2 bg-destructive/10 border border-destructive/20 text-destructive">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span className="text-[13px]">{errorMessage}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <Input
          id="email"
          name="email"
          type="email"
          placeholder="Email address"
          required
          autoComplete="email"
          className="h-11 text-[15px] bg-foreground/[0.04] border-foreground/[0.08] shadow-none"
        />
        <Input
          id="password"
          name="password"
          type="password"
          placeholder="Password"
          required
          autoComplete="current-password"
          className="h-11 text-[15px] bg-foreground/[0.04] border-foreground/[0.08] shadow-none"
        />

        <Button
          type="submit"
          disabled={pending}
          className="w-full h-11 text-[13px] rounded-xl shadow-none"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
