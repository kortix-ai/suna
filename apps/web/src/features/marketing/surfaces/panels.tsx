import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import { localizeUiCatalog } from '@kortix/ui/i18n';
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
  PermissionCard,
  PROMPT,
  QuickEntryBar,
  FIX_STEPS as sourceFIX_STEPS,
  SLACK_CR as sourceSLACK_CR,
  TEAMS_CR as sourceTEAMS_CR,
} from './parts';

/*
 * One focused visual per "how it works" tab. Each fits the panel at 390 px:
 * one column, real text sizes, a few marks. Labels are the shipped ones; the
 * source is named above each panel.
 */

const caption = 'text-muted-foreground font-mono text-xs tracking-wide uppercase';

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('bg-background flex flex-col rounded-lg border', className)}>{children}</div>
  );
}

/* ── Desktop ─────────────────────────────────────────────────────────── */

/** quick-entry.js: the target picker lists a new session and the 5 most recent. */
function QuickEntryPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  const targets = [
    'New session',
    'Billing webhook retry',
    'Weekly pipeline summary',
    'Churned accounts, October',
  ];
  return (
    <div className="flex flex-col gap-3">
      <QuickEntryBar text={tMarketing('textc99712657966')} target="Billing webhook retry" />
      <Card className="max-w-2xl divide-y">
        {targets.map((t, i) => (
          <span
            key={t}
            className="text-foreground flex items-center justify-between px-4 py-2.5 text-sm"
          >
            {t}
            {i === 1 ? <CheckIcon aria-hidden className="size-4" /> : null}
          </span>
        ))}
      </Card>
      <span className="text-muted-foreground flex items-center gap-2 text-sm">
        <ImageIcon aria-hidden className="size-4" />
        {tMarketing('textc8ae89a96cc2')}
      </span>
    </div>
  );
}

/** guide.mdx "Connect your own computer": the three capabilities. */
function ConnectPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <Card>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <span className="text-foreground text-base font-medium">
          {tMarketing('textec38ae3185be')}
        </span>
        <span className="bg-muted text-foreground rounded-md px-2 py-0.5 text-xs">
          {tMarketing('textc080649df657')}
        </span>
      </div>
      <ul className="divide-y">
        <CheckRow
          title={tMarketing('text8230c68a6158')}
          detail="Read, write, list and delete files."
        />
        <CheckRow title={tMarketing('texta733285486d5')} detail="Run programs." />
        <CheckRow
          title={tMarketing('text5702cfb27036')}
          detail="See the screen and use the apps. macOS and Windows."
        />
      </ul>
    </Card>
  );
}

/** computer.js accessPrompt: the native prompt, 1 hour is the default button. */
function AccessPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-4 p-5">
        <span className="bg-foreground text-background flex size-9 items-center justify-center rounded-lg">
          <KortixLogo size={16} variant="symbol" />
        </span>
        <div className="flex flex-col gap-2">
          <span className="text-foreground text-base font-medium">
            {tMarketing('textfe1a97562904')}
          </span>
          <p className="text-muted-foreground text-sm text-pretty">
            {tMarketing('text57f26e9fc12a')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Chip>{tMarketing('text7077d449db71')}</Chip>
          <Chip primary>{tMarketing('text74deff8d23bc')}</Chip>
          <Chip>{tMarketing('text05a2d7332eb9')}</Chip>
        </div>
      </Card>
      <div className="flex flex-col gap-2">
        <span className={caption}>{tMarketing('textec5ba0abb717')}</span>
        <div className="flex flex-wrap gap-1.5">
          <span className="bg-background text-foreground rounded-md border px-3 py-1.5 text-sm">
            {tMarketing('text3be0feca7417')}
          </span>
          <span className="text-muted-foreground rounded-md px-3 py-1.5 text-sm">
            {tMarketing('text94387772bc12')}
          </span>
          <span className="text-muted-foreground rounded-md px-3 py-1.5 text-sm">
            {tMarketing('textca7981b46ecf')}
          </span>
        </div>
      </div>
    </div>
  );
}

/** attention-badge.js: the Dock count (a dot on Windows). */
function BadgePanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

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
          <span className="bg-kortix-red text-background absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full text-xs font-medium">
            2
          </span>
        </span>
        <span aria-hidden className="bg-muted size-11 rounded-lg" />
      </div>
      <Card className="divide-y">
        {[tMarketing('text864030882d32'), tMarketing('textaa92022ff787')].map((t) => (
          <span
            key={t}
            className="text-foreground flex items-center justify-between gap-3 px-4 py-3 text-sm"
          >
            {t}
            <span className="text-muted-foreground flex items-center gap-2 text-xs">
              {tMarketing('text7804f7a79a9e')}
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
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <Card className="gap-3 p-4">
      <span className="bg-muted text-foreground flex w-fit items-center gap-2 rounded-md px-2.5 py-1.5 text-sm">
        <ImageIcon aria-hidden className="size-4" />
        {tMarketing('text588d83f5e381')}
      </span>
      <span className="text-foreground text-base text-pretty">
        {tMarketing('texta17344bd48c4')}
      </span>
      <div className="text-muted-foreground flex items-center gap-3 border-t pt-3">
        <span className="text-foreground flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs">
          {tMarketing('text388f7968512c')}
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
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <div className="flex flex-col gap-4">
      <p className="text-foreground text-sm text-pretty">{tMarketing('text4c3f84b98c4e')}</p>
      <PermissionCard tool="bash" input="bun test src/billing" />
    </div>
  );
}

/** ReviewDetailSheet.tsx: the diff, then Request changes · Merge. */
function ReviewPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

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
        <span className="text-foreground text-base font-medium">
          {tMarketing('text9baf10b26300')}
        </span>
        <span className="text-muted-foreground text-xs">{tMarketing('text51b5c4ae0cad')}</span>
      </div>
      <span className="text-muted-foreground border-b px-4 py-2 font-mono text-xs">
        {tMarketing('text8fb80e5e42b5')}
      </span>
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
        <Chip className="justify-center">{tMarketing('textcb5d9f987803')}</Chip>
        <Chip primary className="justify-center">
          {tMarketing('text8851aaa7d08c')}
        </Chip>
      </div>
    </Card>
  );
}

/** apps/mobile/app/(settings)/notifications.tsx: the four notification types. */
function NotifyPanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  const types = ['Task completions', 'Errors', 'Questions', 'Permission requests'];
  return (
    <div className="flex flex-col gap-2">
      <span className={caption}>{tMarketing('text6e3032b6895f')}</span>
      <Card className="divide-y">
        {types.map((t) => (
          <span
            key={t}
            className="text-foreground flex items-center justify-between px-4 py-3 text-base"
          >
            {t}
            <span
              aria-hidden
              className="bg-foreground flex h-5 w-9 items-center justify-end rounded-full p-0.5"
            >
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
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return <TerminalFrame title={tMarketing('text50d2fe510abe')} size="sm" lines={lines} />;
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
const sourceSLACK_CONNECTOR: ChatCard = {
  kind: 'ask',
  title: 'Gmail · send email',
  detail: 'Send the incident summary to the billing list',
  actions: [
    { label: 'Approve', primary: true },
    { label: 'Deny' },
    { label: 'Reply…' },
    { label: 'Open in Kortix' },
  ],
};

const SLACK_PANELS: Record<string, () => ReactNode> = {
  mention: function MentionPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    return (
      <div className="flex flex-col gap-3">
        <Thread
          label={tMarketing('text548554556990')}
          messages={[
            {
              from: 'you',
              name: 'Member 1',
              time: '9:14',
              text: '@Kortix list yesterday’s failed webhooks by customer.',
            },
            {
              from: 'you',
              name: 'Member 2',
              time: '9:15',
              text: 'I can look at the retry config after.',
            },
          ]}
        />
        <span className="text-muted-foreground text-sm">{tMarketing('text62bacaf80a26')}</span>
      </div>
    );
  },
  progress: function ProgressPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    const { FIX_STEPS } = localizeUiCatalog(
      { FIX_STEPS: sourceFIX_STEPS },
      tMarketing,
      MARKETING_RELEASE_TRANSLATION_KEYS,
    );
    return (
      <div className="flex flex-col gap-3">
        <ThreadCard card={FIX_STEPS} />
        <span className="text-foreground flex items-center gap-1.5 text-sm">
          {tMarketing('textb45d7172ae1b')}
          <ArrowSquareOutIcon aria-hidden className="size-3.5" />
        </span>
      </div>
    );
  },
  approve: function ApprovePanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    const { SLACK_CR } = localizeUiCatalog(
      { SLACK_CR: sourceSLACK_CR },
      tMarketing,
      MARKETING_RELEASE_TRANSLATION_KEYS,
    );

    const { SLACK_CONNECTOR } = localizeUiCatalog(
      { SLACK_CONNECTOR: sourceSLACK_CONNECTOR },
      tMarketing,
      MARKETING_RELEASE_TRANSLATION_KEYS,
    );
    return (
      <div className="flex flex-col gap-3">
        <ThreadCard card={SLACK_CR} />
        <ThreadCard card={SLACK_CONNECTOR} />
      </div>
    );
  },
  login: function LoginPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    return (
      <Card className="p-5">
        <ul>
          <Message
            message={{
              from: 'kortix',
              name: 'Kortix',
              time: '9:14',
              text: tMarketing('text12f56545b0a4'),
              ephemeral: true,
              card: {
                kind: 'ask',
                title: tMarketing('text2b7dbeb70c44'),
                detail: tMarketing('text648759a01692'),
                actions: [{ label: tMarketing('textebf56b7cfaf7'), primary: true }],
              },
            }}
          />
        </ul>
      </Card>
    );
  },
  channel: function ChannelPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    return (
      <Card>
        <span className="text-muted-foreground border-b px-4 py-3 font-mono text-xs">
          {tMarketing('textf31e9449b514')}
        </span>
        <dl className="divide-y">
          {[
            ['Project', 'Arcadia'],
            ['Agent', 'kortix'],
            ['Model', tMarketing('text946410b30cd8')],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-3 px-4 py-3">
              <dt className="text-muted-foreground text-sm">{k}</dt>
              <dd className="text-foreground text-sm">{v}</dd>
            </div>
          ))}
          <div className="flex flex-col gap-2 px-4 py-3">
            <dt className="text-muted-foreground text-sm">{tMarketing('text2d190d51d387')}</dt>
            <dd className="flex flex-wrap gap-1.5">
              <span className="text-foreground rounded-md border px-2.5 py-1 text-sm">
                {tMarketing('texted077f3d8125')}
              </span>
              <span className="text-muted-foreground px-2.5 py-1 text-sm">
                {tMarketing('text147fb813a251')}
              </span>
              <span className="text-muted-foreground px-2.5 py-1 text-sm">
                {tMarketing('text55a834c80aa9')}
              </span>
            </dd>
          </div>
        </dl>
      </Card>
    );
  },
};

/* ── Teams ───────────────────────────────────────────────────────────── */

const TEAMS_PANELS: Record<string, () => ReactNode> = {
  where: function WherePanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    return (
      <Card className="divide-y">
        {[
          [tMarketing('text895ce927db2e'), tMarketing('textcf7a9a50fdfd')],
          [tMarketing('text28c7d3f8b75d'), tMarketing('texte48f2d548989')],
          ['Channel', tMarketing('texte31204e91d82')],
        ].map(([k, v]) => (
          <div key={k} className="flex flex-col gap-1 px-4 py-3.5">
            <span className="text-foreground text-base font-medium">{k}</span>
            <span className="text-muted-foreground text-sm text-pretty">{v}</span>
          </div>
        ))}
      </Card>
    );
  },
  card: function CardPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    const { FIX_STEPS } = localizeUiCatalog(
      { FIX_STEPS: sourceFIX_STEPS },
      tMarketing,
      MARKETING_RELEASE_TRANSLATION_KEYS,
    );
    return (
      <div className="flex flex-col gap-3">
        <ThreadCard card={FIX_STEPS} />
        <Card className="w-fit min-w-56 py-1">
          <span className="text-muted-foreground flex items-center gap-2 px-3 py-1.5 text-xs">
            <DotsThreeIcon aria-hidden className="size-4" />
            {tMarketing('textf8d46c2570e7')}
          </span>
          <span className="text-foreground flex items-center gap-2 px-3 py-1.5 text-sm">
            <KortixLogo size={12} variant="symbol" />
            {tMarketing('text9df141eadb06')}
          </span>
        </Card>
      </div>
    );
  },
  approve: function ApprovePanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    const { TEAMS_CR } = localizeUiCatalog(
      { TEAMS_CR: sourceTEAMS_CR },
      tMarketing,
      MARKETING_RELEASE_TRANSLATION_KEYS,
    );
    return (
      <div className="flex flex-col gap-3">
        <ThreadCard card={TEAMS_CR} />
        <ThreadCard
          card={{
            kind: 'ask',
            title: tMarketing('text85860868d9a3'),
            detail: tMarketing('textd51c57de7dea'),
            actions: [
              { label: tMarketing('text6007acbe30b2'), primary: true },
              { label: tMarketing('text05a2d7332eb9') },
            ],
          }}
        />
      </div>
    );
  },
  files: function FilesPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    return (
      <div className="flex flex-col gap-3">
        <ThreadCard
          card={{
            kind: 'ask',
            title: tMarketing('textf776e83e1e93'),
            detail: tMarketing('texte91810d67487'),
            actions: [
              { label: tMarketing('text89713b9c9c1b'), primary: true },
              { label: tMarketing('texta2d285b35287') },
            ],
          }}
        />
        <Card className="max-w-md flex-row items-center gap-3 px-4 py-3">
          <FilePdfIcon aria-hidden className="text-foreground size-6 shrink-0" />
          <span className="flex min-w-0 flex-col">
            <span className="text-foreground text-sm font-medium">
              {tMarketing('text871efeb0931c')}
            </span>
            <span className="text-muted-foreground truncate text-xs">
              {tMarketing('text2452f196b7ba')}
            </span>
          </span>
        </Card>
      </div>
    );
  },
  setup: function SetupPanel() {
    const tMarketing = useTranslations('hardcodedUi.i18nComplete');
    return (
      <ol className="flex flex-col gap-2">
        {[
          [tMarketing('text701c48e06acb'), tMarketing('textd9905a14ebe5')],
          [tMarketing('textb655efcadbd3'), tMarketing('text807c564fc208')],
          [tMarketing('text31fd5145f2e2'), tMarketing('text22ce6aa00218')],
        ].map(([k, v], i) => (
          <li key={k} className="bg-background flex items-start gap-3 rounded-lg border px-4 py-3">
            <span className="text-muted-foreground font-mono text-xs leading-6 tabular-nums">
              {i + 1}
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="text-foreground text-base">{k}</span>
              <span className="text-muted-foreground text-sm">{v}</span>
            </span>
          </li>
        ))}
      </ol>
    );
  },
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
