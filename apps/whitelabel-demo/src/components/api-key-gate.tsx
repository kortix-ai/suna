'use client';

import { BRAND } from '@/config/brand';
import { setApiKey } from '@/lib/kortix';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { BrandMark } from './brand-mark';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';

/**
 * The single auth surface: paste a Kortix API key. One token, stored locally,
 * fed to the SDK via `getToken`. This is the whole auth story — no Supabase, no
 * sessions table. `onReady` re-renders the app once a key exists.
 */
export function ApiKeyGate({ onReady }: { onReady: () => void }) {
  const [value, setValue] = useState('');

  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <Card className="w-full max-w-sm p-6">
        <BrandMark className="mb-5" />
        <h1 className="text-lg font-semibold tracking-tight">Connect to {BRAND.name}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Paste a Kortix API key. Create one in your dashboard under{' '}
          <span className="text-foreground">Settings → API keys</span>.
        </p>
        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value.trim()) return;
            setApiKey(value.trim());
            onReady();
          }}
        >
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="kortix_pat_…"
              className="pl-9 font-mono"
              spellCheck={false}
            />
          </div>
          <Button type="submit" className="w-full" disabled={!value.trim()}>
            Continue
          </Button>
        </form>
      </Card>
    </div>
  );
}
