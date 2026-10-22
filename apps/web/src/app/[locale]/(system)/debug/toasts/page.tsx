'use client';

/**
 * /debug/toasts — every toast the app draws, side by side, plus buttons that
 * fire the real ones through sonner.
 *
 * The "Session error" cases are synthetic `session.error` payloads. Each one
 * runs through the reader the SDK notification uses (the gateway sentence,
 * else `unwrapError`), is checked against the expected sentence, and renders
 * the real `SessionFailedCard`. No network, no session. Theme: the /debug
 * toggle, or press `D`.
 */

import { useState } from 'react';

import { Button } from '@kortix/ui/button';
import {
  customToast,
  errorToast,
  infoToast,
  loadingToast,
  successToast,
  ToastCard,
  toastIcon,
  undoToast,
  warningToast,
  type ToastVariant,
} from '@kortix/ui/toast';
import { SessionFailedCard, SessionStackCard } from '@kortix/ui/internal/notifications/session-toast-cards';
import { extractGatewayErrorDetails, unwrapError } from '@kortix/sdk';
import { CheckCircleIcon, ClockIcon, GitPullRequestIcon, XCircleIcon } from '@phosphor-icons/react';

const noop = () => {};

/** The sentence a session-error notification shows — the SDK's rule. */
const sentenceOf = (error: unknown) =>
  extractGatewayErrorDetails(error)?.message || unwrapError(error);

interface ErrorCase {
  title: string;
  error: unknown;
  sentence: string;
}

const ERROR_CASES: ErrorCase[] = [
  {
    title: 'Model not available on the account (the reported toast)',
    error: {
      name: 'APIError',
      data: {
        message: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
        isRetryable: false,
      },
    },
    sentence: "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
  },
  {
    title: 'Gateway body behind the HTTP status text',
    error: {
      name: 'APIError',
      data: {
        message: 'Bad Request',
        statusCode: 400,
        responseBody: JSON.stringify({
          error: { message: 'Insufficient credits.', code: 'insufficient_credits' },
        }),
      },
    },
    sentence: 'Insufficient credits.',
  },
  {
    title: 'Provider body serialized into the message',
    error: {
      name: 'UnknownError',
      data: { message: '{"message":"Provided authentication token is expired.","code":401}' },
    },
    sentence: 'Provided authentication token is expired.',
  },
  {
    title: 'Provider auth error',
    error: {
      name: 'ProviderAuthError',
      data: { providerID: 'anthropic', message: 'Invalid API key.' },
    },
    sentence: 'Invalid API key.',
  },
  {
    title: 'Long sentence (wraps, never truncates mid-word)',
    error: {
      name: 'UnknownError',
      data: {
        message:
          'The request was rejected because the conversation is longer than the context window of the selected model. Start a new session or compact this one, then send the message again.',
      },
    },
    sentence:
      'The request was rejected because the conversation is longer than the context window of the selected model. Start a new session or compact this one, then send the message again.',
  },
  {
    title: 'No message at all',
    error: { name: 'MessageOutputLengthError', data: {} },
    sentence: 'An error occurred',
  },
];

const VARIANTS: { variant: ToastVariant; message: string; description?: string }[] = [
  { variant: 'success', message: 'Project created' },
  {
    variant: 'error',
    message: 'Could not save',
    description: 'The server did not answer. Try again.',
  },
  {
    variant: 'warning',
    message: 'Sandbox is waking up',
    description: 'This takes about 20 seconds.',
  },
  { variant: 'info', message: 'Settings saved' },
  { variant: 'progress', message: 'Uploading 3 files' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-muted-foreground text-xs font-medium">{title}</h2>
      {children}
    </section>
  );
}

/** A fixed-width slot, so every card renders at the toaster's width. */
function Slot({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[22rem] [--width:22rem]">{children}</div>;
}

function Verdict({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircleIcon weight="fill" className="text-kortix-green size-4" />
  ) : (
    <XCircleIcon weight="fill" className="text-kortix-red size-4" />
  );
}

export default function ToastsDebugPage() {
  const results = ERROR_CASES.map((c) => {
    const actual = sentenceOf(c.error);
    return { ...c, actual, ok: actual === c.sentence };
  });
  const failed = results.filter((r) => !r.ok).length;
  const [now] = useState(() => Date.now());

  return (
    <main className="bg-background text-foreground min-h-screen px-4 py-10">
      <div className="mx-auto flex max-w-4xl flex-col gap-10">
        <header className="flex flex-col gap-1">
          <h1 className="text-base font-medium">Toasts</h1>
          <p className="text-muted-foreground text-xs">
            Session error sentences: {results.length - failed} of {results.length} pass.
          </p>
        </header>

        <Section title="Fire the real toasts">
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="outline" onClick={() => successToast('Project created')}>
              Success
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                errorToast('Could not save', {
                  description: 'The server did not answer. Try again.',
                })
              }
            >
              Error
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => warningToast('Sandbox is waking up')}
            >
              Warning
            </Button>
            <Button size="xs" variant="outline" onClick={() => infoToast('Settings saved')}>
              Info
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                loadingToast(
                  'Uploading 3 files',
                  () => new Promise((done) => setTimeout(done, 3000)),
                  {
                    success: 'Uploaded 3 files',
                  },
                )
              }
            >
              Progress
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => successToast('Copied', { compact: true })}
            >
              Compact
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => undoToast('Session deleted', { undoLabel: 'Undo', onUndo: noop })}
            >
              Undo
            </Button>
            {results.slice(0, 2).map((r, i) => (
              <Button
                key={r.title}
                size="xs"
                variant="outline"
                onClick={() =>
                  customToast(
                    (dismiss) => (
                      <SessionFailedCard
                        title="Session error"
                        detail={r.actual}
                        openLabel="Open"
                        onOpen={noop}
                        onDismiss={dismiss}
                      />
                    ),
                    { id: `debug-session-error-${i}` },
                  )
                }
              >
                Session error {i + 1}
              </Button>
            ))}
          </div>
        </Section>

        <Section title="Session error">
          <div className="grid gap-6 sm:grid-cols-2">
            {results.map((r) => (
              <div key={r.title} className="flex flex-col gap-2">
                <div className="flex items-start gap-2">
                  <Verdict ok={r.ok} />
                  <div className="flex min-w-0 flex-col">
                    <p className="text-xs font-medium">{r.title}</p>
                    {!r.ok && (
                      <p className="text-kortix-red text-xs">
                        Expected “{r.sentence}”, got “{r.actual}”.
                      </p>
                    )}
                  </div>
                </div>
                <Slot>
                  <SessionFailedCard
                    title="Session error"
                    detail={r.actual}
                    openLabel="Open"
                    onOpen={noop}
                    onDismiss={noop}
                  />
                </Slot>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Turn opened a change request: Review, then Open session">
          <div className="grid gap-4 sm:grid-cols-2">
            <Slot>
              <ToastCard
                message="Task complete"
                icon={toastIcon('success')}
                variant="success"
                options={{
                  entity: { icon: <GitPullRequestIcon />, label: 'Add building-blog' },
                  description: 'Change request #1 is ready to review.',
                  actions: [
                    { label: 'Review', onClick: noop },
                    { label: 'Open session', onClick: noop },
                  ],
                }}
                onDismiss={noop}
              />
            </Slot>
            <Slot>
              <ToastCard
                message="Task complete"
                icon={toastIcon('success')}
                variant="success"
                options={{ description: 'Change request #1 is ready to review.' }}
                onDismiss={noop}
              />
            </Slot>
          </div>
        </Section>

        <Section title="Marketplace install started: the page stays, the toast offers the session">
          <Slot>
            <ToastCard
              message="Adding building blog to Website"
              icon={toastIcon('success')}
              variant="success"
              options={{
                description:
                  'It sets up in the background. You get a notification when it is done.',
                actions: [{ label: 'Open session', onClick: noop }],
              }}
              onDismiss={noop}
            />
          </Slot>
        </Section>

        <Section title="Several turns at once">
          <Slot>
            <SessionStackCard
              title="3 tasks finished"
              openLabel="Open"
              onOpen={noop}
              onDismiss={noop}
              items={[
                { sessionId: 'a', label: 'Quarterly report', failed: false, at: now - 180_000 },
                { sessionId: 'b', label: 'Fix the login redirect', failed: true, at: now - 60_000 },
                { sessionId: 'c', label: 'New session', failed: false, at: now },
              ]}
            />
          </Slot>
        </Section>

        <Section title="Session on screen (fired while the window had no focus): no name, no link">
          <div className="grid gap-4 sm:grid-cols-2">
            <Slot>
              <ToastCard
                message="Task complete"
                icon={toastIcon('success')}
                variant="success"
                onDismiss={noop}
              />
            </Slot>
            <Slot>
              <SessionFailedCard
                title="Session error"
                detail={results[0].actual}
                openLabel="Open"
                onDismiss={noop}
              />
            </Slot>
          </div>
        </Section>

        <Section title="Another session: its name and Open">
          <div className="grid gap-4 sm:grid-cols-2">
            <Slot>
              <ToastCard
                message="Task complete"
                icon={toastIcon('success')}
                variant="success"
                options={{
                  entity: { label: 'Quarterly report' },
                  actions: [{ label: 'Open session', onClick: noop }],
                }}
                onDismiss={noop}
              />
            </Slot>
            <Slot>
              <SessionFailedCard
                title="Session error"
                label="Fix the login redirect"
                detail={results[0].actual}
                openLabel="Open session"
                onOpen={noop}
                onDismiss={noop}
              />
            </Slot>
          </div>
        </Section>

        <Section title="Variants">
          <div className="grid gap-4 sm:grid-cols-2">
            {VARIANTS.map((v) => (
              <Slot key={v.variant}>
                <ToastCard
                  message={v.message}
                  icon={toastIcon(v.variant)}
                  variant={v.variant}
                  options={{ description: v.description }}
                  onDismiss={noop}
                />
              </Slot>
            ))}
            <Slot>
              <ToastCard
                message="Trigger ran"
                icon={toastIcon('success')}
                variant="success"
                options={{
                  entity: { icon: <ClockIcon />, label: 'Nightly report' },
                  actions: [{ label: 'View run', onClick: noop }],
                  meta: '2m',
                }}
                onDismiss={noop}
              />
            </Slot>
            <Slot>
              <ToastCard
                message="Copied"
                icon={toastIcon('success')}
                options={{ compact: true }}
                onDismiss={noop}
              />
            </Slot>
          </div>
        </Section>
      </div>
    </main>
  );
}
