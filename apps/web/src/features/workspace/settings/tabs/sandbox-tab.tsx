'use client';

/**
 * The Sandbox tab — sandbox template CRUD (list, create, edit, delete,
 * rebuild). **No build log.** Split off `sandbox-view.tsx`'s `SandboxView`,
 * which used to render this content AND the snapshot build log together on
 * one 858-line page (Task 20's brief). The build log, status banner and error
 * categories move to `snapshots-tab.tsx` instead — see that file's header
 * comment.
 * `settings-panel.tsx:1127` used to mount the unsplit `SandboxView` on
 * `case 'sandbox'` alone, with `snapshots` stuck on a placeholder
 * (`settings-panel.tsx:997-1003` explains why: mounting `SandboxView` on
 * both tabs would have rendered the build log twice). Both cases are now
 * wired to their own tab; `SandboxView`/`sandbox-view.tsx` is deleted.
 *
 * **What moved here, verbatim, from `sandbox-view.tsx`:** the template list
 * row (now `TemplateCard` — build/delete mutations, edit/rebuild actions),
 * `describeState`/`TEMPLATE_STATE_LABEL` (template status presentation),
 * `TEMPLATE_SKELETON_ROWS`, and the `SandboxTemplateForm` create/edit modal
 * mount. `sandbox-provider-coverage.tsx` (in
 * `../../customize/sections/view/`) holds the Sandbox-half provider symbols
 * per JAY-508 — that module is used only by this tab, so it stays in place
 * (not part of the 858-line file being split).
 *
 * **Its two row components are gone; its pure functions are not.**
 * `SandboxTemplateProviderCoverage` and `SandboxTemplateProviderModeBadge`
 * each baked a whole `flex` row — label, badges and "Checked …" stamp — into
 * one block, so a caller could only drop them in whole. That forced this card
 * to nest a labelled row inside another labelled row: two labels ("Routing",
 * "Session runtime") and a stamp welded to the last badge, none of it
 * positionable. They are replaced by `SandboxProviderBadge` (one badge, no
 * layout) and `latestObservedAt`, with the row composed here in
 * `TemplateRuntimeFooter`. Every describe-* function, type and
 * `availableProviderCoverage` is unchanged, and every assertion the two
 * components carried is ported onto the components that now ship.
 *
 * ---
 *
 * **Why the row became a card (the readability pass).** The original
 * `TemplateRow` was one dense line with two defects a non-technical reader
 * could not work around:
 *
 * 1. **Status was colour-only.** `describeState()` returns `{ label, tone }`,
 *    but only `tone` was ever consumed — as the lookup key for the icon
 *    tile's background tint. The words "Ready" / "Building" / "Build failed"
 *    were computed on every render and never rendered, so the sole signal for
 *    "is this template usable?" was a 10%-opacity tint on a 44px square. That
 *    is a WCAG 1.4.1 (Use of Color) failure and unreadable to anyone who does
 *    not already know the colour code. `TemplateStateLine` now renders the
 *    word next to a filled glyph; the tint is redundant reinforcement, not the
 *    message.
 * 2. **The specs were unlabelled and truncating.** `{cpu} vCPU &bull;
 *    {memory_gb} GiB &bull; {disk_gb} GiB disk` asked the reader to know that
 *    the first bare `GiB` means memory and the second means disk — and the
 *    line carried `truncate`, so on a narrow panel the numbers silently
 *    disappeared rather than wrapping.
 *
 * Both are fixed the way Vercel's deployment-settings panel fixes them: a
 * **description list**. Every value gets a `<dt>` label directly above it
 * (`TemplateFact`), enum/boolean state gets a filled glyph *plus* the word,
 * and the grid reflows 3 → 2 columns instead of truncating. Long values
 * (image refs, Dockerfile paths) still truncate, but only inside their own
 * labelled cell and with a native `title` for the full string.
 *
 * 3. **The card had two left edges.** A `size-9` status tile led the header,
 *    pushing the name and status to x=64px while the spec grid below started
 *    at x=16px — nothing in the card shared a vertical line. The tile is gone:
 *    `TemplateStateLine`'s glyph already carries its tone colour, and the
 *    template kind is stated far more precisely by the "Base image" / "Built
 *    from" cell than by a decorative container/package/file glyph. Header,
 *    grid and footer now all start at the same `px-4` edge.
 * 4. **The grid was ragged.** `col-span-2` on the base-image cell made row 1
 *    three equal cells and row 2 one narrow beside one double-wide. The grid
 *    is now SIX single-track cells — two complete rows of three, no spans, no
 *    holes. The sixth is "Routing", promoted out of the footer, where it had
 *    been a bare `Automatic` badge with a second label bolted on.
 *
 * The copy is de-jargoned to match: `source` renders as "Kortix platform" /
 * "This dashboard" / `kortix.yaml`, not `platform` / `UI` / `kortix.yaml`;
 * `is_default` is promoted out of the meta line into a `Default` badge.
 *
 * **Gate.** Template CRUD asks for `project.customize.write` — the leaf the
 * routes actually assert (`POST|PATCH|DELETE /projects/:id/sandbox-templates`,
 * `r2.ts`). It gates the header "New template" button, the empty-state action,
 * and every `TemplateCard` edit/delete/rebuild control. It used to read
 * `effective_project_role === 'manager'`, which showed the controls to a custom
 * role that had been denied `project.customize.write` and hid them from one that
 * had been granted it.
 *
 * **`useTranslations('hardcodedUi')` removed.** `sandbox-view.tsx` routed
 * its static English copy through `next-intl`'s `useTranslations` with
 * auto-generated keys (e.g. `...JsxTextNewTemplate62cccf85`) that resolve to
 * plain literals in `translations/en.json` — no other tab in this directory
 * does this (`general-tab.tsx`/`api-keys-tab.tsx` write literals directly),
 * and `useTranslations` needs a `NextIntlClientProvider` ancestor that
 * `renderToStaticMarkup` doesn't provide. That is exactly why nothing in
 * `sandbox-view.tsx` that called it was ever covered by
 * `sandbox-view.test.tsx` — only the translation-free `BuildRow` was
 * testable. Copy here is written directly as literals — matching the house
 * pattern and making `SandboxTabView` testable.
 *
 * **`listProjectSnapshots` — shared endpoint, split rendering.** Both this
 * tab and `snapshots-tab.tsx` call the identical
 * `useQuery({ queryKey: qk.project.snapshots(projectId), queryFn: () =>
 * listProjectSnapshots(projectId) })` — the backend has one endpoint
 * returning `{ templates, builds, status, provider_mode, selected_provider,
 * templates_error }` together; this tab reads only the templates-shaped
 * fields, `snapshots-tab.tsx` only the builds-shaped ones. React Query
 * dedupes by cache key, and `SettingsTabPane` mounts only the active tab's
 * container (`if (!active) return null`), so only one network request
 * happens at a time — same as `sandbox-view.tsx` before the split. Each
 * tab's `refetchInterval` polls only for ITS OWN "still building" signal
 * (this tab: `provider_state`/`provider_coverage` on templates;
 * `snapshots-tab.tsx`: `status` on builds) — a split of the original
 * combined boolean, not a re-derived gate.
 *
 * **The combined "fully empty" empty state is gone by construction.**
 * `sandbox-view.tsx` showed one big `EmptyState` only when BOTH `templates`
 * and `builds` were empty (`isFullyEmpty`), falling back to a plain
 * `InlinePanelEmpty` box when only templates were empty but builds existed.
 * Split across two tabs, "fully empty" can only mean "empty for THIS tab's
 * own domain" — so this tab shows `EmptyState` whenever `templates.length
 * === 0`, independent of whatever `snapshots-tab.tsx` has to show.
 *
 * **The provider pin moved here (2026-08-17).** `SandboxProviderRow` — the
 * per-project "Sandbox provider" control, with its `updateProjectSandboxProvider`
 * mutation and the durable-transition polling behind it — was a "Sandbox"
 * sub-section on the General tab. It is CUT from `general-tab.tsx`, not copied,
 * so there is one implementation and General no longer mentions sandboxes at
 * all. It renders first on this tab, above the templates list: the pin decides
 * where a session runs, the templates decide what it runs, and the product
 * owner's ask was to "combine truly everything in one place that is sandbox
 * related".
 *
 * With both on one screen they must never disagree, so the pin is read ONCE,
 * from the project query — the exact field the row writes — instead of from
 * this tab's own `listProjectSnapshots` payload. Both derive from the same
 * server-side `projects.metadata.default_sandbox_provider`, but they are two
 * query caches and only the project one is invalidated after a switch. See
 * `pinnedProvider` in `SandboxTab` for the full trace.
 *
 * `SandboxTabView` is the pure, props-only half — `templatesSlot` is a slot
 * because each `TemplateCard` owns its own `useMutation`/`useQueryClient`
 * (build, delete) and can't render under `renderToStaticMarkup` with no
 * `QueryClientProvider`, same reasoning as `general-tab.tsx`'s
 * `generalFieldsSlot`. `SandboxTemplateForm` (create/edit dialog) is NOT
 * rendered inside the pure view either — it owns its own
 * `useMutation`/`useQueryClient` too — it mounts as a sibling in `SandboxTab`
 * instead. `SandboxTab` is the container: every hook only runs once this tab
 * is actually mounted, which `SettingsTabPane` in `settings-panel.tsx`
 * guarantees.
 */

import { type ReactNode, useState } from 'react';

import { SandboxTemplateForm } from '@/components/projects/sandbox-template-form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useProjectManifestVersion } from '@/features/workspace/customize/migrate-to-v2/manifest-version';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { relativeTime } from '@/lib/relative-time';
import { useProjectCans } from '@/lib/use-project-can';

/** One batched probe for the two leaves this tab gates on. */
const SANDBOX_TAB_ACTIONS = [
  PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
  PROJECT_ACTIONS.PROJECT_WRITE,
] as const;
import { cn } from '@/lib/utils';
import {
  type KortixProject,
  type SandboxProviderName,
  type SandboxTemplate,
  buildSandboxTemplate,
  deleteSandboxTemplate,
  getProject,
  listProjectSnapshots,
  updateProjectSandboxProvider,
} from '@kortix/sdk';
import { contract, invalidateProject, qk } from '@kortix/sdk/react';
import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  CircleDashedIcon,
  CpuIcon,
  CubeIcon,
  FileCodeIcon,
  HardDrivesIcon,
  MemoryIcon,
  PackageIcon,
  PencilSimpleIcon,
  type Icon as PhosphorIcon,
  PlusIcon,
  PushPinIcon,
  ShippingContainerIcon,
  ShuffleIcon,
  SquaresFourIcon,
  TrashIcon,
  XCircleIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type SandboxProvider,
  SandboxProviderBadge,
  type SandboxProviderMode,
  availableProviderCoverage,
  describeProviderMode,
  latestObservedAt,
} from '../../customize/sections/view/sandbox-provider-coverage';
import {
  applySandboxProviderResult,
  pollSandboxProviderTransition,
} from '../../customize/sections/view/sandbox-provider-result';
import { SettingsTabHeader } from '../settings-tab-header';

/** Three, not five: each skeleton is now a full card, so five of them
 *  overflowed the panel and read as a wall of grey. */
const TEMPLATE_SKELETON_ROWS = [
  'sandbox-template-skeleton-1',
  'sandbox-template-skeleton-2',
  'sandbox-template-skeleton-3',
] as const;

type TemplateTone = 'ok' | 'busy' | 'fail' | 'idle';

const TEMPLATE_STATE_LABEL: Record<string, { label: string; tone: TemplateTone }> = {
  active: { label: 'Ready', tone: 'ok' },
  pulling: { label: 'Pulling', tone: 'busy' },
  building: { label: 'Building', tone: 'busy' },
  removing: { label: 'Removing', tone: 'busy' },
  error: { label: 'Error', tone: 'fail' },
  build_failed: { label: 'Build failed', tone: 'fail' },
  missing: { label: 'Not built yet', tone: 'idle' },
};

const TEMPLATE_TONE_TEXT: Record<TemplateTone, string> = {
  ok: 'text-kortix-green',
  busy: 'text-kortix-yellow',
  fail: 'text-kortix-red',
  idle: 'text-muted-foreground',
};

/** Exported for test only — `TemplateCard` itself owns mutations and cannot
 *  render under `renderToStaticMarkup`, so the presentation decisions are
 *  pulled out as pure functions that can be asserted directly. */
export function describeState(state: string): { label: string; tone: TemplateTone } {
  return TEMPLATE_STATE_LABEL[state] ?? { label: state || 'Unknown', tone: 'idle' };
}

/** Where the template is declared, in words a reader who has never opened the
 *  repo can act on. Replaces the raw `platform` / `UI` / `kortix.yaml` tag
 *  that used to sit last in the bullet-separated meta line. */
export function describeSource(
  template: SandboxTemplate,
  manifestVersion: number | null,
): { label: string; icon: PhosphorIcon; mono: boolean } {
  if (template.source === 'platform')
    return { label: 'Kortix platform', icon: ShippingContainerIcon, mono: false };
  if (template.source === 'ui')
    return { label: 'This dashboard', icon: SquaresFourIcon, mono: false };
  return {
    label: manifestVersion === 2 ? 'kortix.yaml' : 'kortix.toml',
    icon: FileCodeIcon,
    mono: true,
  };
}

/** What the sandbox is built from. The old row folded this into a `sub` string
 *  whose `is_default` branch hid the image entirely; the default's "shared by
 *  every project" note is now a `Default` badge in the card header instead, so
 *  this cell can always state the real base. */
export function describeBase(template: SandboxTemplate): {
  label: string;
  value: string;
  icon: PhosphorIcon;
  mono: boolean;
} {
  if (template.has_image && template.image)
    return { label: 'Base image', value: template.image, icon: PackageIcon, mono: true };
  if (template.has_dockerfile && template.dockerfile_path)
    return {
      label: 'Built from',
      value: template.dockerfile_path,
      icon: FileCodeIcon,
      mono: true,
    };
  return { label: 'Base image', value: 'Kortix default', icon: CubeIcon, mono: false };
}

/** Where sessions built from this template actually run. Static configuration,
 *  not live status — which is why it belongs in the spec grid next to CPU and
 *  memory, and NOT in the runtime footer where a bare `Automatic` badge used
 *  to float with no label attached to it. */
export function describeRouting(
  providerMode: SandboxProviderMode,
  selectedProvider: SandboxProvider | null,
): { label: string; icon: PhosphorIcon } {
  const mode = describeProviderMode(providerMode, selectedProvider);
  if (providerMode === 'automatic') return { label: 'Automatic', icon: ShuffleIcon };
  return {
    label: mode.selectedProvider ? `Pinned · ${mode.selectedProvider}` : 'Pinned',
    icon: PushPinIcon,
  };
}

/** Matches `snapshots-tab.tsx`'s own `formatRelative` (both wrap
 *  `relativeTime`) — needed here for the runtime footer's "Checked …" stamp,
 *  which this tab uses independently of anything build- or snapshot-log
 *  related. */
function formatRelative(input: string | null | undefined): string {
  return relativeTime(input) || '—';
}

/**
 * The status word the old row computed and discarded. Glyph carries the same
 * meaning as the colour so the state survives greyscale, colour-blindness, and
 * a reader who has never seen this screen before.
 *
 * `busy` uses `Loading` rather than a glyph deliberately: a building template
 * is a live async operation (the tab re-polls every 5s while any provider
 * reports `building`), and motion is the only thing that says "this will
 * change on its own — don't press Rebuild". `Loading` is the codebase's single
 * spinner; no icon may be spun in its place.
 */
export function TemplateStateLine({ tone, label }: { tone: TemplateTone; label: string }) {
  const toneClass = TEMPLATE_TONE_TEXT[tone];

  return (
    <span className={cn('flex items-center gap-1.5 text-xs font-medium', toneClass)}>
      {tone === 'busy' ? (
        <Loading variant="spokes" className={cn('size-3.5 shrink-0', toneClass)} />
      ) : tone === 'ok' ? (
        <CheckCircleIcon weight="fill" className="size-3.5 shrink-0" />
      ) : tone === 'fail' ? (
        <XCircleIcon weight="fill" className="size-3.5 shrink-0" />
      ) : (
        <CircleDashedIcon className="size-3.5 shrink-0" />
      )}
      {label}
    </span>
  );
}

/**
 * One labelled cell of the spec grid — the unit of the readability fix. The
 * `<dt>` sits above the value rather than beside it so the label column never
 * competes with the value for the same 200px, and the value truncates inside
 * its own cell (with a native `title` for the full string) instead of taking
 * the whole meta line down with it.
 */
export function TemplateFact({
  icon: Icon,
  label,
  value,
  mono = false,
  className,
}: {
  icon: PhosphorIcon;
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <Icon className="text-muted-foreground size-4 shrink-0" />
        <span className={cn('truncate text-sm', mono && 'font-mono text-xs')} title={value}>
          {value}
        </span>
      </dd>
    </div>
  );
}

/**
 * The card's runtime strip: one line, three zones, one left edge.
 *
 * ```
 * Session runtime   [Daytona · Ready] [Platinum · Building]   Checked 2 min ago
 * └ label, fixed    └ badges, flex-1                          └ stamp, pushed right
 * ```
 *
 * The previous footer nested `SandboxTemplateProviderCoverage` — a block that
 * carried its OWN label, badges and timestamp — inside a row that carried a
 * "Routing" label of its own. That produced two labels and a timestamp jammed
 * against the last badge, with no way to align anything, because the inner
 * block owned its own layout. Composing from `SandboxProviderBadge` puts the
 * row back under this component's control: `ml-auto` on the stamp is only
 * possible once the stamp is a direct child.
 *
 * Renders `null` when no provider reports coverage, so the card simply ends at
 * the spec grid rather than showing an empty strip.
 */
export function TemplateRuntimeFooter({
  coverage,
  providerMode,
  selectedProvider,
  formatObservedAt = formatRelative,
}: {
  coverage: SandboxTemplate['provider_coverage'] | null | undefined;
  providerMode: SandboxProviderMode;
  selectedProvider: SandboxProvider | null;
  formatObservedAt?: (observedAt: string) => string;
}) {
  const available = availableProviderCoverage(coverage);
  if (available.length === 0) return null;

  const observedAt = latestObservedAt(coverage);

  return (
    <div className="border-border/60 bg-muted/25 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t px-4 py-2.5">
      <span className="text-muted-foreground shrink-0 text-xs">Session runtime</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {available.map((item) => (
          <SandboxProviderBadge
            key={item.provider}
            item={item}
            selected={providerMode === 'pinned' && item.provider === selectedProvider}
          />
        ))}
      </div>
      {observedAt ? (
        <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
          Checked {formatObservedAt(observedAt)}
        </span>
      ) : null}
    </div>
  );
}

function TemplateCard({
  projectId,
  template,
  canManage,
  onEdit,
  providerMode,
  selectedProvider,
}: {
  projectId: string;
  template: SandboxTemplate;
  canManage: boolean;
  onEdit: (tpl: SandboxTemplate) => void;
  providerMode: SandboxProviderMode;
  selectedProvider: SandboxProvider | null;
}) {
  const queryClient = useQueryClient();
  const { version: manifestVersion } = useProjectManifestVersion(projectId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const templateId = template.template_id ?? null;
  const requireTemplateId = () => {
    if (!templateId) throw new Error('Sandbox template id is missing');
    return templateId;
  };
  const buildMut = useMutation({
    mutationFn: () => buildSandboxTemplate(projectId, requireTemplateId()),
    onSuccess: () => {
      successToast(`Rebuild started for "${template.name}"`);
      queryClient.invalidateQueries({ queryKey: qk.project.snapshots(projectId) });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to start build'),
  });
  const deleteMut = useMutation({
    mutationFn: () => deleteSandboxTemplate(projectId, requireTemplateId()),
    onSuccess: () => {
      successToast(`Deleted "${template.name}"`);
      queryClient.invalidateQueries({ queryKey: qk.project.snapshots(projectId) });
      queryClient.invalidateQueries({ queryKey: qk.project.sandboxes(projectId) });
      setConfirmDelete(false);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to delete template'),
  });

  const stateInfo = describeState(template.provider_state || template.daytona_state);
  const source = describeSource(template, manifestVersion);
  const base = describeBase(template);
  const routing = describeRouting(providerMode, selectedProvider);

  return (
    <>
      <li className="bg-popover overflow-hidden rounded-md border">
        {/* One left edge for the whole card. The header used to lead with a
            `size-9` tile, which pushed the name and status to x=64px while the
            spec grid below started at x=16px — two competing left edges inside
            one card. The status glyph in `TemplateStateLine` carries the tone
            colour the tile used to, so nothing is lost by dropping it, and the
            template kind is stated far more precisely by the "Base image" /
            "Built from" cell than by a decorative glyph. */}
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 pb-3.5">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-foreground truncate text-sm font-medium">{template.name}</span>
              <Badge variant="secondary" size="sm">
                {template.slug}
              </Badge>
              {template.is_default ? (
                <Badge variant="muted" size="sm">
                  Default
                </Badge>
              ) : null}
            </div>
            <TemplateStateLine tone={stateInfo.tone} label={stateInfo.label} />
          </div>
          {canManage && (
            <div className="flex items-center gap-1">
              {templateId && !template.is_default && (
                <>
                  <Hint label="Edit template" side="top">
                    <Button
                      size="icon-base"
                      variant="ghost"
                      className="transition-transform active:scale-[0.96]"
                      onClick={() => onEdit(template)}
                      aria-label="Edit template"
                    >
                      <PencilSimpleIcon className="size-3.5 shrink-0" />
                    </Button>
                  </Hint>
                  <Hint label="Delete template" side="top">
                    <Button
                      size="icon-base"
                      variant="ghost"
                      className="text-destructive hover:text-destructive transition-transform active:scale-[0.96]"
                      disabled={deleteMut.isPending}
                      onClick={() => setConfirmDelete(true)}
                      aria-label="Delete template"
                    >
                      {deleteMut.isPending ? (
                        <Loading className="size-3.5 shrink-0" />
                      ) : (
                        <TrashIcon className="size-3.5 shrink-0" />
                      )}
                    </Button>
                  </Hint>
                </>
              )}
              {templateId && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 transition-transform active:scale-[0.96]"
                  disabled={buildMut.isPending}
                  onClick={() => buildMut.mutate()}
                >
                  {buildMut.isPending ? (
                    <Loading className="size-3.5 shrink-0" />
                  ) : (
                    <ArrowClockwiseIcon className="size-3.5 shrink-0" />
                  )}
                  Rebuild
                </Button>
              )}
            </div>
          )}
        </div>

        {/* SIX cells, every one exactly one track wide — the grid fills two
            complete rows of three with no holes and no spans. The base-image
            cell used to take `col-span-2`, which left row 1 as three equal
            cells and row 2 as one narrow beside one double-wide: a uniform
            track carrying ragged content. Long image refs now truncate inside
            their own cell (full string on the native `title`) instead of
            widening it.

            `tabular-nums` on the whole list: vCPU / GiB / GiB-disk are the same
            three numbers repeated down every card, so proportional digits make
            the columns wander between cards. Matches `snapshots-tab.tsx`, the
            other half of this split, which pins its timestamps the same way. */}
        <dl className="border-border/60 grid grid-cols-2 gap-x-4 gap-y-4 border-t px-4 py-4 tabular-nums sm:grid-cols-3">
          <TemplateFact icon={CpuIcon} label="Processor" value={`${template.cpu} vCPU`} />
          <TemplateFact icon={MemoryIcon} label="Memory" value={`${template.memory_gb} GiB`} />
          <TemplateFact icon={HardDrivesIcon} label="Storage" value={`${template.disk_gb} GiB`} />
          <TemplateFact icon={base.icon} label={base.label} value={base.value} mono={base.mono} />
          <TemplateFact
            icon={source.icon}
            label="Defined in"
            value={source.label}
            mono={source.mono}
          />
          <TemplateFact icon={routing.icon} label="Routing" value={routing.label} />
        </dl>

        <TemplateRuntimeFooter
          coverage={template.provider_coverage}
          providerMode={providerMode}
          selectedProvider={selectedProvider}
        />
      </li>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete sandbox template "${template.name}"?`}
        description="This removes the template from the project. Sessions already using it are unaffected."
        confirmLabel="Delete"
        confirmVariant="destructive"
        isPending={deleteMut.isPending}
        onConfirm={() => deleteMut.mutate()}
      />
    </>
  );
}

/**
 * One flat block per card — deliberately NOT a wireframe of the card's insides.
 *
 * The previous version drew a `bg-popover rounded-md border` panel and packed
 * six `Skeleton` shapes into it: a tile, two text bars and a three-cell row.
 * That reads as a skeleton nested inside a skeleton — the bordered panel is
 * already surface chrome, so filling it with more grey blocks gives the eye
 * structure to parse at exactly the moment there is nothing to read. It had
 * also silently gone stale: it still drew the `size-9` status tile that the
 * card itself no longer has.
 *
 * `h-60` (240px) is the settled height of a card with a runtime footer
 * (72px header + 129px grid + 41px footer = 242px), so the list barely moves
 * when real data lands.
 */
const TEMPLATE_SKELETON_HEIGHT = 'h-60';

/**
 * Per-project sandbox-provider pin. **Moved here from `general-tab.tsx`, not
 * copied** — General no longer mentions sandboxes at all. The move is the
 * product owner's own call ("just combine truly everything in one place that
 * is sandbox related"), and it puts the control that SETS the pin directly
 * above the cards that REPORT it: every `TemplateCard`'s "Routing" cell and
 * runtime footer read the same pin this row writes.
 *
 * The mutation, the prepare-vs-immediate branch, the durable-transition
 * polling and every toast are carried over unchanged from `general-tab.tsx` —
 * only the enclosing tab and the section label ("Sandbox" -> "Routing", the
 * word the template cards already use for this) are different.
 *
 * Overrides the platform's weighted distribution for THIS project only.
 * Options come from the project payload (`available_sandbox_providers`).
 * Hidden only when no provider is usable.
 */
const AUTO_PROVIDER = '__auto__';
function SandboxProviderRow({
  project,
  canManage,
}: {
  project: KortixProject;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const available = project.available_sandbox_providers ?? [];
  const current = project.default_sandbox_provider ?? null;
  const label = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

  const mutation = useMutation({
    mutationFn: (next: SandboxProviderName | null) =>
      updateProjectSandboxProvider(project.project_id, next),
    onSuccess: (result, next) => {
      // FIX-L: the PATCH returns EITHER the updated project (immediate) OR a
      // preparation object (the prepare branch — a switch to a different enabled
      // provider). Write the project cache ONLY for the immediate result; a
      // preparation is a transition, not a project, and must not clobber the
      // cached project shape.
      const kind = applySandboxProviderResult(queryClient, project.project_id, result);
      if (kind === 'preparation') {
        successToast(
          `Preparing ${next ? label(next) : 'the sandbox provider'}… this can take a few minutes`,
        );
        // Poll the durable transition (bounded, backoff, terminal-stop, 404 = done)
        // and refresh the project once it settles so the now-active provider shows.
        void pollSandboxProviderTransition(project.project_id, {
          onSettled: (state) => {
            // invalidateProject() reaches qk.project.scope(project.project_id),
            // which qk.project.summary(project.project_id) nests under — so it
            // already covers the bare-project row too; no separate summary
            // invalidation needed here.
            void invalidateProject(queryClient, project.project_id);
            // qk.projects.scope(): restores the reach the old bare
            // projects-literal prefix match had. A sandbox-provider switch
            // is rare — over-invalidating a few extra account lists costs
            // nothing measurable.
            queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
            const status = state?.latest?.status;
            if (status === 'activated') {
              successToast(`Switched to ${label(state?.latest?.target_provider ?? '')}`);
            } else if (status === 'failed') {
              errorToast(state?.latest?.label || 'Sandbox provider switch failed');
            }
          },
        });
      }
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update sandbox provider'),
  });

  if (available.length === 0) return null;

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader title="Routing" />
      <SettingsRowGroup>
        <SettingsRow
          label={
            <>
              Sandbox provider
              <Badge variant="highlight" size="sm">
                Experimental
              </Badge>
            </>
          }
          description="Pin this project to a specific sandbox provider, overriding the platform default. New sessions here run on the chosen provider — “Automatic” follows the platform default."
        >
          <Select
            value={current ?? AUTO_PROVIDER}
            onValueChange={(v) =>
              mutation.mutate(
                v === AUTO_PROVIDER ? null : (available.find((provider) => provider === v) ?? null),
              )
            }
            disabled={!canManage || mutation.isPending}
          >
            <SelectTrigger aria-label="Sandbox provider" className="h-8 w-40 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value={AUTO_PROVIDER}>Automatic</SelectItem>
              {available.map((p) => (
                <SelectItem key={p} value={p}>
                  {label(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsRowGroup>
    </section>
  );
}

export interface SandboxTabViewProps {
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  /** "New template" button next to the section header — manager-only, built
   *  by the container from the same `canManage` gate as everything else in
   *  this tab. `undefined` (not rendered) for a non-manager. */
  headerAction?: ReactNode;
  /** `SandboxProviderRow` — the per-project provider pin, moved here from
   *  `general-tab.tsx`. A slot for the same reason `templatesSlot` is one: it
   *  owns a `useMutation`/`useQueryClient` and cannot render under
   *  `renderToStaticMarkup` with no `QueryClientProvider`.
   *
   *  Rendered ABOVE the loading/error branch on purpose. It is fed by the
   *  PROJECT query, not the snapshots query, so a slow or failed template read
   *  must not hide a control that has nothing to do with it. */
  sandboxProviderSlot?: ReactNode;
  /** `1 | 2 | null` — drives whether the manifest hint below reads
   *  `kortix.toml` or `kortix.yaml`. `null`/anything else falls back to
   *  `kortix.toml`, matching `sandbox-view.tsx`'s own ternary default. */
  manifestVersion?: number | null;
  /** `data.templates_error` from `listProjectSnapshots` — a partial-read
   *  warning, not a hard error (the hard-error path is `isError` above). */
  templatesError?: string | null;
  /** `templates.length === 0` — this tab's own empty state, scoped to its
   *  own domain now that the split removed the old combined
   *  "templates AND builds both empty" check. See this file's header
   *  comment. */
  isEmpty?: boolean;
  emptyAction?: ReactNode;
  /** The `<ul>` of `TemplateCard`s, built by the container — see this file's
   *  header comment for why it's a slot. */
  templatesSlot?: ReactNode;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `SandboxTab` so this renders under
 *  `renderToStaticMarkup` with no `QueryClientProvider` — see
 *  `GeneralTabView` for the same split. */
export function SandboxTabView({
  isLoading = false,
  isError = false,
  errorMessage = '',
  onRetry = () => {},
  headerAction,
  sandboxProviderSlot,
  manifestVersion = null,
  templatesError = null,
  isEmpty = true,
  emptyAction,
  templatesSlot,
}: SandboxTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <div className="space-y-8">
        <SettingsTabHeader tab="sandbox" action={headerAction} />
        {sandboxProviderSlot}
        {isLoading ? (
          <div className="space-y-2">
            {TEMPLATE_SKELETON_ROWS.map((row) => (
              <Skeleton key={row} className={cn(TEMPLATE_SKELETON_HEIGHT, 'rounded-md')} />
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            size="sm"
            title="Failed to load sandbox templates:"
            description={errorMessage}
            action={
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            }
          />
        ) : (
          <div className="space-y-4">
            <p className="text-muted-foreground text-sm text-pretty">
              Every session starts from a sandbox template — a prepared machine with your repository
              already checked out at <code className="font-mono">/workspace</code>. The Kortix
              default works for most projects. Add your own below, or declare them as{' '}
              {manifestVersion === 2 ? (
                <>
                  <code className="font-mono">sandbox.templates</code> in{' '}
                  <code className="font-mono">kortix.yaml</code>
                </>
              ) : (
                <>
                  <code className="font-mono">[[sandbox.templates]]</code> in{' '}
                  <code className="font-mono">kortix.toml</code>
                </>
              )}
              .
            </p>

            {templatesError ? (
              <InfoBanner tone="warning">
                Couldn’t read project sandbox config: {templatesError}
              </InfoBanner>
            ) : null}

            {isEmpty ? (
              <EmptyState
                icon={ShippingContainerIcon}
                size="sm"
                title="No templates resolved yet."
                description="Create one, or add it to your project's manifest."
                action={emptyAction}
              />
            ) : (
              templatesSlot
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Container: owns every hook (project + snapshots queries, the template
 *  form's open/edit state) and renders `SandboxTabView` with real data +
 *  the templates slot, plus `SandboxTemplateForm` as a sibling (it owns its
 *  own mutations — see this file's header comment). Only ever mounted while
 *  this tab is active (`SettingsTabPane` in `settings-panel.tsx` returns
 *  `null` otherwise), so nothing here fetches on panel open. */
export function SandboxTab({ projectId }: { projectId: string }) {
  const projectQuery = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    ...contract('config'),
  });
  // Two different leaves, one batched probe. Template CRUD asserts
  // `project.customize.write`; the provider row asserts `project.write`. They
  // are deliberately NOT merged — a role may hold one without the other.
  const caps = useProjectCans(projectId, SANDBOX_TAB_ACTIONS);
  const canManage = caps[PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE]?.allowed === true;
  const canEditProvider = caps[PROJECT_ACTIONS.PROJECT_WRITE]?.allowed === true;
  const { version: manifestVersion } = useProjectManifestVersion(projectId);

  const snapshotsQuery = useQuery({
    queryKey: qk.project.snapshots(projectId),
    queryFn: () => listProjectSnapshots(projectId),
    ...contract('config'),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const templates = Array.isArray(data.templates) ? data.templates : [];
      const anyBuilding =
        templates.some((t) => t.provider_state === 'building') ||
        templates.some((t) =>
          t.provider_coverage?.some((provider) => provider.status === 'building'),
        );
      return anyBuilding ? 5_000 : false;
    },
  });

  const [formOpen, setFormOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<SandboxTemplate | null>(null);

  const data = snapshotsQuery.data;
  const templates = Array.isArray(data?.templates) ? data.templates : [];

  /**
   * ONE pin, read once — the control and the badges must never disagree.
   *
   * `SandboxProviderRow` writes `project.default_sandbox_provider`;
   * `listProjectSnapshots` derives its own `provider_mode`/`selected_provider`
   * from the SAME `projects.metadata.default_sandbox_provider` server-side
   * (`apps/api/src/projects/routes/r2.ts` -> `templateProviderObservation` ->
   * `resolveConfiguredProjectProviderPin`). They agree at the source, but they
   * are two independent query caches and the switch only invalidates the
   * project one — so reading the pin off the snapshots payload would leave
   * every card's "Routing" cell showing the provider the row just changed away
   * from, on the same screen, until the snapshots query happened to refetch.
   *
   * The project query is therefore authoritative. The snapshots payload is the
   * fallback for the window before it lands, which keeps this exactly as
   * correct as it was before the move.
   */
  const pinnedProvider: SandboxProvider | null = projectQuery.data
    ? (projectQuery.data.default_sandbox_provider ?? null)
    : (data?.selected_provider ?? null);
  const providerMode: SandboxProviderMode = pinnedProvider ? 'pinned' : 'automatic';
  const selectedProvider = pinnedProvider;

  const openNewForm = () => {
    setEditingTemplate(null);
    setFormOpen(true);
  };
  const openEditForm = (tpl: SandboxTemplate) => {
    setEditingTemplate(tpl);
    setFormOpen(true);
  };

  // Same quirk as `sandbox-view.tsx`: this button does NOT reset
  // `editingTemplate` (only `openNewForm`, used by the header action, does)
  // — preserved as-is, not in scope to fix.
  const newTemplateAction = canManage ? (
    <Button
      size="sm"
      variant="outline"
      className="gap-1.5 transition-transform active:scale-[0.96]"
      onClick={() => setFormOpen(true)}
    >
      <PlusIcon className="size-3.5 shrink-0" />
      New template
    </Button>
  ) : undefined;

  return (
    <>
      <SandboxTabView
        isLoading={snapshotsQuery.isLoading}
        isError={snapshotsQuery.isError}
        errorMessage={(snapshotsQuery.error as Error)?.message ?? ''}
        onRetry={() => snapshotsQuery.refetch()}
        headerAction={
          canManage ? (
            <Button
              size="sm"
              variant="secondary"
              className="gap-1.5 transition-transform active:scale-[0.96]"
              onClick={openNewForm}
            >
              <PlusIcon className="size-4 shrink-0" />
              New template
            </Button>
          ) : undefined
        }
        sandboxProviderSlot={
          projectQuery.data ? (
            <SandboxProviderRow project={projectQuery.data} canManage={canEditProvider} />
          ) : undefined
        }
        manifestVersion={manifestVersion}
        templatesError={data?.templates_error ?? null}
        isEmpty={templates.length === 0}
        emptyAction={newTemplateAction}
        templatesSlot={
          templates.length === 0 ? undefined : (
            <ul className="space-y-2">
              {templates.map((t) => (
                <TemplateCard
                  key={t.template_id ?? `tpl-${t.slug}`}
                  projectId={projectId}
                  template={t}
                  canManage={canManage}
                  onEdit={openEditForm}
                  providerMode={providerMode}
                  selectedProvider={selectedProvider}
                />
              ))}
            </ul>
          )
        }
      />
      <SandboxTemplateForm
        projectId={projectId}
        open={formOpen}
        onOpenChange={setFormOpen}
        template={editingTemplate}
      />
    </>
  );
}
