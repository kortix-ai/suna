'use client';

import { CenterHero, PageCta } from '@/features/marketing/v2/page-kit';
import { MAX_W } from '@/features/marketing/v2/primitives';

const ENTRIES = [
  {
    version: 'v0.11.0',
    date: '24 July 2026',
    title: 'Channels for Teams and WhatsApp',
    body: 'Sessions can now start from Microsoft Teams and WhatsApp with the same permissions and audit trail as Slack. A channel is still just a few lines in kortix.yaml.',
    items: [
      'Microsoft Teams channel, generally available',
      'WhatsApp and SMS channels, in preview',
      'Channel-scoped agent defaults',
    ],
  },
  {
    version: 'v0.10.14',
    date: '17 July 2026',
    title: 'Faster session boot',
    body: 'Warm sandbox images cut the time between asking for work and the agent actually starting. Most sessions now boot in seconds instead of tens of seconds.',
    items: [
      'Warm image pool per project',
      'Connectors mounted before the agent starts',
      'Boot timing surfaced in the session log',
    ],
  },
  {
    version: 'v0.10.10',
    date: '3 July 2026',
    title: 'Approval gates on every change request',
    body: 'Approval is now part of the model rather than a project setting. Every change request needs a named member before it can merge, and the decision lands in the audit trail.',
    items: [
      'Required approvers per project',
      'Rejections return to the session with context',
      'Audit export includes the approver',
    ],
  },
  {
    version: 'v0.10.4',
    date: '19 June 2026',
    title: 'Harness switching',
    body: 'Claude Code, Codex, OpenCode, and Gemini are all first-class. The harness is a per-agent setting, so switching one agent does not touch the rest of the company.',
    items: [
      'Per-agent harness override',
      'Bring your own model subscription',
      'Model catalogue in the command center',
    ],
  },
];

export default function ChangelogPage() {
  return (
    <main className="bg-background">
      <CenterHero
        heading={['What shipped,', 'and when.']}
        body="Kortix ships constantly. This is the short version — the full history is in the repo, one merged change request at a time."
        cta={false}
      />

      <section className="py-16 sm:py-24">
        <div className={MAX_W}>
          {ENTRIES.map((entry) => (
            <article
              key={entry.version}
              className="border-border grid gap-6 border-t py-12 lg:grid-cols-[14rem_1fr] lg:gap-16"
            >
              <div>
                <p className="text-foreground font-mono text-[0.9375rem] font-medium">
                  {entry.version}
                </p>
                <p className="text-muted-foreground mt-1 text-[0.9375rem]">{entry.date}</p>
              </div>
              <div>
                <h2 className="text-foreground text-[1.5rem] leading-tight font-medium tracking-tight">
                  {entry.title}
                </h2>
                <p className="text-muted-foreground mt-3 text-[1.0625rem] leading-[1.6]">
                  {entry.body}
                </p>
                <ul className="mt-5 space-y-2">
                  {entry.items.map((item) => (
                    <li
                      key={item}
                      className="text-muted-foreground flex items-start gap-2.5 text-[0.9375rem]"
                    >
                      <span className="bg-kortix-blue mt-[0.55rem] size-1.5 shrink-0 rounded-full" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
        </div>
      </section>

      <PageCta
        heading={['Run the version', 'that shipped today.']}
        body="Managed cloud updates itself. Self-hosted installs pin a release and roll on your schedule."
      />
    </main>
  );
}
