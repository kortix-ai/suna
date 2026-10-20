'use client';

import { BRAND } from '@/config/brand';
import { authClient } from '@/lib/auth-client';
import { Button } from '@kortix/ui/button';
import { Card } from '@kortix/ui/card';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { SignInIcon, UserPlusIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BrandMark } from './brand-mark';

/**
 * Lumen's own sign-in and sign-up (Better Auth, email + password). Lumen users
 * never get a Kortix account; the session cookie is first-party on this origin.
 */
export function AuthScreen({
  initialMode = 'sign-in',
  email: presetEmail = '',
  subtitle,
  redirectTo,
}: {
  initialMode?: 'sign-in' | 'sign-up';
  email?: string;
  subtitle?: string;
  /** Where to go after success, per mode. Omitted: stay (the parent re-renders signed in). */
  redirectTo?: { 'sign-in': string; 'sign-up': string };
}) {
  const router = useRouter();
  const [mode, setMode] = useState(initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState(presetEmail);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const signUp = mode === 'sign-up';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const result = signUp
      ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
      : await authClient.signIn.email({ email: email.trim(), password });
    if (result.error) {
      setPending(false);
      setError(result.error.message ?? 'Could not sign in');
      return;
    }
    if (redirectTo) router.replace(redirectTo[mode]);
    else setPending(false);
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <Card className="w-full max-w-sm p-6">
        <Link href="/" aria-label={`${BRAND.name} home`} className="mb-5 self-start">
          <BrandMark />
        </Link>
        <h1 className="font-display text-2xl tracking-tight">
          {signUp ? `Create your ${BRAND.name} account` : `Sign in to ${BRAND.name}`}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{subtitle ?? BRAND.tagline}</p>
        <form className="mt-5 space-y-3" onSubmit={submit}>
          {signUp && (
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" autoFocus required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="email">Work email</Label>
            <Input
              id="email"
              type="email"
              autoFocus={!signUp}
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={signUp ? 'new-password' : 'current-password'}
              placeholder={signUp ? 'At least 10 characters' : undefined}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={pending || !email.trim() || !password}>
            {pending ? (
              <Loading className="size-4" />
            ) : signUp ? (
              <UserPlusIcon className="size-4" />
            ) : (
              <SignInIcon className="size-4" />
            )}
            {signUp ? 'Create account' : 'Sign in'}
          </Button>
        </form>
        <p className="mt-4 flex items-center justify-center gap-1 text-sm text-muted-foreground">
          {signUp ? 'Already have an account?' : `New to ${BRAND.name}?`}
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => {
              setError(null);
              setMode(signUp ? 'sign-in' : 'sign-up');
            }}
          >
            {signUp ? 'Sign in' : 'Create an account'}
          </Button>
        </p>
      </Card>
    </div>
  );
}
