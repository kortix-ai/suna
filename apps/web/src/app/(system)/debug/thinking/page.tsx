'use client';

import { useTranslations } from '@/i18n/use-translations';
import { useState } from 'react';

import { SessionBusyIndicator } from '@/features/session/session-busy-indicator';

/**
 * /debug/thinking
 *
 * Visual harness for `SessionBusyIndicator` — default "Thinking", ambient
 * rotation, locked statusText, retry, and elapsed. One component, every mode.
 *
 * Not linked from anywhere — just hit /debug/thinking.
 */

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <p className="text-muted-foreground font-mono text-xs">{label}</p>
        {hint ? <p className="text-muted-foreground/60 text-xs">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

export default function DebugThinkingPage() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [statusText, setStatusText] = useState('Running tests…');

  return (
    <div className="mx-auto w-full max-w-2xl space-y-10 px-4 py-10">
      <header className="space-y-1">
        <h1 className="text-foreground text-xl font-medium">
          {tI18nComplete.raw('textb3c2db8d96e6')}
        </h1>
        <p className="text-muted-foreground text-sm">{tI18nComplete.raw('text5782690044e2')}</p>
      </header>

      <section className="space-y-5">
        <h2 className="text-foreground text-sm font-medium">
          {tI18nComplete.raw('texte9c29ff50cc7')}
        </h2>

        <Row
          label={tI18nComplete.raw('text37a8eec1ce19')}
          hint={tI18nComplete.raw('text6b0890227f8f')}
        >
          <SessionBusyIndicator />
        </Row>

        <Row
          label={tI18nComplete.raw('text31d18c0defdc')}
          hint={tI18nComplete.raw('text070fdf5c95ab')}
        >
          <SessionBusyIndicator ambient />
        </Row>

        <Row
          label={tI18nComplete.raw('text3a75b0a948e2')}
          hint={tI18nComplete.raw('textc24df1950343')}
        >
          <div className="space-y-3">
            <input
              type="text"
              value={statusText}
              onChange={(e) => setStatusText(e.target.value)}
              className="border-border bg-background text-foreground w-full rounded-lg border px-3 py-2 text-sm"
            />
            <SessionBusyIndicator ambient statusText={statusText} />
          </div>
        </Row>

        <Row
          label={tI18nComplete.raw('textd05e451f4d44')}
          hint={tI18nComplete.raw('text37fa6abce246')}
        >
          <SessionBusyIndicator ambient statusText="   " />
        </Row>

        <Row label={tI18nComplete.raw('texta757b331fa9a')}>
          <SessionBusyIndicator statusText={tI18nComplete.raw('text87d2f3386f90')} />
        </Row>

        <Row
          label={tI18nComplete.raw('text00921cf91f2c')}
          hint={tI18nComplete.raw('text0f0215280156')}
        >
          <SessionBusyIndicator
            statusText={tI18nComplete.raw('text6effe77ed662')}
            retryLabel={tI18nComplete.raw('texte8d51f7276c8')}
          />
        </Row>
      </section>
    </div>
  );
}
