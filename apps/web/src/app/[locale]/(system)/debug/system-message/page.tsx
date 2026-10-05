'use client';

import { SystemMessage } from '@/components/ui/system-message';
import {
  SystemNotificationCard,
  parseSystemNotifications,
} from '@/features/session/message-parsing';
import { useTranslations } from '@/i18n/use-translations';

/**
 * /debug/system-message
 *
 * Two things sit here. Top: the `SystemMessage` primitive across every
 * variant x fill combination, plus the icon and cta slots. Bottom: the
 * chat-stream consumer, `SystemNotificationCard`, driven by real
 * `parseSystemNotifications()` output rather than hand-built objects — so the
 * parser and the card are exercised on the same path a session takes.
 *
 * Exists because none of what these are judged on survives a unit test: which
 * tone a `<task_failed>` tag resolves to, whether a long line ellipsizes
 * instead of bursting the row and forcing the page to scroll sideways (drop
 * `min-w-0 flex-1` off the text wrapper in system-message.tsx and this page
 * gains 66px of horizontal scroll at 375px), and light/dark contrast on a 10%
 * tint. Driving a real session needs a provisioned sandbox; this needs
 * nothing. Not linked from anywhere — just hit /debug/system-message.
 */

const RAW = [
  `<task_completed>
Task: Refactor the parser
Duration: 1.2s
</task_completed>`,

  `<session_stopped>
Reason: user interrupt
</session_stopped>`,

  `<task_failed>
Command: pnpm --filter @kortix/api test
Exit code: 1

FAIL src/routes/sessions.test.ts
  ● sessions > rejects a provider at capacity
    expected 402, received 500
      at Object.<anonymous> (src/routes/sessions.test.ts:88:24)</task_failed>`,

  `<blocker_raised>
Blocker: STAGING_DATABASE_URL is unset, so the staging rollout would fall back to the dev data plane. Set it before promoting.
</blocker_raised>`,

  `<snapshot_build_queued>
Provider: daytona
Region: us-east-1
Snapshot: kortix-agent-2f9c1ab
Queued at: 14:02:19Z
Estimated wait: up to 9 min
</snapshot_build_queued>`,

  // The three below carry no 'failed'/'stopped' in the tag, so every one of
  // them rendered calm grey before severity was classified properly.
  `<credentials_missing>
Connector: Linear
Detail: no API token is stored for this workspace
</credentials_missing>`,

  `<quota_exceeded>
Detail: the monthly sandbox-hour allowance is used up
</quota_exceeded>`,

  `<rate_limit_reached>
Detail: retrying in 30 seconds
</rate_limit_reached>`,
];

const notifications = RAW.flatMap((raw) => parseSystemNotifications(raw).notifications);

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground font-mono text-xs">{label}</p>
      {children}
    </div>
  );
}

export default function DebugSystemMessagePage() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="mx-auto w-full max-w-2xl space-y-10 px-4 py-10">
      <header className="space-y-1">
        <h1 className="text-foreground text-xl font-medium">
          {tI18nComplete.raw('texte066e37463a8')}
        </h1>
        <p className="text-muted-foreground text-sm">{tI18nComplete.raw('textc9841f4162f5')}</p>
      </header>

      <section className="space-y-5">
        <h2 className="text-foreground text-sm font-medium">
          {tI18nComplete.raw('textbacd3c9c5def')}
        </h2>

        <Row label={tI18nComplete.raw('text4ded27f0d48b')}>
          <div className="space-y-2">
            <SystemMessage variant="action">{tI18nComplete.raw('text10879d125f53')}</SystemMessage>
            <SystemMessage variant="warning">{tI18nComplete.raw('textdaa286f24937')}</SystemMessage>
            <SystemMessage variant="error">{tI18nComplete.raw('text87b8a3923fbb')}</SystemMessage>
          </div>
        </Row>

        <Row label={tI18nComplete.raw('textdcd32479a72e')}>
          <div className="space-y-2">
            <SystemMessage variant="action" fill>
              {tI18nComplete.raw('text10879d125f53')}
            </SystemMessage>
            <SystemMessage variant="warning" fill>
              {tI18nComplete.raw('textdaa286f24937')}
            </SystemMessage>
            <SystemMessage variant="error" fill>
              {tI18nComplete.raw('text87b8a3923fbb')}
            </SystemMessage>
          </div>
        </Row>

        <Row label={tI18nComplete.raw('text40e5d3da0f35')}>
          <div className="space-y-2">
            <SystemMessage
              variant="error"
              fill
              cta={{ label: tI18nComplete.raw('text942087cc2d41') }}
            >
              {tI18nComplete.raw('text87b8a3923fbb')}
            </SystemMessage>
            <SystemMessage
              variant="action"
              cta={{ label: tI18nComplete.raw('texted077f3d8125'), variant: 'outline' }}
            >
              {tI18nComplete.raw('text4657cfe82d4e')}
            </SystemMessage>
            <SystemMessage variant="action" fill isIconHidden>
              {tI18nComplete.raw('text60de472a143f')}
            </SystemMessage>
            <SystemMessage
              variant="warning"
              fill
              cta={{ label: tI18nComplete.raw('text48845bff334a'), variant: 'ghost' }}
            >
              {tI18nComplete.raw('textb675e9b4cde0')}
            </SystemMessage>
          </div>
        </Row>
      </section>

      <section className="space-y-5">
        <h2 className="text-foreground text-sm font-medium">
          {tI18nComplete.raw('text160392419673')}
        </h2>
        <div className="space-y-1.5">
          {notifications.map((n, i) => (
            <SystemNotificationCard key={`${n.tag}-${i}`} notification={n} />
          ))}
        </div>
      </section>
    </div>
  );
}
