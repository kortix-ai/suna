'use client';

/**
 * /debug/toast — every toast variant, rendered inline and triggerable.
 *
 * Mirrors the Paper boards "Toasts · Linear-style system + task-complete
 * notification": 01 (status, actions, compact/undo) and 02 (task complete,
 * failed turn, several at once) — then every notification kind and the real
 * app call sites with their shipped copy. Each preview is the real card component at
 * sonner's 356px width; "Trigger" fires the real factory to check position,
 * stacking and motion. Theme: the /debug toggle, or press `D`.
 */

import { type CSSProperties, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { IconDelete } from '@/components/ui/kortix-icons';
import {
  errorToast,
  infoToast,
  loadingToast,
  successToast,
  ToastCard,
  toastIcon,
  undoToast,
  UndoToastCard,
  warningToast,
} from '@/components/ui/toast';
import { SessionFailedCard, SessionStackCard } from '@/features/notifications/session-toast-cards';
import {
  NOTIFICATION_TOAST_VARIANT,
  showInAppNotification,
  type WebNotificationPayload,
} from '@/lib/web-notifications';
import { triggerToastEntity } from '@/components/projects/schedule/trigger-toast';
import { ArchiveIcon, ClockIcon } from '@phosphor-icons/react';

const SONNER_WIDTH = { '--width': '356px' } as CSSProperties;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const noop = () => undefined;

interface DebugCase {
  title: string;
  preview: ReactNode;
  fire: () => void;
}

const card = (
  message: string,
  variant: Parameters<typeof toastIcon>[0],
  options?: Parameters<typeof ToastCard>[0]['options'],
) => (
  <ToastCard
    message={message}
    icon={toastIcon(variant)}
    variant={variant}
    options={options}
    onDismiss={noop}
  />
);

const STATUS: DebugCase[] = [
  {
    title: 'successToast',
    preview: card('Project created', 'success'),
    fire: () => successToast('Project created'),
  },
  {
    title: 'successToast + description',
    preview: card('Changes saved', 'success', {
      description: 'Your settings apply to every new session.',
    }),
    fire: () =>
      successToast('Changes saved', { description: 'Your settings apply to every new session.' }),
  },
  {
    title: 'errorToast + description',
    preview: card('Could not save changes', 'error', {
      description: 'The API returned 409. Someone else edited this project.',
    }),
    fire: () =>
      errorToast('Could not save changes', {
        description: 'The API returned 409. Someone else edited this project.',
      }),
  },
  {
    title: 'warningToast + description',
    preview: card('Credits are running low', 'warning', {
      description: '$4.20 left. Sessions pause at $0.',
    }),
    fire: () =>
      warningToast('Credits are running low', { description: '$4.20 left. Sessions pause at $0.' }),
  },
  {
    title: 'infoToast',
    preview: card('Message copied', 'info'),
    fire: () => infoToast('Message copied'),
  },
  {
    title: 'loadingToast (resolves → success after 2 s)',
    preview: card('Indexing files', 'progress', { description: '128 of 342' }),
    fire: () =>
      void loadingToast('Indexing files', () => wait(2000), {
        description: '128 of 342',
        success: 'Indexed 342 files',
      }),
  },
];

const ACTIONS: DebugCase[] = [
  {
    title: 'entity + link',
    preview: card('Trigger created', 'success', {
      entity: { icon: <ClockGlyph />, label: 'Weekly revenue digest · Mon 9:00' },
      actions: [{ label: 'View trigger', onClick: noop }],
    }),
    fire: () =>
      successToast('Trigger created', {
        entity: { icon: <ClockGlyph />, label: 'Weekly revenue digest · Mon 9:00' },
        actions: [{ label: 'View trigger', onClick: noop }],
      }),
  },
  {
    title: 'error + two links',
    preview: card('Upload failed', 'error', {
      description: 'report-q3.pdf is larger than 50 MB.',
      actions: [
        { label: 'Try again', onClick: noop },
        { label: 'Copy error', onClick: noop },
      ],
    }),
    fire: () =>
      errorToast('Upload failed', {
        description: 'report-q3.pdf is larger than 50 MB.',
        actions: [
          { label: 'Try again', onClick: noop },
          { label: 'Copy error', onClick: noop },
        ],
      }),
  },
];

const COMPACT: DebugCase[] = [
  {
    title: 'undoToast',
    preview: (
      <UndoToastCard
        message="Session archived"
        icon={<ArchiveIcon className="size-4" />}
        undoLabel="Undo"
        onUndo={noop}
        onDismiss={noop}
      />
    ),
    fire: () =>
      undoToast('Session archived', {
        icon: <ArchiveIcon className="size-4" />,
        undoLabel: 'Undo',
        onUndo: () => infoToast('Restored'),
      }),
  },
  {
    title: 'undoToast · delete',
    preview: (
      <UndoToastCard
        message="3 files deleted"
        icon={<IconDelete className="size-4" />}
        undoLabel="Undo"
        onUndo={noop}
        onDismiss={noop}
      />
    ),
    fire: () =>
      undoToast('3 files deleted', {
        icon: <IconDelete className="size-4" />,
        undoLabel: 'Undo',
        onUndo: () => infoToast('Restored'),
      }),
  },
  {
    title: 'successToast · compact',
    preview: card('Invite link copied', 'success', { compact: true }),
    fire: () => successToast('Invite link copied', { compact: true }),
  },
];

const SESSION_A = 'debug-0000-a';
const SESSION_B = 'debug-0000-b';

const completion = (sessionId: string, entityLabel: string): WebNotificationPayload => ({
  type: 'completion',
  title: 'Task Complete',
  body: `"${entityLabel}" has finished.`,
  sessionId,
  entityLabel,
  actionLabel: 'Open',
  openSessionLabel: 'Open session',
  stackTitle: (count) => `${count} tasks finished`,
});

const failure = (sessionId: string, entityLabel: string): WebNotificationPayload => ({
  type: 'error',
  title: 'Session Error',
  body: `"${entityLabel}": The browser tool timed out.`,
  sessionId,
  entityLabel,
  preview: 'The browser tool timed out twice on the pricing page. A retry usually works.',
  actionLabel: 'Open',
  stackTitle: (count) => `${count} tasks finished`,
});

const SESSIONS: DebugCase[] = [
  {
    title: 'A · task complete',
    preview: card('Task Complete', 'success', {
      entity: { label: 'Competitor pricing research for Q4 launch' },
      actions: [{ label: 'Open session', onClick: noop }],
    }),
    fire: () => showInAppNotification(completion(SESSION_A, 'Competitor pricing research for Q4 launch')),
  },
  {
    title: 'B · failed turn',
    preview: (
      <SessionFailedCard
        label="Competitor pricing research for Q4 launch"
        meta="Session Error"
        preview="The browser tool timed out twice on the pricing page. A retry usually works."
        openLabel="Open"
        onOpen={noop}
        onDismiss={noop}
      />
    ),
    fire: () => showInAppNotification(failure(SESSION_B, 'Competitor pricing research for Q4 launch')),
  },
  {
    title: 'D · several at once (fires 3 in a row)',
    preview: (
      <SessionStackCard
        title="3 tasks finished"
        openLabel="Open"
        items={[
          { sessionId: '1', label: 'Competitor pricing research for Q4 launch', failed: false, at: Date.now() },
          { sessionId: '2', label: 'Weekly revenue digest', failed: false, at: Date.now() - 120_000 },
          { sessionId: '3', label: 'Clean up stale feature flags', failed: true, at: Date.now() - 300_000 },
        ]}
        onOpen={noop}
        onDismiss={noop}
      />
    ),
    fire: () => {
      showInAppNotification(completion('debug-1', 'Competitor pricing research for Q4 launch'));
      setTimeout(() => showInAppNotification(completion('debug-2', 'Weekly revenue digest')), 600);
      setTimeout(() => showInAppNotification(failure('debug-3', 'Clean up stale feature flags')), 1200);
    },
  },
];

/**
 * Every other notification kind, in the payload shape its sender builds
 * (`notifyQuestion`, `notifyPermissionRequest`, the inbox OS path). The
 * preview uses the same kind → variant map the real toast does.
 */
const notification = (
  type: WebNotificationPayload['type'],
  title: string,
  body: string,
  actionLabel: string,
): WebNotificationPayload => ({
  type,
  title,
  body,
  actionLabel,
  href: '/debug/toast',
  tag: `${type}:debug`,
});

const notificationCase = (label: string, payload: WebNotificationPayload): DebugCase => ({
  title: label,
  preview: card(payload.inAppTitle ?? payload.title, NOTIFICATION_TOAST_VARIANT[payload.type], {
    description: payload.entityLabel ? payload.preview : payload.body,
    entity: payload.entityLabel
      ? { icon: <ClockIcon className="size-3.5" />, label: payload.entityLabel }
      : undefined,
    actions: [{ label: payload.actionLabel ?? 'Open', onClick: noop }],
  }),
  fire: () => showInAppNotification(payload),
});

/** An automation alert, the way notification-host builds it from an inbox row. */
const automationAlert = (
  type: 'automation_failed' | 'automation_recovered',
  name: string,
  kindLine: string,
  detail: string | undefined,
  actionLabel: string,
): WebNotificationPayload => ({
  ...notification(type, name, detail ?? kindLine, actionLabel),
  inAppTitle: kindLine,
  entityLabel: name,
  preview: detail,
});

const NOTIFICATIONS: DebugCase[] = [
  notificationCase(
    'question · agent needs input',
    notification(
      'question',
      'Input Needed',
      '"Competitor pricing research": Which regions should I include: US only, or US and EU?',
      'Open',
    ),
  ),
  notificationCase(
    'permission · tool approval',
    notification(
      'permission',
      'Permission Requested',
      '"Competitor pricing research" needs permission for: bash',
      'Open',
    ),
  ),
  notificationCase(
    'shared · session shared with you',
    notification('shared', 'A teammate shared "Q4 launch plan"', 'Shared with you in Growth', 'Open session'),
  ),
  notificationCase(
    'automation_failed · trigger failing',
    automationAlert(
      'automation_failed',
      'Weekly revenue digest',
      'Failure alert in Growth',
      'The last 3 runs failed: the Stripe connection expired.',
      'Open triggers',
    ),
  ),
  notificationCase(
    'automation_failed · reminder failing',
    automationAlert(
      'automation_failed',
      'Standup summary',
      'Failure alert in Growth',
      'The last 3 runs failed.',
      'Open reminders',
    ),
  ),
  notificationCase(
    'automation_recovered · trigger works again',
    automationAlert(
      'automation_recovered',
      'Weekly revenue digest',
      'Recovery alert in Growth',
      undefined,
      'Open triggers',
    ),
  ),
  notificationCase(
    'capture_device_down',
    notification(
      'capture_device_down',
      'Capture computer stopped recording',
      'Capture computer stopped in Growth',
      'Open',
    ),
  ),
  notificationCase(
    'capture_device_recovered',
    notification(
      'capture_device_recovered',
      'Capture computer is recording again',
      'Capture computer recording again in Growth',
      'Open',
    ),
  ),
  {
    title: 'inbox arrival · notification center row',
    preview: card('Competitor pricing research', 'info', {
      description: 'Turn finished in Growth',
      actions: [{ label: 'Open session', onClick: noop }],
    }),
    fire: () =>
      infoToast('Competitor pricing research', {
        description: 'Turn finished in Growth',
        actions: [{ label: 'Open session', onClick: noop }],
      }),
  },
];

const CRON = { name: 'Weekly revenue digest', type: 'cron' } as const;
const WEBHOOK = { name: 'Stripe payment webhook', type: 'webhook' } as const;
const EVENT = { name: 'New Linear issue', type: 'event' } as const;

const triggerCase = (
  title: string,
  message: string,
  variant: 'success' | 'error',
  options: Parameters<typeof successToast>[1],
): DebugCase => ({
  title,
  preview: card(message, variant, options),
  fire: () => (variant === 'error' ? errorToast : successToast)(message, options),
});

/** The trigger toasts (Triggers tab, agent triggers, the composer), real copy. */
const TRIGGERS: DebugCase[] = [
  triggerCase('schedule created (composer)', 'Schedule created', 'success', {
    entity: triggerToastEntity(CRON, 'Mon 9:00'),
  }),
  triggerCase('webhook created (composer)', 'Webhook created', 'success', {
    entity: triggerToastEntity(WEBHOOK),
    description: 'Copy its address from the panel to finish setup.',
  }),
  triggerCase('app event created (composer)', 'App event created', 'success', {
    entity: triggerToastEntity(EVENT),
  }),
  triggerCase('run · started with a session', 'Started', 'success', {
    entity: triggerToastEntity(CRON),
    actions: [{ label: 'Open session', onClick: noop }],
  }),
  triggerCase('run · started, session pending', 'Started', 'success', {
    entity: triggerToastEntity(CRON),
    description: 'Getting a session ready',
  }),
  triggerCase('run · queued', 'Queued', 'success', {
    entity: triggerToastEntity(CRON),
    description: 'Busy right now — it will retry',
  }),
  triggerCase('run · could not start', 'It could not start', 'error', {
    entity: triggerToastEntity(CRON),
    description: 'The agent "analyst" no longer exists.',
  }),
  triggerCase('paused', 'Paused', 'success', { entity: triggerToastEntity(CRON) }),
  triggerCase('resumed', 'Resumed', 'success', { entity: triggerToastEntity(CRON) }),
  triggerCase('deleted', 'Schedule deleted', 'success', { entity: triggerToastEntity(CRON) }),
];

/** Real call sites, with the copy they ship. */
const APP: DebugCase[] = [
  {
    title: 'session deleted · undo (session-delete-modal)',
    preview: (
      <UndoToastCard
        message={'"Fix the login bug" deleted'}
        icon={<IconDelete className="size-4" />}
        undoLabel="Undo"
        onUndo={noop}
        onDismiss={noop}
      />
    ),
    fire: () =>
      undoToast('"Fix the login bug" deleted', {
        icon: <IconDelete className="size-4" />,
        undoLabel: 'Undo',
        duration: 8000,
        onUndo: () => void loadingToast('Restoring the session…', () => wait(1500), { success: 'Session restored' }),
      }),
  },
  {
    title: 'queued message removed · undo (session-chat)',
    preview: (
      <UndoToastCard message="Removed from queue" undoLabel="Undo" onUndo={noop} onDismiss={noop} />
    ),
    fire: () => undoToast('Removed from queue', { undoLabel: 'Undo', onUndo: noop }),
  },
  {
    title: 'restoring a session (progress → success)',
    preview: card('Restoring the session…', 'progress'),
    fire: () =>
      void loadingToast('Restoring the session…', () => wait(2000), { success: 'Session restored' }),
  },
  {
    title: 'merge conflict · solve with agent (review center)',
    preview: card('This change has merge conflicts', 'error', {
      description: 'Start an agent session to solve them.',
      actions: [{ label: 'Solve with agent', onClick: noop }],
    }),
    fire: () =>
      errorToast('This change has merge conflicts', {
        description: 'Start an agent session to solve them.',
        actions: [{ label: 'Solve with agent', onClick: noop }],
      }),
  },
  {
    title: 'invite email skipped · copy link (members)',
    preview: card('Email skipped — copy invite link to share manually', 'warning', {
      actions: [{ label: 'Copy link', onClick: noop }],
    }),
    fire: () =>
      warningToast('Email skipped — copy invite link to share manually', {
        actions: [{ label: 'Copy link', onClick: noop }],
      }),
  },
  {
    title: 'managed git missing · open settings (marketplace)',
    preview: card("Managed git isn't set up on this server", 'error', {
      description: 'An admin needs to connect GitHub in Git settings before projects can be created.',
      actions: [{ label: 'Open Git settings', onClick: noop }],
    }),
    fire: () =>
      errorToast("Managed git isn't set up on this server", {
        description: 'An admin needs to connect GitHub in Git settings before projects can be created.',
        actions: [{ label: 'Open Git settings', onClick: noop }],
      }),
  },
];

function ClockGlyph() {
  return (
    <svg viewBox="0 0 14 14" className="size-3.5" aria-hidden="true">
      <circle cx="7" cy="7" r="5.6" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <path d="M7 4.2V7l1.9 1.2" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function Section({ title, cases }: { title: string; cases: DebugCase[] }) {
  return (
    <section className="flex flex-col">
      <h2 className="text-muted-foreground pb-2 font-mono text-xs tracking-wide uppercase">{title}</h2>
      {cases.map((c) => (
        <div
          key={c.title}
          className="border-border flex flex-col gap-3 border-b py-5 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground font-mono text-xs">{c.title}</p>
            <Button size="sm" variant="outline" className="self-start" onClick={c.fire}>
              Trigger
            </Button>
          </div>
          <div style={SONNER_WIDTH} className="w-[356px] max-w-full">
            {c.preview}
          </div>
        </div>
      ))}
    </section>
  );
}

export default function DebugToastPage() {
  const all = [...STATUS, ...ACTIONS, ...COMPACT];
  const fireAll = () => all.forEach((c, i) => setTimeout(c.fire, i * 150));

  return (
    <div className="bg-background text-foreground min-h-screen px-4 py-8 sm:px-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-medium">Toasts</h1>
          <Button size="sm" onClick={fireAll}>
            Trigger all
          </Button>
        </div>
        <Section title="Status" cases={STATUS} />
        <Section title="With actions" cases={ACTIONS} />
        <Section title="Compact · undo" cases={COMPACT} />
        <Section title="Task complete" cases={SESSIONS} />
        <Section title="Triggers" cases={TRIGGERS} />
        <Section title="Notifications · every kind" cases={NOTIFICATIONS} />
        <Section title="App toasts · real copy" cases={APP} />
      </div>
    </div>
  );
}
