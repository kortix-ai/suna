'use client';

import {
  CATEGORY_CAUSE,
  CATEGORY_CAUSE_FALLBACK,
  CATEGORY_LABEL,
  CATEGORY_TEXT,
  MEMBER_LABEL,
  MEMBER_TEXT,
  MEMBER_TONE,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  describeSandboxSeverity,
} from './sandbox-health';

import { useSandboxHealth, useSandboxRecovery } from './sandbox-health';

import { useTranslations } from '../../../i18n';
import { ArrowClockwiseIcon as RefreshCw } from '@phosphor-icons/react';
import { UiLink as Link } from '../../../providers/ui-provider';

import { useState } from 'react';

import { Button } from '../../../primitives/button';
import Loading from '../../../primitives/loading';
import {
  type SandboxAlertSeverity,
  resolveSandboxAlertSeverity,
  selectCurrentSandboxFailure,
  selectSandboxStatus,
} from './sandbox-alert-state';
import {
  SidebarAlert,
  SidebarAlertActions,
  SidebarAlertBody,
  SidebarAlertText,
} from './sidebar-alert';
import { PROJECT_ACTIONS } from '../../../internal/lib/project-actions';
import { relativeTime } from '../../../internal/lib/relative-time';
import { useProjectPageCans } from '../../../internal/lib/use-project-can';
import { cn } from '../../../internal/lib/utils';
import { type ProjectSandboxHealth } from '@kortix/sdk';
import {
  WarningIcon as DangerTriangleSolid,
  SparkleIcon as SparklesSolid,
} from '@phosphor-icons/react';

/**
 * Severity picks a tone from the shared footer palette — it no longer carries
 * its own colour strings. The old map spelled out a `text`, an `icon` and a
 * `dot` class per severity; `dot` and `icon` only ever fed the collapsed icon
 * rail, which no longer exists, and `text` was one hand-copy of what every
 * other footer alert already declares.
 */

/**
 * Severity on the category line. Colour only — the leading dot it replaced put
 * the label on a 20px left edge while every other line started at 8px, and the
 * trigger row below already states the severity in the same tone.
 */

/** Fallback for a category the server knows and this build does not. */

const ACTION_BUTTON = 'w-full active:scale-[0.96]';

/**
 * One honest sentence about what the user can do right now. Never present-tense
 * a failure that no longer applies, and never imply sessions are down when only
 * one of several routable providers is.
 */

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
  const sandboxSectionHref = `/projects/${projectId}/config?section=sandbox`;
  const { retry, fixWithAgent } = useSandboxRecovery(projectId);
  // The alert TEXT is information a plain member needs — "new sessions can't
  // start until this image builds" explains why the composer is refusing them.
  // Its CONTROLS are not: "Details" routes into Customize → Settings → Sandbox
  // (project.settings.write) and both recovery actions rebuild the project's
  // image (project.sandbox.write). Neither leaf is in the member floor role, so
  // for a member every one of those buttons was a "forbidden" waiting to
  // happen. Hidden on a RECEIVED denial only, one batched probe for both.
  const caps = useProjectPageCans(projectId);
  const canOpenDetails = caps[PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE]?.allowed !== false;
  const canRecover = caps[PROJECT_ACTIONS.PROJECT_SANDBOX_WRITE]?.allowed !== false;
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
        {tI18nHardcoded.raw('i18nComplete.text45989de49fb7')}
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
  const caps = useProjectPageCans(projectId);
  const severity = resolveSandboxAlertSeverity(data);
  if (!severity || !data) return null;

  const details = caps[PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE];
  const write = caps[PROJECT_ACTIONS.PROJECT_SANDBOX_WRITE];
  // Wait for the verdict: a member must never see the operator card flash
  // before it swaps to the member one.
  if (details?.isLoading || write?.isLoading) return null;
  const isOperator = details?.allowed !== false || write?.allowed !== false;

  if (!isOperator) {
    const label = MEMBER_LABEL[severity];
    const text = MEMBER_TEXT[severity];
    const tone = MEMBER_TONE[severity];
    if (!label || !text || !tone) return null;
    return (
      <SidebarAlert
        tone={tone}
        icon={
          severity === 'building' ? (
            <Loading className="in-[button]:text-foreground size-4 shrink-0" variant="spokes" />
          ) : (
            <DangerTriangleSolid weight="fill" className="size-4 shrink-0" />
          )
        }
        label={label}
        open={isOpen}
        onOpenChange={setIsOpen}
      >
        <SidebarAlertBody>
          <SidebarAlertText>{text}</SidebarAlertText>
        </SidebarAlertBody>
      </SidebarAlert>
    );
  }

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
