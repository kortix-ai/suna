'use client';

import { ShieldWarningIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Textarea } from '@/components/ui/textarea';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { AuthPendingScreen, DetailPanel, DetailRow } from '@/features/auth/auth-consent';
import { ErrorStrip, Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { useAdminRole } from '@/hooks/admin/use-admin-role';
import { clearLastProjectId, readLastProjectId } from '@/lib/onboarding/last-project-cookie';
import { focusWithoutScroll } from '@/lib/utils/focus-without-scroll';
import { getProject, requestProjectAccess, setAdminBypass } from '@kortix/sdk';

const QUERY_KEY = 'project-access-boundary';

/** How often the waiting screen re-checks whether a manager approved the request. */
const APPROVAL_POLL_MS = 15_000;

/** Matches the server's own ceiling (apps/api projects access-requests route). */
const MESSAGE_MAX_LENGTH = 2_000;

/** Derived from the SDK so a new result status becomes a type error here. */
type RequestResultStatus = Awaited<ReturnType<typeof requestProjectAccess>>['status'];

// ─── State machine (pure — see project-access-boundary.test.ts) ───────────────

/**
 * Every screen this boundary can show. Each state owns exactly one heading,
 * which is what stops the three-headings-for-one-form problem.
 */
export type AccessGateState = 'request' | 'sent' | 'alreadyRequested' | 'notFound' | 'unavailable';

/** The two states where the user has asked and is waiting on a human. */
export type WaitingGateState = Extract<AccessGateState, 'sent' | 'alreadyRequested'>;

/**
 * Translation keys under `hardcodedUi.projectAccessBoundary`. The copy lives in
 * translations/*.json; keeping the keys here lets the test resolve them against
 * en.json and assert the real English reads correctly.
 *
 * There is no eyebrow/kicker: the auth dialect this screen belongs to is a
 * mark, a heading and a description, and nothing else.
 */
export interface AccessGateCopyKeys {
  heading: string;
  body: string;
}

const GATE_COPY_KEYS: Record<AccessGateState, AccessGateCopyKeys> = {
  request: { heading: 'privateHeading', body: 'privateBody' },
  sent: { heading: 'waitingHeading', body: 'sentBody' },
  alreadyRequested: { heading: 'waitingHeading', body: 'alreadyBody' },
  notFound: { heading: 'notFoundHeading', body: 'notFoundBody' },
  unavailable: { heading: 'errorHeading', body: 'errorBody' },
};

export function gateCopyKeys(state: AccessGateState): AccessGateCopyKeys {
  return GATE_COPY_KEYS[state];
}

/** Pulls the HTTP status off either error shape the SDK can surface. */
export function errorStatus(error: unknown): number | undefined {
  return (
    (error as { status?: number; response?: { status?: number } } | null)?.status ??
    (error as { response?: { status?: number } } | null)?.response?.status
  );
}

/**
 * Maps a failed `getProject` to the screen it should show. 403 is the only
 * status that leads to the request form — every other failure is terminal, so
 * an unknown status must never render a form whose request cannot succeed.
 */
export function gateStateForError(error: unknown): AccessGateState {
  const status = errorStatus(error);
  if (status === 403) return 'request';
  if (status === 404) return 'notFound';
  return 'unavailable';
}

/**
 * Maps `requestProjectAccess`'s three-way result to the next screen.
 * `already_has_access` returns null: the caller re-fetches instead, because the
 * project is readable now and the right screen is the project itself.
 */
export function gateStateForRequestResult(status: RequestResultStatus): WaitingGateState | null {
  switch (status) {
    case 'created':
      return 'sent';
    case 'pending':
      return 'alreadyRequested';
    case 'already_has_access':
      return null;
  }
}

/** True while the screen should keep polling for an approval. */
export function shouldPollForApproval(state: AccessGateState): boolean {
  return state === 'sent' || state === 'alreadyRequested';
}

/**
 * Decides which screen wins when the user has a request in flight AND the
 * project fetch is failing.
 *
 * A sent request has to survive a *transient* failure — an expired JWT, a 500,
 * a tunnel drop — or an unattended waiting screen silently turns back into a
 * blank request form for a request that was already sent. It must NOT survive a
 * *terminal* one: if the project is deleted while the user waits, telling them
 * to keep waiting means polling forever against something that no longer
 * exists.
 */
export function resolveGateState(
  waiting: WaitingGateState | null,
  errorState: AccessGateState | null,
): AccessGateState {
  if (errorState === 'notFound') return 'notFound';
  return waiting ?? errorState ?? 'unavailable';
}

// ─── Boundary ────────────────────────────────────────────────────────────────

interface ProjectAccessBoundaryProps {
  projectId: string;
  children: ReactNode;
}

export function ProjectAccessBoundary({ projectId, children }: ProjectAccessBoundaryProps) {
  const { user } = useAuth();
  // A submitted request is held HERE, above the error branch, so a transient
  // 401/500/offline poll result cannot unmount the waiting screen and hand the
  // user a fresh request form for a request they already sent.
  const [waiting, setWaiting] = useState<WaitingGateState | null>(null);

  const query = useQuery({
    queryKey: [QUERY_KEY, projectId],
    queryFn: () => getProject(projectId, { showErrors: false }),
    enabled: !!projectId,
    retry: false,
  });

  const { refetch } = query;
  // Background poll: silent, and must never touch the button's pending state.
  const recheck = useCallback(() => void refetch(), [refetch]);

  // The user's own "Check now" press, tracked separately so the 15s background
  // poll cannot disable the button under their cursor.
  const [manualRecheck, setManualRecheck] = useState(false);
  const recheckNow = useCallback(() => {
    setManualRecheck(true);
    void refetch().finally(() => setManualRecheck(false));
  }, [refetch]);

  const errorState = query.isError ? gateStateForError(query.error) : null;
  const state = resolveGateState(waiting, errorState);
  // Stop the moment access lands, or the interval outlives the gate: this
  // component wraps the shell for the whole session, so a poll that ignores
  // success keeps calling getProject every 15s while the user works.
  const polling = !query.isSuccess && shouldPollForApproval(state);

  // Poll while waiting so "this page opens on its own" is a fact, not a promise
  // the user has to keep by reloading. `recheck` is stable, so the interval is
  // a true 15s cadence rather than 15s-since-the-last-render.
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(recheck, APPROVAL_POLL_MS);
    return () => clearInterval(id);
  }, [polling, recheck]);

  const forbidden = errorState === 'request';

  // Stop this screen from becoming the user's permanent landing page. If the
  // remembered project is one they cannot read, every `/` hit and every sign-in
  // would redirect straight back here. The shell's self-heal does not fire for
  // this case: a private project is a legitimate 403 surface, not a failed
  // fetch. Forget it and let the landing door resolve a project they can open.
  useEffect(() => {
    if (!forbidden) return;
    if (readLastProjectId(user?.id) !== projectId) return;
    clearLastProjectId();
  }, [forbidden, projectId, user?.id]);

  if (query.isSuccess) return <>{children}</>;

  // The same quiet spinner every auth sub-surface shows while it resolves.
  if (query.isLoading) return <AuthPendingScreen />;

  return (
    <AccessGateScreen
      projectId={projectId}
      state={state}
      rechecking={manualRecheck}
      onRecheck={recheckNow}
      onWaiting={setWaiting}
    />
  );
}

// ─── Screen ──────────────────────────────────────────────────────────────────

/**
 * Composed from the auth consent vocabulary (AuthFrame / Rise / StepHeader /
 * DetailPanel / ErrorStrip) so this reads as the same product as the CLI and
 * OAuth consent screens. Flat on the background, left-aligned, 380px — no card,
 * no wallpaper.
 */
function AccessGateScreen({
  projectId,
  state,
  rechecking,
  onRecheck,
  onWaiting,
}: {
  projectId: string;
  state: AccessGateState;
  rechecking: boolean;
  onRecheck: () => void;
  onWaiting: (state: WaitingGateState) => void;
}) {
  const t = useTranslations('hardcodedUi');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { data: adminRole } = useAdminRole();
  const noteId = useId();
  const [message, setMessage] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [bypassError, setBypassError] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const shownState = useRef(state);

  // Submitting replaces the form, which would otherwise strand keyboard focus
  // on <body> with nothing announced. Focusing the body block reads the new
  // step aloud. preventScroll is mandatory — a bare focus() into this animated
  // layer scrolls the overflow ancestor. Guarded so it never fires on mount.
  useEffect(() => {
    if (shownState.current === state) return;
    shownState.current = state;
    focusWithoutScroll(bodyRef.current);
  }, [state]);

  const requestMutation = useMutation({
    mutationFn: () => requestProjectAccess(projectId, message),
    onMutate: () => setInlineError(null),
    onSuccess: (result) => {
      const next = gateStateForRequestResult(result.status);
      if (next) {
        onWaiting(next);
        return;
      }
      // already_has_access — the project is readable now, so show the project.
      void queryClient.invalidateQueries({ queryKey: [QUERY_KEY, projectId] });
    },
    onError: (error: Error) =>
      setInlineError(error.message || t.raw('projectAccessBoundary.requestFailed')),
  });

  // Platform-admin escape hatch: flips the client-wide admin-bypass header on,
  // then re-fetches the shared [QUERY_KEY, projectId] query so the boundary
  // above renders the actual project. Read-only server-side (see
  // apps/api/src/projects/lib/access.ts) and audit-logged against the project's
  // own account on every use.
  const bypassMutation = useMutation({
    mutationFn: async () => {
      setAdminBypass(true);
      return queryClient.fetchQuery({
        queryKey: [QUERY_KEY, projectId],
        queryFn: () => getProject(projectId, { showErrors: false }),
      });
    },
    onMutate: () => setBypassError(null),
    onError: (error: Error) => {
      setAdminBypass(false);
      setBypassError(error.message || t.raw('projectAccessBoundary.bypassFailed'));
    },
  });

  const copy = gateCopyKeys(state);
  const forbidden = state === 'request' || shouldPollForApproval(state);

  return (
    <AuthFrame>
      {/*
        Keyed on `state` so a step change replays the same two-part rise the
        auth flow uses everywhere else: header first, body 60ms behind.
      */}
      <Rise key={`h-${state}`}>
        <StepHeader
          title={t.raw(`projectAccessBoundary.${copy.heading}`)}
          description={t.raw(`projectAccessBoundary.${copy.body}`)}
        />
      </Rise>

      <Rise key={`b-${state}`} delay={0.06}>
        <div ref={bodyRef} tabIndex={-1} className="outline-none">
          {inlineError ? <ErrorStrip message={inlineError} /> : null}
          {bypassError ? <ErrorStrip message={bypassError} /> : null}

          {forbidden ? (
            <DetailPanel>
              <DetailRow
                label={t.raw('projectAccessBoundary.accountLabel')}
                value={user?.email ?? t.raw('projectAccessBoundary.thisAccount')}
              />
              <DetailRow
                label={t.raw('projectAccessBoundary.projectLabel')}
                value={projectId}
                mono
              />
            </DetailPanel>
          ) : null}

          {state === 'request' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                // The button is aria-disabled rather than disabled so it keeps
                // focus in flight, which means it stays clickable and the guard
                // has to live here.
                if (requestMutation.isPending) return;
                requestMutation.mutate();
              }}
            >
              <label
                htmlFor={noteId}
                className="text-muted-foreground mt-5 mb-2 block text-sm font-medium"
              >
                {t.raw('projectAccessBoundary.noteLabel')}
              </label>
              <Textarea
                id={noteId}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={MESSAGE_MAX_LENGTH}
                minHeight={76}
                maxHeight={140}
                placeholder={t.raw('projectAccessBoundary.notePlaceholder')}
                // Deliberately NOT disabled while pending: disabling a focused
                // element drops keyboard focus to <body>. read-only:opacity-60
                // supplies the state the `disabled:` styles would have.
                readOnly={requestMutation.isPending}
                className="read-only:cursor-default read-only:opacity-60"
              />
              <Button
                type="submit"
                size="lg"
                className="mt-5 w-full aria-disabled:pointer-events-none aria-disabled:opacity-50"
                aria-disabled={requestMutation.isPending}
              >
                {requestMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
                {t.raw('projectAccessBoundary.requestAction')}
              </Button>
            </form>
          ) : (
            <Button
              type="button"
              size="lg"
              variant={shouldPollForApproval(state) ? 'secondary' : 'default'}
              className="mt-5 w-full"
              onClick={onRecheck}
              disabled={rechecking}
            >
              {rechecking ? <Loading className="size-4 shrink-0" /> : null}
              {shouldPollForApproval(state)
                ? t.raw('projectAccessBoundary.checkNowAction')
                : t.raw('projectAccessBoundary.tryAgainAction')}
            </Button>
          )}

          <div className="text-muted-foreground mt-8 space-y-2 text-sm">
            {forbidden ? <p>{t.raw('projectAccessBoundary.approvalNote')}</p> : null}
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => router.push('/projects')}
                className="hover:text-foreground -my-2 inline-block cursor-pointer py-2 underline-offset-4 transition-colors hover:underline"
              >
                {t.raw('projectAccessBoundary.projectsAction')}
              </button>
              {adminRole?.isAdmin ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-kortix-orange hover:text-kortix-orange hover:bg-kortix-orange/10 -mr-2 h-7 shrink-0 px-2 text-xs"
                  onClick={() => bypassMutation.mutate()}
                  disabled={bypassMutation.isPending}
                >
                  {bypassMutation.isPending ? (
                    <Loading className="size-3.5 shrink-0" />
                  ) : (
                    <ShieldWarningIcon className="size-3.5 shrink-0" />
                  )}
                  {t.raw('projectAccessBoundary.openAsAdmin')}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </Rise>
    </AuthFrame>
  );
}
