'use client';

import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import type { OutcomeTone } from '@/features/session/outcomes/outcome-types';
import { outcomeTint } from '@/features/session/outcomes/outcome-vocabulary';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import {
  getSecretSetupLink,
  submitSecretSetupLink,
  type SecretSetupLinkInfo,
} from '@kortix/sdk';
import {
  ArrowUpRightIcon,
  CheckIcon,
  ClockCountdownIcon,
  LinkBreakIcon,
  WarningCircleIcon,
  type Icon,
} from '@phosphor-icons/react';
import { Fragment, useEffect, useState, type ReactElement } from 'react';
import {
  classifySetupLinkError,
  describeLinkExpiry,
  describeWithheldSecrets,
  setupLinkApiBase,
  splitTextLinks,
} from './util';

type Phase = 'loading' | 'error' | 'expired' | 'invalid' | 'ready' | 'submitting' | 'done';

/** Every phase that is not the form: tinted tile, title, one muted line. */
function StatusNotice({
  icon: Glyph,
  tone,
  title,
  description,
}: {
  icon: Icon;
  tone: OutcomeTone;
  title: string;
  description?: string;
}): ReactElement {
  const tint = outcomeTint(tone);
  return (
    <div role="status" className="flex flex-col items-center gap-3 py-8 text-center">
      <span
        className={cn(
          'flex size-9 items-center justify-center rounded-sm ring-1',
          tint.ring,
          tint.bg,
        )}
      >
        <Glyph weight="fill" className={cn('size-5', tint.fg)} />
      </span>
      <div className="max-w-xs space-y-1">
        <p className="text-foreground text-sm font-medium">{title}</p>
        {description ? (
          <p className="text-muted-foreground text-xs text-pretty">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Agent-written hint text with its URLs as real links: brand blue, underlined,
 * an up-right arrow for "opens elsewhere". A long URL truncates; `title` keeps
 * the full address.
 */
function LinkedText({ text }: { text: string }): ReactElement {
  return (
    <>
      {splitTextLinks(text).map((part, index) =>
        part.type === 'text' ? (
          <Fragment key={index}>{part.value}</Fragment>
        ) : (
          <a
            key={index}
            href={part.href}
            title={part.href}
            target="_blank"
            rel="noopener noreferrer"
            className="group text-kortix-base focus-visible:ring-ring inline-flex max-w-full items-baseline gap-0.5 rounded-sm font-medium outline-none focus-visible:ring-2"
          >
            <span className="decoration-kortix-base/40 group-hover:decoration-kortix-base min-w-0 truncate underline underline-offset-2">
              {part.label}
            </span>
            <ArrowUpRightIcon className="size-3 shrink-0 self-center" />
          </a>
        ),
      )}
    </>
  );
}

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
  /**
   * The host already states the encryption promise (the in-chat modal header),
   * so the footnote keeps only the expiry.
   */
  compact?: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const base = setupLinkApiBase();
  const [phase, setPhase] = useState<Phase>('loading');
  const [info, setInfo] = useState<SecretSetupLinkInfo | null>(null);
  const [expiresIn, setExpiresIn] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [withheldNotice, setWithheldNotice] = useState<ReturnType<
    typeof describeWithheldSecrets
  > | null>(null);

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
              : tI18nHardcoded.raw('i18nComplete.texta8234500531a'),
          );
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, token, tI18nHardcoded]);

  async function submit() {
    if (!info) return;
    const filled: Record<string, string> = {};
    for (const f of info.fields) {
      const v = (values[f.name] ?? '').trim();
      if (v.length > 0) filled[f.name] = v;
    }
    if (Object.keys(filled).length === 0) {
      setError('Enter a value before saving.');
      return;
    }
    setPhase('submitting');
    setError(null);
    try {
      const result = await submitSecretSetupLink(token, filled, { backendUrl: base });
      setWithheldNotice(describeWithheldSecrets(result));
      setPhase('done');
      onDone?.();
    } catch (cause) {
      if (classifySetupLinkError(cause) === 'expired') {
        setPhase('expired');
        return;
      }
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not save. Check your connection and try again.',
      );
      setPhase('ready');
    }
  }

  switch (phase) {
    case 'loading':
      return (
        <div
          role="status"
          className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm"
        >
          <Loading className="size-4 shrink-0" />
          {tI18nHardcoded.raw('autoComponentsSetupLinksSecretIntakeFormJsxTextLoading93bbc067')}
        </div>
      );
    case 'expired':
      return (
        <StatusNotice
          icon={ClockCountdownIcon}
          tone="warning"
          title={tI18nHardcoded.raw('i18nComplete.text7cb87dcb8d50')}
          description={tI18nHardcoded.raw('i18nComplete.texte7119681d233')}
        />
      );
    case 'invalid':
      return (
        <StatusNotice
          icon={LinkBreakIcon}
          tone="destructive"
          title={tI18nHardcoded.raw('i18nComplete.text72c9ce898bf3')}
          description={tI18nHardcoded.raw('i18nComplete.text8d669b2101c9')}
        />
      );
    case 'error':
      return (
        <StatusNotice
          icon={WarningCircleIcon}
          tone="destructive"
          title={error || tI18nHardcoded.raw('i18nComplete.texta8234500531a')}
        />
      );
    case 'done':
      if (withheldNotice) {
        return (
          <StatusNotice
            icon={WarningCircleIcon}
            tone="warning"
            title={withheldNotice.title}
            description={withheldNotice.description}
          />
        );
      }
      return (
        <StatusNotice
          icon={CheckIcon}
          tone="success"
          title={tI18nHardcoded.raw(
            'autoComponentsSetupLinksSecretIntakeFormJsxTextSavedSecurelyd63e94b1',
          )}
          description={tI18nHardcoded.raw(
            'autoComponentsSetupLinksSecretIntakeFormJsxTextYouCand69604da',
          )}
        />
      );
  }

  const submitting = phase === 'submitting';
  const fields = info?.fields ?? [];
  const footnote = [
    compact
      ? null
      : tI18nHardcoded.raw('autoComponentsSetupLinksSecretIntakeFormJsxTextEncryptedAtf17a4f88'),
    expiresIn ? tI18nHardcoded('i18nComplete.textefb48f76e65a', { value0: expiresIn }) : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="space-y-5">
      <FieldGroup className="gap-5">
        {fields.map((f) => (
          <Field key={f.name} className="space-y-2">
            <div className="space-y-1">
              <FieldLabel htmlFor={`secret-${f.name}`} className="text-foreground">
                {f.label || <code className="font-mono">{f.name}</code>}
              </FieldLabel>
              {f.description ? (
                <p className="text-muted-foreground text-xs text-pretty">
                  <LinkedText text={f.description} />
                </p>
              ) : null}
            </div>
            <Input
              id={`secret-${f.name}`}
              name={f.name}
              type="password"
              autoComplete="off"
              spellCheck={false}
              // 16px below `sm` so iOS Safari does not zoom the page on focus.
              className="font-mono max-sm:text-base"
              placeholder="••••••••••••"
              value={values[f.name] ?? ''}
              disabled={submitting}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && fields.length === 1) void submit();
              }}
            />
          </Field>
        ))}
      </FieldGroup>

      <div className="space-y-3">
        {error ? (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        ) : null}
        <Button type="button" className="w-full" onClick={submit} disabled={submitting}>
          {submitting ? <Loading className="size-4 shrink-0" /> : null}
          {submitting
            ? tI18nHardcoded.raw('i18nComplete.text23e39291d613')
            : tI18nHardcoded.raw('i18nComplete.textad3d9699142e')}
        </Button>
        {footnote ? (
          <p className="text-muted-foreground text-center text-xs text-pretty">{footnote}</p>
        ) : null}
      </div>
    </div>
  );
}
