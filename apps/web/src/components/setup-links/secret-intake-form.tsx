'use client';

import React, { useEffect, useState } from 'react';
import { Check, Loader2, ShieldCheck, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { setupLinkApiBase } from './util';

interface SecretField {
  name: string;
  label: string | null;
  description: string | null;
}

interface SecretLinkInfo {
  project_name: string;
  fields: SecretField[];
  expires_at: string;
}

type Phase = 'loading' | 'error' | 'ready' | 'submitting' | 'done';

/**
 * Renders the fields an agent-minted secret link asks for, and submits the
 * values the human types. Shared by the public /secret-intake/[token] page and
 * the in-chat modal. The value is write-only — it's never read back here.
 */
export function SecretIntakeForm({
  token,
  onDone,
  compact,
}: {
  token: string;
  onDone?: () => void;
  compact?: boolean;
}) {
  const base = setupLinkApiBase();
  const [phase, setPhase] = useState<Phase>('loading');
  const [info, setInfo] = useState<SecretLinkInfo | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${base}/setup-links/secret/${encodeURIComponent(token)}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(body?.error || 'This link is invalid or has expired.');
          setPhase('error');
          return;
        }
        setInfo(body);
        setPhase('ready');
      } catch {
        if (!cancelled) {
          setError('Could not reach Kortix. Check your connection and try again.');
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, token]);

  async function submit() {
    if (!info) return;
    const filled = Object.fromEntries(
      info.fields
        .map((f) => [f.name, (values[f.name] ?? '').trim()] as const)
        .filter(([, v]) => v.length > 0),
    );
    if (Object.keys(filled).length === 0) {
      setError('Enter a value before saving.');
      return;
    }
    setPhase('submitting');
    setError(null);
    try {
      const res = await fetch(`${base}/setup-links/secret/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: filled }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error || 'Could not save. The link may have expired.');
        setPhase('ready');
        return;
      }
      setPhase('done');
      onDone?.();
    } catch {
      setError('Could not save. Check your connection and try again.');
      setPhase('ready');
    }
  }

  if (phase === 'loading') {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground justify-center">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        {error || 'This link is invalid or has expired.'}
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
          <Check className="h-5 w-5" />
        </div>
        <p className="text-sm font-medium text-foreground">Saved securely</p>
        <p className="text-xs text-muted-foreground">
          You can close this. The agent will pick it up — tell it “done” to continue.
        </p>
      </div>
    );
  }

  const submitting = phase === 'submitting';

  return (
    <div className={cn('space-y-4', compact ? '' : 'mt-2')}>
      {info?.fields.map((f) => (
        <div key={f.name} className="space-y-1.5">
          <Label htmlFor={`secret-${f.name}`} className="font-mono text-xs">
            {f.label || f.name}
          </Label>
          {f.description ? (
            <p className="text-xs text-muted-foreground">{f.description}</p>
          ) : null}
          <Input
            id={`secret-${f.name}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            placeholder="••••••••••••"
            value={values[f.name] ?? ''}
            disabled={submitting}
            onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (info?.fields.length ?? 0) === 1) submit();
            }}
          />
        </div>
      ))}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <Button className="w-full" onClick={submit} disabled={submitting}>
        {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
        {submitting ? 'Saving…' : 'Save securely'}
      </Button>

      <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
        <ShieldCheck className="h-3 w-3" />
        Encrypted at rest. Only this project can read it. The agent never sees the value.
      </p>
    </div>
  );
}
