'use client';

import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslations } from '../../../i18n';
import { Button } from '../../../primitives/button';
import { InputGroup, InputGroupInput } from '../../../primitives/input-group';
import Loading from '../../../primitives/loading';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Claude's step where ChatGPT shows a device code: Kortix ran the unmodified
 * `claude setup-token`, claude.com is open in a new tab, and the member pastes
 * the code it shows after the approval.
 */
export function ClaudeCodeStep({
  url,
  checking,
  onSubmit,
}: {
  url: string | null;
  checking: boolean;
  onSubmit: (code: string) => void;
}) {
  const t = useTranslations('claudeSubscription');
  const tSheet = useTranslations('providerSheet');
  const [code, setCode] = useState('');
  const canSubmit = !!url && code.trim().length > 0 && !checking;
  return (
    <div className="bg-muted/60 space-y-3 rounded-lg p-4" data-provider-claude-code="">
      <p className="text-muted-foreground text-xs text-pretty">{t('approveDescription')}</p>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) onSubmit(code.trim());
        }}
      >
        <InputGroup className="h-8 min-w-0 flex-1">
          <InputGroupInput
            autoFocus
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore=""
            data-lpignore="true"
            aria-label={t('codeLabel')}
            placeholder={t('codeLabel')}
            value={code}
            disabled={!url || checking}
            onChange={(event) => setCode(event.target.value)}
            className="font-mono text-xs"
          />
        </InputGroup>
        <Button type="submit" size="sm" disabled={!canSubmit} className="gap-1.5">
          {checking ? <Loading className="size-3.5 shrink-0" /> : null}
          {checking ? t('connecting') : t('connect')}
        </Button>
      </form>
      {url ? (
        <Button size="sm" variant="secondary" className="gap-1.5" asChild>
          <a href={url} target="_blank" rel="noopener noreferrer">
            {tSheet('openLink', { host: hostOf(url) })}
            <ArrowSquareOutIcon className="size-3.5 shrink-0" />
          </a>
        </Button>
      ) : (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loading className="size-3.5 shrink-0" />
          {t('starting')}
        </p>
      )}
    </div>
  );
}
