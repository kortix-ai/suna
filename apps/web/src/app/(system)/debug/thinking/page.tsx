'use client';

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
  const [statusText, setStatusText] = useState('Running tests…');

  return (
    <div className="mx-auto w-full max-w-2xl space-y-10 px-4 py-10">
      <header className="space-y-1">
        <h1 className="text-foreground text-xl font-medium">Session busy indicator</h1>
        <p className="text-muted-foreground text-sm">
          Default label, ambient rotation, locked status, retry, elapsed.
        </p>
      </header>

      <section className="space-y-5">
        <h2 className="text-foreground text-sm font-medium">Modes</h2>

        <Row label="default" hint='Single "Thinking" label — live session default.'>
          <SessionBusyIndicator />
        </Row>

        <Row label="ambient" hint="Cycles filler lines every ~3.2s when there is no statusText.">
          <SessionBusyIndicator ambient />
        </Row>

        <Row label="ambient + statusText" hint="Concrete status locks; ambient stays off.">
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

        <Row label="ambient + whitespace statusText" hint="Falls through to ambient rotation.">
          <SessionBusyIndicator ambient statusText="   " />
        </Row>

        <Row label="statusText">
          <SessionBusyIndicator statusText="Searching the web" />
        </Row>

        <Row label="retryLabel" hint="Wins over status; shimmer off.">
          <SessionBusyIndicator statusText="Running tests" retryLabel="Waiting to retry" />
        </Row>
      </section>
    </div>
  );
}
