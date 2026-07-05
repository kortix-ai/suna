'use client';

import { BRAND } from '@/config/brand';
import { setSessionToken } from '@/lib/session';
import { Loader2, LogIn } from 'lucide-react';
import { useState } from 'react';
import { BrandMark } from './brand-mark';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';

/**
 * Wrapper-mode's own login — replaces `ApiKeyGate` when the app is running as
 * a BFF (`useWrapperMode()`). Posts to `/api/auth/login`, which checks the
 * demo credential, signs an app session token, and returns it (also setting
 * it as an HttpOnly cookie for the preview-iframe path). We store the token
 * for the SDK's `getToken()` and hand off to `onReady`.
 */
export function LoginGate({ onReady }: { onReady: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) {
        setError(data.error ?? 'Could not sign in');
        return;
      }
      setSessionToken(data.token);
      onReady();
    } catch {
      setError('Could not reach the server');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <Card className="w-full max-w-sm p-6">
        <BrandMark className="mb-5" />
        <h1 className="text-lg font-semibold tracking-tight">Sign in to {BRAND.name}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {BRAND.name} runs its own login here — your Kortix account stays on the server.
        </p>
        <form className="mt-5 space-y-3" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoFocus
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
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={pending || !email.trim() || !password}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <LogIn className="size-4" />}
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
