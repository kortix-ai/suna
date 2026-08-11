'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import {
  CheckIcon,
  ClockCountdownIcon,
  KeyIcon,
  LinkBreakIcon,
  ShieldCheckIcon,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { classifySetupLinkError, describeLinkExpiry, setupLinkApiBase } from './util';
import {
  getSecretSetupLink,
  submitSecretSetupLink,
  type SecretSetupLinkInfo,
} from '@kortix/sdk';

type Phase = 'loading' | 'error' | 'expired' | 'invalid' | 'ready' | 'submitting' | 'done';

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
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const base = setupLinkApiBase();
  const [phase, setPhase] = useState<Phase>('loading');
  const [info, setInfo] = useState<SecretSetupLinkInfo | null>(null);
  const [expiresIn, setExpiresIn] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await getSecretSetupLink(token, { backendUrl: base });
        if (cancelled) return;
        setInfo(body);
        setExpiresIn(describeLinkExpiry(body.expires_at, Date.now()));
        setPhase('ready');
      } catch (cause) {
        if (cancelled) return;
        const kind = classifySetupLinkError(cause);
        if (kind === 'expired') {
          setPhase('expired');
        } else if (kind === 'invalid') {
          setPhase('invalid');
        } else {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not reach dosco. Check your connection and try again.',
          );
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
      await submitSecretSetupLink(token, filled, { backendUrl: base });
      setPhase('done');
      onDone?.();
    } catch (cause) {
      if (classifySetupLinkError(cause) === 'expired') {
        setPhase('expired');
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Could not save. Check your connection and try again.');
      setPhase('ready');
    }
  }

  if (phase === 'loading') {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm">
        <Loading className="size-4" />{' '}
        {tI18nHardcoded.raw('autoComponentsSetupLinksSecretIntakeFormJsxTextLoading93bbc067')}
      </div>
    );
  }

  if (phase === 'expired') {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <span className="bg-kortix-orange/15 flex size-9 items-center justify-center rounded-sm">
          <ClockCountdownIcon weight="fill" className="text-kortix-orange size-5" />
        </span>
        <p className="text-foreground text-sm font-medium">This link has expired</p>
        <p className="text-muted-foreground max-w-xs text-xs">
          Secret links stop working after a set time so an old link cannot be misused. Ask the
          agent that sent it for a fresh link — it can mint one in seconds — or reply in the
          thread where you received this one.
        </p>
      </div>
    );
  }

  if (phase === 'invalid') {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <span className="bg-kortix-red/15 flex size-9 items-center justify-center rounded-sm">
          <LinkBreakIcon weight="fill" className="text-kortix-red size-5" />
        </span>
        <p className="text-foreground text-sm font-medium">This link is not valid</p>
        <p className="text-muted-foreground max-w-xs text-xs">
          The link may have been cut off when it was copied. Open the complete URL, or ask the
          agent that sent it for a new link.
        </p>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="text-muted-foreground py-6 text-center text-sm">
        {error || 'Could not reach dosco. Check your connection and try again.'}
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <span className="bg-kortix-green/15 flex size-9 items-center justify-center rounded-sm">
          <CheckIcon weight="fill" className="text-kortix-green size-5" />
        </span>
        <p className="text-foreground text-sm font-medium">
          {tI18nHardcoded.raw(
            'autoComponentsSetupLinksSecretIntakeFormJsxTextSavedSecurelyd63e94b1',
          )}
        </p>
        <p className="text-muted-foreground text-xs">
          {tI18nHardcoded.raw('autoComponentsSetupLinksSecretIntakeFormJsxTextYouCand69604da')}
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
          {f.description ? <p className="text-muted-foreground text-xs">{f.description}</p> : null}
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

      {error ? <p className="text-destructive text-xs">{error}</p> : null}

      <Button className="w-full" onClick={submit} disabled={submitting}>
        {submitting ? (
          <Loading className="mr-2 size-4 shrink-0" />
        ) : (
          <KeyIcon className="mr-2 size-4 shrink-0" />
        )}
        {submitting ? 'Saving…' : 'Save securely'}
      </Button>

      <p className="text-muted-foreground flex items-center justify-center gap-1.5 text-[11px]">
        <ShieldCheckIcon className="size-3" />
        {tI18nHardcoded.raw('autoComponentsSetupLinksSecretIntakeFormJsxTextEncryptedAtf17a4f88')}
        {expiresIn ? ` Link expires in ${expiresIn}.` : ''}
      </p>
    </div>
  );
}
