import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@kortix/ui';
import {
  ArrowSquareOutIcon,
  CameraIcon,
  CaretDownIcon,
  CheckIcon,
  DotsThreeIcon,
  FilePdfIcon,
  ImageIcon,
  MicrophoneIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

import { Message, Thread, ThreadCard, type ChatCard } from './chat';
import type { SurfaceId } from './content';
import { TerminalFrame } from './frames';
import {
  CheckRow,
  Chip,
  FIX_STEPS,
  PermissionCard,
  PROMPT,
  QuickEntryBar,
  SLACK_CR,
  TEAMS_CR,
} from './parts';

/*
 * One focused visual per "how it works" tab. Each fits the panel at 390 px:
 * one column, real text sizes, a few marks. Labels are the shipped ones; the
 * source is named above each panel.
 */

const caption = 'text-muted-foreground font-mono text-xs tracking-wide uppercase';

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('bg-background flex flex-col rounded-lg border', className)}>{children}</div>;
}

/* ── Desktop ─────────────────────────────────────────────────────────── */

/** quick-entry.js: the target picker lists a new session and the 5 most recent. */
function QuickEntryPanel() {
  const targets = ['New session', 'Billing webhook retry', 'Weekly pipeline summary', 'Churned accounts, October'];
  return (
    <div className="flex flex-col gap-3">
      <QuickEntryBar text="Add this error to the session and find the cause" target="Billing webhook retry" />
      <Card className="max-w-2xl divide-y">
        {targets.map((t, i) => (
          <span key={t} className="text-foreground flex items-center justify-between px-4 py-2.5 text-sm">
            {t}
            {i === 1 ? <CheckIcon aria-hidden className="size-4" /> : null}
          </span>
        ))}
      </Card>
      <span className="text-muted-foreground flex items-center gap-2 text-sm">
        <ImageIcon aria-hidden className="size-4" />
        Screenshot 2026-10-12 at 15.04.31.png
      </span>
    </div>
  );
}

/** guide.mdx "Connect your own computer": the three capabilities. */
function ConnectPanel() {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <span className="text-foreground text-base font-medium">Work laptop</span>
        <span className="bg-muted text-foreground rounded-md px-2 py-0.5 text-xs">Only you</span>
      </div>
      <ul className="divide-y">
        <CheckRow title="Filesystem" detail="Read, write, list and delete files." />
        <CheckRow title="Shell" detail="Run programs." />
        <CheckRow title="Computer Use" detail="See the screen and use the apps. macOS and Windows." />
      </ul>
    </Card>
  );
}

/** computer.js accessPrompt: the native prompt, 1 hour is the default button. */
function AccessPanel() {
  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-4 p-5">
        <span className="bg-foreground text-background flex size-9 items-center justify-center rounded-lg">
          <KortixLogo size={16} variant="symbol" />
        </span>
        <div className="flex flex-col gap-2">
          <span className="text-foreground text-base font-medium">Allow Kortix to use Work laptop?</span>
          <p className="text-muted-foreground text-sm text-pretty">
            An agent wants to use the shell. Allowing lets any Kortix agent that can reach this computer use its files,
            the shell, and the screen and keyboard until the time runs out.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Chip>Allow for 24 hours</Chip>
          <Chip primary>Allow for 1 hour</Chip>
          <Chip>Deny</Chip>
        </div>
      </Card>
      <div className="flex flex-col gap-2">
        <span className={caption}>Access</span>
        <div className="flex flex-wrap gap-1.5">
          <span className="bg-background text-foreground rounded-md border px-3 py-1.5 text-sm">Ask each time</span>
          <span className="text-muted-foreground rounded-md px-3 py-1.5 text-sm">Always allowed</span>
          <span className="text-muted-foreground rounded-md px-3 py-1.5 text-sm">Off</span>
        </div>
      </div>
    </div>
  );
}

/** attention-badge.js: the Dock count (a dot on Windows). */
function BadgePanel() {
  return (
    <div className="flex flex-col gap-4">
      <div className="bg-background mx-auto flex items-end gap-3 rounded-xl border px-4 py-3">
        {[0, 1, 2].map((n) => (
          <span key={n} aria-hidden className="bg-muted size-11 rounded-lg" />
        ))}
        <span className="relative">
          <span className="bg-foreground text-background flex size-11 items-center justify-center rounded-lg">
            <KortixLogo size={20} variant="symbol" />
          </span>
          <span className="bg-kortix-red absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full text-xs font-medium text-background">
            2
          </span>
        </span>
        <span aria-hidden className="bg-muted size-11 rounded-lg" />
      </div>
      <Card className="divide-y">
        {['Weekly pipeline summary', 'Churned accounts, October'].map((t) => (
          <span key={t} className="text-foreground flex items-center justify-between gap-3 px-4 py-3 text-sm">
            {t}
            <span className="text-muted-foreground flex items-center gap-2 text-xs">
              Finished
              <span aria-hidden className="bg-foreground size-1.5 rounded-full" />
            </span>
          </span>
        ))}
      </Card>
    </div>
  );
}

/* ── Mobile ──────────────────────────────────────────────────────────── */

/** The mobile composer: an attachment, the text, then agent, camera, photos, dictation. */
function StartPanel() {
  return (
    <Card className="gap-3 p-4">
      <span className="bg-muted text-foreground flex w-fit items-center gap-2 rounded-md px-2.5 py-1.5 text-sm">
        <ImageIcon aria-hidden className="size-4" />
        whiteboard.jpg
      </span>
      <span className="text-foreground text-base text-pretty">Turn this whiteboard into a launch plan with owners</span>
      <div className="text-muted-foreground flex items-center gap-3 border-t pt-3">
        <span className="text-foreground flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs">
          kortix
          <CaretDownIcon aria-hidden className="size-3" />
        </span>
        <CameraIcon aria-hidden className="ml-auto size-4" />
        <ImageIcon aria-hidden className="size-4" />
        <MicrophoneIcon aria-hidden className="size-4" />
      </div>
    </Card>
  );
}

function PermissionPanel() {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-foreground text-sm text-pretty">The fix is in. I want to run the billing tests to prove it.</p>
      <PermissionCard tool="bash" input="bun test src/billing" />
    </div>
  );
}

/** ReviewDetailSheet.tsx: the diff, then Request changes · Merge. */
function ReviewPanel() {
  const lines: readonly { sign: ' ' | '-' | '+'; text: string }[] = [
    { sign: ' ', text: 'const s = res.status;' },
    { sign: ' ', text: 'if (s >= 400) {' },
    { sign: '-', text: '  return retry(e);' },
    { sign: '+', text: '  if (s < 500) return fail(e);' },
    { sign: '+', text: '  return retry(e);' },
    { sign: ' ', text: '}' },
  ];
  return (
    <Card>
      <div className="flex flex-col gap-0.5 border-b px-4 py-3">
        <span className="text-foreground text-base font-medium">Stop retrying webhooks on a 4xx</span>
        <span className="text-muted-foreground text-xs">#12 · 2 files changed</span>
      </div>
      <span className="text-muted-foreground border-b px-4 py-2 font-mono text-xs">webhook-retry.ts</span>
      <pre className="overflow-x-auto py-2 font-mono text-xs leading-6">
        {lines.map((l, i) => (
          <span
            key={i}
            className={cn(
              'block px-4 whitespace-pre',
              l.sign === '+' && 'bg-kortix-green/15 text-foreground',
              l.sign === '-' && 'bg-kortix-red/15 text-foreground',
              l.sign === ' ' && 'text-muted-foreground',
            )}
          >
            {l.sign} {l.text}
          </span>
        ))}
      </pre>
      <div className="grid grid-cols-2 gap-2 border-t p-3">
        <Chip className="justify-center">Request changes</Chip>
        <Chip primary className="justify-center">
          Merge
        </Chip>
      </div>
    </Card>
  );
}

/** apps/mobile/app/(settings)/notifications.tsx: the four notification types. */
function NotifyPanel() {
  const types = ['Task completions', 'Errors', 'Questions', 'Permission requests'];
  return (
    <div className="flex flex-col gap-2">
      <span className={caption}>Notification types</span>
      <Card className="divide-y">
        {types.map((t) => (
          <span key={t} className="text-foreground flex items-center justify-between px-4 py-3 text-base">
            {t}
            <span aria-hidden className="bg-foreground flex h-5 w-9 items-center justify-end rounded-full p-0.5">
              <span className="bg-background size-4 rounded-full" />
            </span>
          </span>
        ))}
      </Card>
    </div>
  );
}

/* ── CLI ─────────────────────────────────────────────────────────────── */

function Term({ lines }: { lines: Parameters<typeof TerminalFrame>[0]['lines'] }) {
  return <TerminalFrame title="~/arcadia" size="sm" lines={lines} />;
}

const CLI_PANELS: Record<string, () => ReactNode> = {
  start: () => (
    <Term
      lines={[
        { kind: 'cmd', text: 'kortix init arcadia' },
        { kind: 'cmd', text: 'cd arcadia' },
        { kind: 'cmd', text: 'kortix ship' },
        { kind: 'note', text: 'first run: creates the cloud project and its repo, then pushes' },
        { kind: 'gap' },
        { kind: 'cmd', text: 'kortix ship' },
        { kind: 'note', text: 'every run after: validate, commit, push' },
      ]}
    />
  ),
  run: () => (
    <Term
      lines={[
        { kind: 'cmd', text: `kortix chat --new -p "${PROMPT}"` },
        { kind: 'cmd', text: 'kortix chat -p "Also check the retry limit" --steer' },
        { kind: 'note', text: 'the running turn reads it at its next step' },
        { kind: 'gap' },
        { kind: 'cmd', text: 'kortix sessions status' },
        { kind: 'note', text: 'every session and what each agent is doing now' },
      ]}
    />
  ),
  review: () => (
    <Term
      lines={[
        { kind: 'cmd', text: 'kortix review ls' },
        { kind: 'cmd', text: 'kortix cr diff 12' },
        { kind: 'cmd', text: 'kortix cr merge 12' },
        { kind: 'ok', text: 'Merged CR #12 (fast-forward)  8c41d2e' },
        { kind: 'gap' },
        { kind: 'cmd', text: 'kortix cr request-changes 13 --message "Keep the old limit"' },
      ]}
    />
  ),
  admin: () => (
    <Term
      lines={[
        { kind: 'cmd', text: 'kortix members ls' },
        { kind: 'cmd', text: 'kortix roles ls' },
        { kind: 'cmd', text: 'kortix access grant --group support --agent triage' },
        { kind: 'note', text: 'the support group can now run the triage agent' },
        { kind: 'gap' },
        { kind: 'cmd', text: 'kortix audit ls --json' },
      ]}
    />
  ),
  'self-host': () => (
    <Term
      lines={[
        { kind: 'cmd', text: 'kortix self-host start --domain kortix.arcadia.example' },
        { kind: 'cmd', text: 'kortix self-host status' },
        { kind: 'gap' },
        { kind: 'cmd', text: 'kortix hosts use selfhost' },
        { kind: 'note', text: 'every command now talks to your instance' },
        { kind: 'cmd', text: 'kortix hosts use cloud' },
      ]}
    />
  ),
};

/* ── Slack ───────────────────────────────────────────────────────────── */

/** approval-card.ts: a connector call that needs approval. */
const SLACK_CONNECTOR: ChatCard = {
  kind: 'ask',
  title: 'Gmail · send email',
  detail: 'Send the incident summary to the billing list',
  actions: [{ label: 'Approve', primary: true }, { label: 'Deny' }, { label: 'Reply…' }, { label: 'Open in Kortix' }],
};

const SLACK_PANELS: Record<string, () => ReactNode> = {
  mention: () => (
    <div className="flex flex-col gap-3">
      <Thread
        label="# billing"
        messages={[
          { from: 'you', name: 'Member 1', time: '9:14', text: '@Kortix list yesterday’s failed webhooks by customer.' },
          { from: 'you', name: 'Member 2', time: '9:15', text: 'I can look at the retry config after.' },
        ]}
      />
      <span className="text-muted-foreground text-sm">The mention reaches the agent. The reply without one does not.</span>
    </div>
  ),
  progress: () => (
    <div className="flex flex-col gap-3">
      <ThreadCard card={FIX_STEPS} />
      <span className="text-foreground flex items-center gap-1.5 text-sm">
        Open session in Kortix
        <ArrowSquareOutIcon aria-hidden className="size-3.5" />
      </span>
    </div>
  ),
  approve: () => (
    <div className="flex flex-col gap-3">
      <ThreadCard card={SLACK_CR} />
      <ThreadCard card={SLACK_CONNECTOR} />
    </div>
  ),
  login: () => (
    <Card className="p-5">
      <ul>
        <Message
          message={{
            from: 'kortix',
            name: 'Kortix',
            time: '9:14',
            text: 'Kortix needs a linked Kortix account before it can run from Slack. Connect or create one to continue.',
            ephemeral: true,
            card: { kind: 'ask', title: '/kortix login', detail: 'The link works once and expires after 10 minutes.', actions: [{ label: 'Connect or create account', primary: true }] },
          }}
        />
      </ul>
    </Card>
  ),
  channel: () => (
    <Card>
      <span className="text-muted-foreground border-b px-4 py-3 font-mono text-xs">/kortix · # billing</span>
      <dl className="divide-y">
        {[
          ['Project', 'Arcadia'],
          ['Agent', 'kortix'],
          ['Model', 'The project default'],
        ].map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3 px-4 py-3">
            <dt className="text-muted-foreground text-sm">{k}</dt>
            <dd className="text-foreground text-sm">{v}</dd>
          </div>
        ))}
        <div className="flex flex-col gap-2 px-4 py-3">
          <dt className="text-muted-foreground text-sm">Who may join</dt>
          <dd className="flex flex-wrap gap-1.5">
            <span className="text-foreground rounded-md border px-2.5 py-1 text-sm">Open</span>
            <span className="text-muted-foreground px-2.5 py-1 text-sm">Approval</span>
            <span className="text-muted-foreground px-2.5 py-1 text-sm">Owner only</span>
          </dd>
        </div>
      </dl>
    </Card>
  ),
};

/* ── Teams ───────────────────────────────────────────────────────────── */

const TEAMS_PANELS: Record<string, () => ReactNode> = {
  where: () => (
    <Card className="divide-y">
      {[
        ['Personal chat', 'Every message reaches the agent. One session until /new.'],
        ['Group chat', 'Mention it. One session until /new.'],
        ['Channel', 'Mention it. Each post is its own session.'],
      ].map(([k, v]) => (
        <div key={k} className="flex flex-col gap-1 px-4 py-3.5">
          <span className="text-foreground text-base font-medium">{k}</span>
          <span className="text-muted-foreground text-sm text-pretty">{v}</span>
        </div>
      ))}
    </Card>
  ),
  card: () => (
    <div className="flex flex-col gap-3">
      <ThreadCard card={FIX_STEPS} />
      <Card className="w-fit min-w-56 py-1">
        <span className="text-muted-foreground flex items-center gap-2 px-3 py-1.5 text-xs">
          <DotsThreeIcon aria-hidden className="size-4" />
          More actions
        </span>
        <span className="text-foreground flex items-center gap-2 px-3 py-1.5 text-sm">
          <KortixLogo size={12} variant="symbol" />
          Open in Kortix
        </span>
      </Card>
    </div>
  ),
  approve: () => (
    <div className="flex flex-col gap-3">
      <ThreadCard card={TEAMS_CR} />
      <ThreadCard
        card={{
          kind: 'ask',
          title: 'Gmail · send email',
          detail: 'Send the incident summary to the billing list',
          actions: [{ label: 'Approve', primary: true }, { label: 'Deny' }],
        }}
      />
    </div>
  ),
  files: () => (
    <div className="flex flex-col gap-3">
      <ThreadCard
        card={{
          kind: 'ask',
          title: 'Kortix wants to send you weekly-report.pdf',
          detail: 'Personal chat · saved to your OneDrive when you accept',
          actions: [{ label: 'Accept', primary: true }, { label: 'Decline' }],
        }}
      />
      <Card className="max-w-md flex-row items-center gap-3 px-4 py-3">
        <FilePdfIcon aria-hidden className="text-foreground size-6 shrink-0" />
        <span className="flex min-w-0 flex-col">
          <span className="text-foreground text-sm font-medium">weekly-report.pdf</span>
          <span className="text-muted-foreground truncate text-xs">Channel · Billing › Files › Kortix (SharePoint)</span>
        </span>
      </Card>
    </div>
  ),
  setup: () => (
    <ol className="flex flex-col gap-2">
      {[
        ['A tenant admin grants consent', 'Once, for the whole organization.'],
        ['Kortix appears in your Teams catalog', 'Anyone adds it to a chat or a team.'],
        ['Each person sends /login', 'Once, so Kortix knows who asked.'],
      ].map(([k, v], i) => (
        <li key={k} className="bg-background flex items-start gap-3 rounded-lg border px-4 py-3">
          <span className="text-muted-foreground font-mono text-xs leading-6 tabular-nums">{i + 1}</span>
          <span className="flex flex-col gap-0.5">
            <span className="text-foreground text-base">{k}</span>
            <span className="text-muted-foreground text-sm">{v}</span>
          </span>
        </li>
      ))}
    </ol>
  ),
};

export const SURFACE_PANELS: Record<SurfaceId, Record<string, () => ReactNode>> = {
  desktop: {
    'quick-entry': () => <QuickEntryPanel />,
    connect: () => <ConnectPanel />,
    access: () => <AccessPanel />,
    badge: () => <BadgePanel />,
  },
  mobile: {
    start: () => <StartPanel />,
    permission: () => <PermissionPanel />,
    review: () => <ReviewPanel />,
    notify: () => <NotifyPanel />,
  },
  cli: CLI_PANELS,
  slack: SLACK_PANELS,
  teams: TEAMS_PANELS,
};
