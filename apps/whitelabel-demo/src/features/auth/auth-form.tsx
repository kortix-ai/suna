'use client';

import Link from 'next/link';
import { useFormStatus } from 'react-dom';
import { ArrowRight, Loader2 } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { brand } from '@/config/brand';

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" className="mt-1 w-full gap-2" disabled={pending}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : null}
      {label}
      {!pending ? <ArrowRight className="size-4" /> : null}
    </Button>
  );
}

export function AuthForm({
  mode,
  error,
  action,
}: {
  mode: 'login' | 'register';
  error?: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const isLogin = mode === 'login';
  return (
    <main className="bg-background relative grid min-h-svh place-items-center overflow-hidden p-6">
      {/* Ambient backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            'radial-gradient(60% 50% at 50% 0%, color-mix(in oklch, var(--primary) 8%, transparent), transparent 70%)',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [mask-image:radial-gradient(70%_60%_at_50%_40%,black,transparent)]"
        style={{
          backgroundImage:
            'linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          opacity: 0.4,
        }}
      />

      <div className="relative w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <BrandMark className="size-11 rounded-xl" glyphClassName="size-5" />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">
            {isLogin ? `Sign in to ${brand.name}` : `Create your ${brand.name} account`}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">{brand.tagline}</p>
        </div>

        <div className="bg-card border-border rounded-2xl border p-6 shadow-lg">
          {error ? (
            <div className="border-destructive/30 bg-destructive/10 text-destructive mb-4 rounded-lg border px-3 py-2 text-sm">
              {error}
            </div>
          ) : null}

          <form action={action} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                placeholder="••••••••"
                minLength={8}
                required
              />
              {!isLogin ? (
                <p className="text-muted-foreground text-xs">Use at least 8 characters.</p>
              ) : null}
            </div>
            <SubmitButton label={isLogin ? 'Sign in' : 'Create account'} />
          </form>
        </div>

        <p className="text-muted-foreground mt-5 text-center text-sm">
          {isLogin ? "Don't have an account?" : 'Already have an account?'}{' '}
          <Link
            href={isLogin ? '/register' : '/login'}
            className="text-foreground font-medium underline-offset-4 hover:underline"
          >
            {isLogin ? 'Create one' : 'Sign in'}
          </Link>
        </p>

        {brand.poweredBy ? (
          <p className="text-muted-foreground/70 mt-8 text-center text-xs">
            Powered by {brand.poweredBy}
          </p>
        ) : null}
      </div>
    </main>
  );
}
