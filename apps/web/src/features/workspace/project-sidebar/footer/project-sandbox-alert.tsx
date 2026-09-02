'use client';

import { ArrowClockwiseIcon as RefreshCw } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  type SandboxAlertSeverity,
  formatSandboxProviders,
  resolveSandboxAlertSeverity,
  sandboxHealthRefetchInterval,
  selectCurrentSandboxFailure,
  selectSandboxStatus,
} from '@/features/workspace/project-sidebar/footer/sandbox-alert-state';
import {
  SidebarAlert,
  SidebarAlertActions,
  SidebarAlertBody,
  SidebarAlertText,
  type SidebarAlertTone,
} from '@/features/workspace/project-sidebar/footer/sidebar-alert';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { relativeTime } from '@/lib/relative-time';
import { useProjectPageCans } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  type ProjectSandboxHealth,
  type SandboxRuntimeStatus,
  fixSandboxWithAgent,
  getProjectSandboxHealth,
  rebuildProjectSnapshot,
} from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import {
  WarningIcon as DangerTriangleSolid,
  SparkleIcon as SparklesSolid,
} from '@phosphor-icons/react';

export const SANDBOX_HEALTH_QUERY_KEY = (projectId: string) => ['sandbox-health', projectId];

/**
 * Severity picks a tone from the shared footer palette — it no longer carries
 * its own colour strings. The old map spelled out a `text`, an `icon` and a
 * `dot` class per severity; `dot` and `icon` only ever fed the collapsed icon
 * rail, which no longer exists, and `text` was one hand-copy of what every
 * other footer alert already declares.
 */
const SEVERITY_TONE: Record<SandboxAlertSeverity, SidebarAlertTone> = {
  critical: 'critical',
  warning: 'warning',
  building: 'neutral',
};

const SEVERITY_LABEL: Record<SandboxAlertSeverity, string> = {
  critical: 'Sandbox build failing',
  warning: 'Sandbox partly unavailable',
  building: 'Sandbox build running…',
};

const CATEGORY_LABEL: Record<string, string> = {
  quota: 'Snapshot quota reached',
  dockerfile: 'Dockerfile build failed',
  git: 'Repository access failed',
  tunnel: 'Sandbox callback unreachable',
  provider: 'Sandbox provider error',
  timeout: 'Build timed out',
  runtime: 'Runtime artifact missing',
  unknown: 'Build failed',
};

/**
 * "Details" is ONE control, in ONE place, and it looks like a control.
 *
 * Two defects, same line of code. It rendered up to three times in a single
 * card — under the message, in the failure row, and again in the tray — so a
 * failing card showed the same word twice pointing at the same route. And it
 * was styled `text-muted-foreground text-xs p-0`: character for character the
 * body copy beside it. Sitting directly above the title row it read as a
 * stranded caption, not something you could click.
 *
 * It is now an outline `Button` in the action tray, the only slot, alongside
 * whatever recovery the viewer is allowed. One `<Link>` in the whole file.
 */

/**
 * What went wrong, in the reader's words — never the build's.
 *
 * The card used to render `failure.error` verbatim in a scrolling monospace
 * block. On a real failure that is an absolute path from the build machine
 * ("/Users/jay/root/kortix/suna-show-response-metadata/apps/kortix-sandbox-
 * agent-server/dist/kortix-agent") wrapped across four lines and cut mid-word.
 * It was the largest object on the card, it named a directory on somebody
 * else's computer, and nobody reading the sidebar can act on it.
 *
 * Every product that does this well makes the same split — Mintlify shows
 * "Update failed / An unknown error occurred" and keeps the deployment log in
 * a separate pane; Railway puts a plain-English "Diagnosis" above the trace;
 * Buffer and Family show one sentence and a retry. The trace still exists, one
 * click away in Details, next to the whole build log rather than a 70px window
 * onto the middle of it.
 *
 * So each category gets one sentence: what happened, and what it means for
 * you. No paths, no variable names, no "artifact".
 */
/**
 * Severity on the category line. Colour only — the leading dot it replaced put
 * the label on a 20px left edge while every other line started at 8px, and the
 * trigger row below already states the severity in the same tone.
 */
const CATEGORY_TEXT: Record<'critical' | 'warning', string> = {
  critical: 'text-destructive',
  warning: 'text-kortix-orange',
};

const CATEGORY_CAUSE: Record<string, string> = {
  quota: 'This project has no room for another sandbox image. Removing an old one frees space.',
  dockerfile: 'A step in the project’s Dockerfile did not finish.',
  git: 'The build could not read the project’s repository. Its access may have expired.',
  tunnel: 'The sandbox could not reach Kortix while it was being built.',
  provider: 'The sandbox provider refused the build. This is usually temporary.',
  timeout: 'The build ran past its time limit and was stopped.',
  runtime: 'The build finished, but without the agent it needs to run.',
  unknown: 'The build stopped before it finished.',
};

/** Fallback for a category the server knows and this build does not. */
const CATEGORY_CAUSE_FALLBACK = CATEGORY_CAUSE.unknown;

const ACTION_BUTTON = 'w-full active:scale-[0.96]';

/**
 * One honest sentence about what the user can do right now. Never present-tense
 * a failure that no longer applies, and never imply sessions are down when only
 * one of several routable providers is.
 */
function describeSandboxSeverity(
  severity: SandboxAlertSeverity,
  status: SandboxRuntimeStatus | null,
): string {
  if (severity === 'building') {
    return 'A new sandbox image is building. Sessions can start once it’s ready.';
  }
  if (severity === 'warning') {
    const ready = formatSandboxProviders(status?.ready_providers ?? []);
    const failed = formatSandboxProviders(status?.failed_providers ?? []);
    return failed && ready
      ? `The image is ready on ${ready} but failing on ${failed}, so some new sessions won’t start.`
      : 'The sandbox image is unavailable on some providers, so some new sessions won’t start.';
  }
  return 'New sessions can’t start until this image builds.';
}

export function useSandboxHealth(projectId: string) {
  return useQuery<ProjectSandboxHealth>({
    queryKey: SANDBOX_HEALTH_QUERY_KEY(projectId),
    queryFn: () => getProjectSandboxHealth(projectId),
    staleTime: 30_000,
    refetchInterval: (query) => sandboxHealthRefetchInterval(query.state.data),
    refetchOnWindowFocus: true,
  });
}

export function useSandboxRecovery(projectId: string) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: SANDBOX_HEALTH_QUERY_KEY(projectId) });
    queryClient.invalidateQueries({ queryKey: qk.project.snapshots(projectId) });
  }, [queryClient, projectId]);

  const retry = useMutation({
    mutationFn: (slug?: string) => rebuildProjectSnapshot(projectId, slug),
    onSuccess: () => {
      successToast('Rebuild started');
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to start build'),
  });

  const fixWithAgent = useMutation({
    mutationFn: () => fixSandboxWithAgent(projectId),
    onSuccess: ({ session_id }) => {
      successToast('Started a session to fix the sandbox build');
      router.push(`/projects/${projectId}/sessions/${session_id}`);
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Could not start the fix session'),
  });

  return { retry, fixWithAgent };
}

function SandboxAlertContent({
  projectId,
  health,
  severity,
}: {
  projectId: string;
  health: ProjectSandboxHealth;
  severity: SandboxAlertSeverity;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  // Sandbox templates is a section of the Customize bar's Settings tab now, so
  // "Details" is a route, not an overlay open — and every "Details" below is an
  // anchor rather than a handler. `router.push` would run the RSC fetch cold at
  // click time, and that fetch degrades into a full document load whenever it
  // answers wrong. This card only renders when the project is already
  // unhealthy, which is the worst moment to reboot the SPA.
  // The Settings overlay's Sandbox templates tab, via its deep-link route —
  // the config page this pointed at was retired on 2026-09-02.
  const sandboxSectionHref = `/projects/${projectId}/settings/sandbox`;
  const { retry, fixWithAgent } = useSandboxRecovery(projectId);
  // The alert TEXT is information a plain member needs — "new sessions can't
  // start until this image builds" explains why the composer is refusing them.
  // Its CONTROLS are not: "Details" routes into Customize → Settings → Sandbox
  // (project.customize.read) and both recovery actions rebuild the project's
  // image (project.write). Neither leaf is in the member floor role (#6522), so
  // for a member every one of those buttons was a "forbidden" waiting to
  // happen. Hidden on a RECEIVED denial only, one batched probe for both.
  const caps = useProjectPageCans(projectId);
  const canOpenDetails = caps[PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ]?.allowed !== false;
  const canRecover = caps[PROJECT_ACTIONS.PROJECT_WRITE]?.allowed !== false;
  const status = selectSandboxStatus(health);
  const failure = selectCurrentSandboxFailure(health);
  const failedAt = failure ? relativeTime(failure.finished_at ?? failure.started_at) : '';
  // Server-derived, and deliberately not re-derived here: the agent only helps
  // with repo-editable failures, and its fix session itself needs a bootable
  // sandbox — the very thing the failure may have denied. The API gates on
  // exactly this and answers 409 otherwise.
  const canFixWithAgent = status?.fix_with_agent_available ?? false;

  // The single Details control. An outline Button, not text: it is the one
  // escape hatch on this card and it has to look like something you can press.
  const detailsButton = canOpenDetails ? (
    <Button asChild size="sm" variant="outline" className={ACTION_BUTTON}>
      <Link href={sandboxSectionHref} prefetch>
        Details
      </Link>
    </Button>
  ) : null;

  // Nothing here is filled unless it is THE move. With an agent fix available
  // that is "Fix with agent" and the rebuild drops to outline; without it the
  // rebuild IS the move and takes the fill. It used to be `outline` in both
  // cases, which left the card with no focal point at all — the reader's one
  // action looked exactly like the navigation beside it.
  const recovery =
    severity !== 'building' && canRecover
      ? {
          fix: canFixWithAgent,
          retryVariant: canFixWithAgent ? ('outline' as const) : ('default' as const),
        }
      : null;

  const hasTray = Boolean(recovery) || Boolean(detailsButton);
  const tone = severity === 'critical' ? 'critical' : 'warning';

  return (
    // `@container/alert`, not a viewport breakpoint. This panel is USER-RESIZED
    // between 208px and 416px (`sidebar-width.ts`) with the window never moving,
    // so `sm:`/`md:` here would answer a question nobody asked.
    //
    // The card's box is roughly the sidebar minus 32px of gutter, so the 256px
    // default lands BELOW `@3xs` — stacked is the default layout, and the
    // side-by-side one is what a widened panel earns.
    <div className="@container/alert">
      <SidebarAlertBody>
        <SidebarAlertText>{describeSandboxSeverity(severity, status)}</SidebarAlertText>

        {failure && (
          /* Grouped by SPACE, not a hairline — the card already carries two
             (the tray's and the trigger's). `mt-2.5` against the sentence's own
             leading is the 2x gap that reads as a new group on its own. */
          <div className="mt-2.5 space-y-1">
            {/* One line, one left edge, three tiers by weight and colour rather
                than by size: the category is 500 in the severity tone, the age
                is 400 muted. It WRAPS instead of truncating — this is the
                sentence naming what broke, and half of it is not useful.

                The tone dot that used to lead this row is gone: it pushed the
                label to a 20px left edge while every other line in the card
                started at 8px, and the colour already says what it said. */}
            <p className="text-xs leading-5">
              <span className={cn('font-medium', CATEGORY_TEXT[tone])}>
                {CATEGORY_LABEL[failure.error_category ?? 'unknown'] ?? failure.error_category}
              </span>
              {/* When it failed, always — an undated error reads as a live one. */}
              {failedAt ? (
                <>
                  <span aria-hidden className="text-muted-foreground/40">
                    {' · '}
                  </span>
                  <span className="text-muted-foreground tabular-nums">{failedAt}</span>
                </>
              ) : null}
            </p>

            {/* The reader-facing cause. `failure.error` itself never reaches
                this card — it is a build-machine path nobody here can act on,
                and it lives in Details beside the full log. */}
            <SidebarAlertText>
              {CATEGORY_CAUSE[failure.error_category ?? 'unknown'] ?? CATEGORY_CAUSE_FALLBACK}
            </SidebarAlertText>
          </div>
        )}
      </SidebarAlertBody>

      {/* Both gates shut: no tray, no seam, no empty bordered strip under the
          message — a member sees a clean informational card. */}
      {hasTray ? (
        <SidebarAlertActions>
          {recovery?.fix && (
            <Button
              size="sm"
              className={ACTION_BUTTON}
              disabled={fixWithAgent.isPending}
              onClick={() => fixWithAgent.mutate()}
            >
              {fixWithAgent.isPending ? (
                <Loading className="size-3.5 shrink-0" />
              ) : (
                <SparklesSolid weight="fill" className="size-3.5 shrink-0" />
              )}
              <span className="truncate">
                {tI18nHardcoded.raw(
                  'autoFeaturesCoWorkerProjectSidebarFooterProjectSandboxAlertJsxe7d8ac75',
                )}
              </span>
            </Button>
          )}
          {/* Side by side once the panel can hold two readable labels; stacked
              below that, where two half-width buttons each ellipsize to nothing. */}
          <div className="flex flex-col gap-1.5 @2xs/alert:flex-row">
            {recovery ? (
              <Button
                size="sm"
                variant={recovery.retryVariant}
                className={ACTION_BUTTON}
                disabled={retry.isPending}
                onClick={() => retry.mutate(failure?.template_slug)}
              >
                {retry.isPending ? (
                  <Loading className="size-3.5 shrink-0" />
                ) : (
                  <RefreshCw className="size-3.5 shrink-0" />
                )}
                <span className="truncate">
                  {tI18nHardcoded.raw(
                    'autoFeaturesCoWorkerProjectSidebarFooterProjectSandboxAlertJsx8794c0a3',
                  )}
                </span>
              </Button>
            ) : null}
            {detailsButton}
          </div>
        </SidebarAlertActions>
      ) : null}
    </div>
  );
}

export function ProjectSandboxAlert({ projectId }: { projectId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const { data } = useSandboxHealth(projectId);
  const severity = resolveSandboxAlertSeverity(data);
  if (!severity || !data) return null;

  return (
    <SidebarAlert
      tone={SEVERITY_TONE[severity]}
      // Both glyphs are `size-4`: they occupy the SAME slot, and at 3.5 vs 4 the
      // label beside them started at a different x depending on severity — the
      // row appeared to shift when a build began.
      icon={
        severity === 'building' ? (
          <Loading className="in-[button]:text-foreground size-4 shrink-0" variant="spokes" />
        ) : (
          <DangerTriangleSolid weight="fill" className="size-4 shrink-0" />
        )
      }
      label={SEVERITY_LABEL[severity]}
      open={isOpen}
      onOpenChange={setIsOpen}
    >
      <SandboxAlertContent projectId={projectId} health={data} severity={severity} />
    </SidebarAlert>
  );
}
