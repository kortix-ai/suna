'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { RadioGroup } from '@/components/ui/radio-group';
import { useOptionalSidebar } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { FeatureGateScreen } from '@/features/workspace/feature-gate-screen';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';
import { ShareOption, SubjectPicker } from '@/features/workspace/shared/sharing-picker';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { relativeTime } from '@/lib/relative-time';
import {
  CLIPBOARD_IFRAME_ALLOW,
  INTERACTIVE_PREVIEW_IFRAME_SANDBOX,
} from '@/lib/security/iframe-sandbox';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  createAppAccessSession,
  type App,
  type AppAccessConfig,
  type AppAccessMode,
  type AppDeployment,
} from '@kortix/sdk';
import { useAppAccess, useAppDeployments, useFeatureFlag, useProjectApps } from '@kortix/sdk/react';
import {
  ArrowSquareOutIcon,
  ArrowUpRightIcon,
  ClockCounterClockwiseIcon,
  DotsThreeIcon,
  GlobeIcon,
  LockKeyIcon,
  PauseIcon,
  PlayIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useLayoutEffect, useState } from 'react';

type DeploymentTone = 'success' | 'destructive' | 'warning' | 'muted';

/**
 * Every deployment status, in words a person who did not build this can read.
 *
 * The raw values are pipeline stages — `validating`, `provisioning`, `checking`
 * — and they were rendered verbatim into a badge. That is the vocabulary of the
 * thing that runs the build, not of the person watching it, and `provisioning`
 * in particular tells a reader nothing they can act on.
 *
 * One table instead of the if-chain this replaces: the chain listed five of the
 * eight statuses by hand to reach one tone, so adding a status to the union got
 * `muted` and silence rather than a type error. A `Record` over the union does
 * not compile until every new status is given a label and a tone.
 */
export const DEPLOYMENT_COPY: Record<
  AppDeployment['status'],
  { label: string; tone: DeploymentTone }
> = {
  queued: { label: 'Waiting', tone: 'warning' },
  validating: { label: 'Checking files', tone: 'warning' },
  building: { label: 'Building', tone: 'warning' },
  provisioning: { label: 'Starting up', tone: 'warning' },
  checking: { label: 'Final checks', tone: 'warning' },
  ready: { label: 'Live', tone: 'success' },
  failed: { label: 'Failed', tone: 'destructive' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

/**
 * What the HEADER says about the newest deployment — or nothing at all.
 *
 * Deliberately coarser than the table above. A header badge is read at a glance
 * while you are using the App, and at that moment the difference between
 * `validating` and `provisioning` is not a difference the reader can do
 * anything with: both mean "a new version is on its way". The version list is
 * where the stage-by-stage detail belongs, and it has it.
 *
 * `null` is the common case, and it is the point. A finished deployment is what
 * every App looks like almost all of the time, so saying "Live" there would put
 * a permanent badge in the header restating the green dot beside it. Cancelled
 * is silent for the same reason: nothing is happening and nothing is broken.
 */
export function deployNotice(
  latest: AppDeployment | undefined,
): { label: string; tone: DeploymentTone } | null {
  if (!latest || latest.status === 'ready' || latest.status === 'cancelled') return null;
  if (latest.status === 'failed') return { label: 'Update failed', tone: 'destructive' };
  return { label: 'Updating', tone: 'warning' };
}

function appCommand(app: App): string {
  return `kortix apps deploy . --app ${app.app_id}`;
}

/** The command that puts a first App on this page. Shown in the empty state. */
const FIRST_DEPLOY_COMMAND = 'kortix apps deploy .';

/**
 * The hostname a person reads an App by.
 *
 * `app.url` is a full origin (`https://seed.apps.kortix.com`). The scheme is
 * the same on every App and the trailing slash is noise, so both are dropped —
 * a card's second line is 300px wide and every character it spends on `https://`
 * is a character the actual subdomain loses to truncation.
 *
 * Exported for its own test: this is pure string work with a live input shape,
 * which is exactly what `apps/web` can assert without a DOM.
 */
export function appHost(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/**
 * Everything the UI says about an App's state, derived in ONE place.
 *
 * `desired_state` defaults to `'running'` the moment an App row is created, so
 * it is intent, not fact — an App that has never been deployed reports
 * `running` and has no runtime at all. Every surface must therefore read
 * `active_deployment_id` first, and it does so here rather than in each of the
 * three places that used to re-derive it.
 */
function appStatus(app: App): { deployed: boolean; live: boolean; label: string; dot: string } {
  const deployed = Boolean(app.active_deployment_id);
  const live = deployed && app.desired_state === 'running';
  return {
    deployed,
    live,
    label: !deployed ? 'Not deployed' : live ? 'Running' : 'Suspended',
    // Three states, three weights of the same neutral-vs-green pair: running is
    // the only one that earns colour.
    dot: live ? 'bg-kortix-green' : deployed ? 'bg-muted-foreground/50' : 'bg-muted-foreground/25',
  };
}

/**
 * Who can open an App, in the words the picker shows.
 *
 * Module scope, above every consumer. It used to be declared BELOW
 * `AppDetailModal`, the component that reads it — legal, because the read
 * happens at render rather than at module evaluation, and confusing for exactly
 * as long as it takes to check whether it is.
 */
const ACCESS_COPY: Record<AppAccessMode, { label: string; desc: string }> = {
  private: { label: 'Only you', desc: 'Only the App creator can open it' },
  project: { label: 'Whole team', desc: 'Every member of this project' },
  restricted: { label: 'Select members', desc: 'Chosen members and groups' },
  public: { label: 'Public', desc: 'Anyone with the URL' },
  password: { label: 'Password', desc: 'Anyone with the App password' },
};

/**
 * A shell command, shown as the thing you would actually type.
 *
 * Radius is concentric: `rounded-md` (6px) outer, `py-1` (4px) padding, so the
 * copy button inside takes `rounded-sm` (2px) — which is what `CopyButton`'s
 * `size="sm"` already carries.
 */
function DeployCommand({ code, className }: { code: string; className?: string }) {
  return (
    <span
      className={cn(
        'bg-popover inline-flex max-w-full items-center gap-2 rounded-md border py-1 pr-1 pl-2.5',
        className,
      )}
    >
      <span aria-hidden className="text-muted-foreground/50 shrink-0 font-mono text-xs select-none">
        $
      </span>
      <code className="text-foreground truncate font-mono text-xs">{code}</code>
      <CopyButton code={code} size="sm" className="shrink-0" />
    </span>
  );
}

/**
 * How long a frame may take before we admit out loud that it is loading.
 *
 * A warm App paints far inside this — the card thumbnail already fetched the
 * signed URL, so the modal's frame is the second request for a document the
 * browser has cached. Painting the overlay from mount made every one of those
 * flash a spinner for a single frame on the way in, which reads as SLOWER than
 * showing nothing. Below the threshold the frame area stays on its calm
 * `bg-muted/20` surface and the App simply appears.
 */
export const PREVIEW_SPINNER_DELAY_MS = 280;

/**
 * The delay timer, extracted from the effect so the threshold is testable.
 * `apps/web` has no DOM test harness, so a hook's effect cannot be driven from
 * a test — this seam can, with fake timers.
 */
export function scheduleSlowPreview(
  onSlow: () => void,
  delayMs: number = PREVIEW_SPINNER_DELAY_MS,
): () => void {
  const timer = setTimeout(onSlow, delayMs);
  return () => clearTimeout(timer);
}

/**
 * True once a still-pending frame has passed the threshold above.
 *
 * There is no reset branch because there is nothing to reset: `pending` only
 * ever goes true → false (the frame loads, or it errors), and a frame that has
 * settled is covered by `loaded` / `failed`. A remount — a new deployment — gets
 * a fresh `key` from the caller and therefore fresh state.
 */
function useSlowPreview(pending: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) return;
    return scheduleSlowPreview(() => setSlow(true));
  }, [pending]);
  return slow;
}

/**
 * What covers the frame while it is not showing the App.
 *
 * Exported for its own test: the whole point of this component is the state it
 * DOESN'T render (no spinner before the threshold), which is only assertable
 * against markup.
 */
export function AppPreviewOverlay({
  loaded,
  failed,
  slow,
}: {
  loaded: boolean;
  failed: boolean;
  slow: boolean;
}) {
  // A failure is never worth waiting to report — `onError` means the frame is
  // done and it is not going to paint.
  if (!failed && (loaded || !slow)) return null;
  return (
    <div className="bg-background/95 absolute inset-0 flex items-center justify-center px-6 text-center backdrop-blur-sm">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        {failed ? null : <Loading className="size-4 shrink-0" />}
        <span>{failed ? 'Preview unavailable. Open the App to retry.' : 'Loading preview'}</span>
      </div>
    </div>
  );
}

/**
 * The logical viewport a CARD thumbnail renders the App into, and the shape of
 * the tile it lands in. These three constants are ONE decision — see the ratio
 * note below — so they live together.
 *
 * A card tile is narrower than a laptop, and an iframe that wide is a viewport
 * that wide — so a small tile makes the App answer with its mobile layout.
 * Every thumbnail on the page was a hamburger over a single stacked column: the
 * one view of the App nobody deploys an App for, and nothing like what opening
 * it actually shows.
 *
 * Render at a desktop width instead and scale the result down. The App lays
 * out at 1080px — still a desktop breakpoint, so no App answers with its
 * hamburger — and the tile shows that layout in miniature.
 *
 * **The ratio is load-bearing.** The frame is scaled to the tile's WIDTH, so
 * any mismatch between the viewport's aspect and the tile's shows up as dead
 * space at the bottom of every tile (viewport shorter) or a crop (taller).
 * 1080x1350 is 4:5 exactly, which is `PREVIEW_TILE_ASPECT`, so the scaled frame
 * fills the tile edge to edge. Change one, change the other — the parity is
 * asserted in `app-preview.test.tsx`.
 *
 * The width and the height answer two different questions, and only the second
 * is about the ratio. The viewport WIDTH decides which layout the App renders,
 * and 1080px is a desktop breakpoint — no App answers the thumbnail with its
 * hamburger. The viewport HEIGHT decides how far down that page the thumbnail
 * reaches: 1350px of a 1080px-wide page is a hero and the section under it,
 * where the 720px of the old 16:9 tile was the header alone.
 *
 * The ratio is a row-height decision: every candidate trades how much page a
 * tile shows against how many rows fit a screen, at a fixed tile width.
 *
 *   | ratio     | height/width | tile at cap | four-across row              |
 *   | ---       | ---          | ---         | ---                          |
 *   | `16/9`    | 0.56x        | 300x169     | a letterbox of the header    |
 *   | `1/1`     | 1.00x        | 300x300     | two rows and part of a third |
 *   | **`4/5`** | **1.25x**    | **300x375** | **two rows on a laptop**     |
 *   | `3/4`     | 1.33x        | 300x400     | a row and a half             |
 *   | `2/3`     | 1.50x        | 300x450     | a row and a third            |
 *   | `9/16`    | 1.78x        | 300x533     | about one row                |
 *
 * 4:5 is the one ratio here that shipped BEFORE and was reverted (`e56c580271`,
 * reverted by `e6c4ba0b62`), so the reason it works now and did not then has to
 * be written down: it was paired with a `max-w-5xl` cap and a fixed four-column
 * grid, which is a 230px tile — the App at 18% scale, every card the same grey
 * rectangle. What changed is not the ratio. The cap is `max-w-7xl` and the
 * columns come from a container ladder floored at ~232px, so the tile is 300px
 * at the cap and never the 230px that killed it. Do not revert this to 16:9
 * again; fix the ladder if a tile ever gets small.
 *
 * At the four columns a docked desktop lands on (`APP_GRID_COLUMNS`), a tile is
 * ~276x345 — the App at ~26% scale.
 *
 * Note what does NOT solve the mobile-layout problem — `showAspectRatioToCSS`
 * in `show-content-renderer.tsx` reshapes the BOX and leaves the guest laying
 * out at the host's width, which is the thing that produced it here.
 */
export const PREVIEW_VIEWPORT_WIDTH = 1080;
export const PREVIEW_VIEWPORT_HEIGHT = 1350;
/** The tile's shape, written once so the class and the viewport cannot drift. */
export const PREVIEW_TILE_ASPECT = 'aspect-[4/5]';

/**
 * How many tiles the gallery puts in a row.
 *
 * **Container queries, not viewport breakpoints.** This page sits beside a
 * sidebar that docks and collapses, so the grid's real width swings by ~256px
 * while the viewport never moves. `xl:grid-cols-4` on a 1280px viewport with
 * the sidebar docked fires on a container that is actually ~1024px wide — four
 * 236px tiles from a class chosen for 300px ones. `@5xl/apps:` asks the only
 * question that decides whether a column fits: how wide is the box the grid is
 * in. The named container is declared on the padded column in `AppsView`.
 *
 * The steps are chosen so the TILE never drops below ~232px at any of them —
 * the width where a 1080px page scaled into it stops reading as a page and
 * starts reading as a grey rectangle. Container width -> tile width:
 *
 *   | step            | container | cols | tile    |
 *   | ---             | ---       | ---  | ---     |
 *   | (base)          | < 512px   | 1    | full    |
 *   | `@lg`  (32rem)  | 512px     | 2    | 232x290 |
 *   | `@3xl` (48rem)  | 768px     | 3    | 235x294 |
 *   | `@5xl` (64rem)  | 1024px    | 4    | 236x295 |
 *   | (cap)           | 1280px    | 4    | 300x375 |
 *
 * Four across is therefore what a docked desktop lands on, and a phone still
 * gets one column — a 170px tile is the grey rectangle again.
 *
 * Written out as one literal. Tailwind scans source text, so a class assembled
 * at runtime (`grid-cols-${n}`) never reaches the compiled stylesheet and
 * silently does nothing.
 */
export const APP_GRID_CONTAINER = '@container/apps';

export const APP_GRID_COLUMNS =
  'grid-cols-1 @lg/apps:grid-cols-2 @3xl/apps:grid-cols-3 @5xl/apps:grid-cols-4';

/**
 * How far to shrink the desktop frame so it fits the tile. `null` for a width
 * nothing can be concluded from — a detached node, a display:none ancestor, a
 * server render with no layout at all — which the caller paints as "not yet
 * measured" rather than scaling by a garbage factor.
 */
export function previewScale(
  containerWidth: number,
  viewportWidth: number = PREVIEW_VIEWPORT_WIDTH,
): number | null {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return null;
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return null;
  return containerWidth / viewportWidth;
}

/**
 * Measures the tile and keeps the scale honest as it changes.
 *
 * A layout effect, not an effect: it runs after DOM mutation and BEFORE paint,
 * so the browser never shows the unscaled 1080px frame cropped to the tile's
 * top-left corner. The `ResizeObserver` then covers every later change — the
 * responsive grid going one-column, a sidebar opening, a window drag — none of
 * which fire anything else this component would hear.
 */
function useDesktopViewportScale(enabled: boolean) {
  // A callback ref held in state, not a `useRef`: the node is an INPUT to the
  // measurement, so the effect has to re-run when it arrives. A ref object
  // would also have to be read during render to be handed to `<div ref>`,
  // which is the thing `react-hooks/refs` correctly refuses.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!enabled || !node) return;

    const measure = () => setScale(previewScale(node.getBoundingClientRect().width));
    measure();

    // Guarded for a runtime without it (jsdom-less unit renders, older Safari):
    // the one synchronous measurement above still lands, so the frame is scaled
    // correctly at its mounted size and simply stops tracking resizes.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, node]);

  // A tuple, not an object. `react-hooks/refs` treats every property read on an
  // object whose member lands in a `ref=` prop as a ref access during render —
  // true for a `useRef` container, wrong for a callback ref. Destructuring to
  // plain locals says what this is and keeps the rule meaningful where it does
  // apply.
  return [setNode, scale] as const;
}

export function AppPreview({
  app,
  url,
  accessError,
  /**
   * `false` on a CARD: the card is one big button, and a live iframe would
   * swallow every click meant for it (and let someone interact with a page
   * inside a 300px tile). The card renders the frame purely as a thumbnail and
   * the card takes the click. `true` in the detail modal, where the frame IS
   * the App.
   */
  interactive,
  className,
}: {
  app: App;
  url: string | null;
  accessError: boolean;
  interactive: boolean;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const slow = useSlowPreview(!loaded && !failed);
  // Cards only. In the modal the frame IS the App at the size you are using it,
  // so a fixed desktop viewport there would scale the thing you came to click.
  const [attachViewport, viewportScale] = useDesktopViewportScale(!interactive);
  const frame = cn(
    'bg-muted/20 relative overflow-hidden',
    !interactive && PREVIEW_TILE_ASPECT,
    className,
  );

  if (!app.active_deployment_id) {
    return (
      <div
        className={cn(
          frame,
          'text-muted-foreground flex items-center justify-center px-6 text-center text-xs text-pretty',
        )}
        data-testid="app-preview-empty"
      >
        Deploy to see a live preview.
      </div>
    );
  }

  if (!url) {
    return (
      <div
        className={cn(
          frame,
          'text-muted-foreground flex items-center justify-center px-6 text-center text-xs text-pretty',
        )}
        data-testid={accessError ? 'app-preview-access-denied' : 'app-preview-loading'}
      >
        {accessError ? (
          'You do not have access to preview this App.'
        ) : (
          <span className="flex items-center gap-2">
            <Loading className="size-4 shrink-0" />
            Preparing preview
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={frame} ref={attachViewport}>
      <iframe
        key={app.active_deployment_id}
        src={url}
        title={`${app.name} live preview`}
        style={
          interactive
            ? undefined
            : {
                width: PREVIEW_VIEWPORT_WIDTH,
                height: PREVIEW_VIEWPORT_HEIGHT,
                // Hidden, not unmounted, until the tile has been measured: an
                // unmounted frame would restart the document load on every
                // resize, and a visible unscaled one would flash the App's
                // top-left 1080px corner. It still loads while hidden.
                ...(viewportScale === null
                  ? { visibility: 'hidden' as const }
                  : { transform: `scale(${viewportScale})` }),
              }
        }
        // The card thumbnail is one of many below the fold, so defer it. In the
        // modal the frame IS the content and it is already on screen — `lazy`
        // there makes the browser wait for layout before it even starts the
        // fetch, which is pure added latency on the one open that must feel
        // instant.
        loading={interactive ? 'eager' : 'lazy'}
        allow={CLIPBOARD_IFRAME_ALLOW}
        sandbox={INTERACTIVE_PREVIEW_IFRAME_SANDBOX}
        className={cn(
          'bg-background absolute border-0',
          interactive
            ? 'inset-0 size-full'
            : // Anchored top-left because that is the scale's origin: the frame
              // shrinks toward the corner it starts in, so the miniature lands
              // flush in the tile instead of drifting toward the middle.
              'pointer-events-none top-0 left-0 origin-top-left',
        )}
        {...(interactive ? {} : { tabIndex: -1, 'aria-hidden': true })}
        data-testid="app-live-preview"
        onLoad={() => {
          setLoaded(true);
          setFailed(false);
        }}
        onError={() => {
          setLoaded(false);
          setFailed(true);
        }}
      />
      <AppPreviewOverlay loaded={loaded} failed={failed} slow={slow} />
    </div>
  );
}

function AppsHeader() {
  const sidebar = useOptionalSidebar();

  return (
    <div
      className="kx-titlebar-row relative flex shrink-0 items-center gap-1 border-b px-2"
      data-sidebar-collapsed={sidebar?.state === 'collapsed' || undefined}
    >
      <SidebarToggle />
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-3">
        <h1 className="text-foreground shrink-0 text-sm font-medium">Apps</h1>
      </div>
      <Link
        href="/docs/feature-flags/apps"
        target="_blank"
        rel="noopener noreferrer"
        prefetch={false}
        className="text-muted-foreground hover:text-foreground flex w-fit flex-none items-center gap-1 px-3 py-3 text-sm font-medium whitespace-nowrap transition-colors"
      >
        Docs
        <ArrowUpRightIcon className="size-3 opacity-60" aria-hidden />
      </Link>
    </div>
  );
}

export function AppsView({ projectId }: { projectId: string }) {
  // One gating primitive, fail-closed. Apps NEVER enables itself from here:
  // activation lives only in Customize → Feature flags, so this page has no
  // mutation and no self-enable button.
  const appsGate = useFeatureFlag(projectId, 'apps');
  const apps = useProjectApps(appsGate.enabled ? projectId : null);
  const searchParams = useSearchParams();
  // Apps own their leaves — the routes assert project.app.write for policy and
  // shape changes and project.app.deploy for anything that changes what the
  // public hostname serves. Gating on project.customize.write let a custom role
  // that granted Apps still render read-only, and one that revoked Apps still
  // render the controls.
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_WRITE).allowed === true;
  const canDeploy = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_DEPLOY).allowed === true;
  // Which App the detail modal is showing. Held by id, not by object, so a
  // refetch (a lifecycle toggle, a rollback) re-renders the modal against the
  // fresh row instead of a stale copy captured at click time.
  const [openAppId, setOpenAppId] = useState<string | null>(null);
  const openApp = apps.data?.find((item) => item.app_id === openAppId) ?? null;

  useEffect(() => {
    const target = searchParams.get('open_app');
    if (!target || !apps.data) return;
    const app = apps.data.find((item) => item.app_id === target);
    if (!app) return;
    void createAppAccessSession(projectId, app.app_id)
      .then((session) => window.location.replace(session.url))
      .catch((error) => errorToast(error instanceof Error ? error.message : 'App access denied'));
  }, [apps.data, projectId, searchParams]);

  return (
    // `h-svh`, for the same reason the `(capabilities)` layout carries it:
    // nothing above this box has a definite height (every ancestor from
    // `<body>` down is `min-h-*` or `flex-1 overflow-hidden`), so without one
    // the body below would never have a bound to scroll within and the WINDOW
    // would scroll — taking the header bar with it. Bounded here, the bar needs
    // no `sticky` and no `fixed`: it is a sibling above the only scrolling
    // element on the page, so it structurally cannot move. `svh` (not `dvh`)
    // assumes mobile browser chrome is visible, so the bar can never be pushed
    // under a toolbar that reappears.
    <div className="flex h-svh flex-col overflow-hidden">
      <AppsHeader />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* `max-w-7xl px-4` — the gallery's column, and the CONTAINER the grid
            measures itself against (`@container/apps`). Putting the container
            here and not on the scroll box is the point: this is the element
            whose width the tiles actually divide, so it already accounts for
            the cap, the gutter, and the sidebar. `px-4` matches
            `CapabilityPageShell`'s gutter so the grid never presses flush
            against the browser edge.

            `flex min-h-full flex-col` so the one child that asks for height
            gets it: `EmptyState`/`ErrorState` are built on `Empty`, which is
            `flex-1 … justify-center`, and with no bound to grow into they
            collapsed to their own content and clung to the top of a tall,
            otherwise blank page. The grid, the skeleton and the feature gate
            take their natural height and stay at the top, unaffected. */}
        <div
          className={cn(
            'mx-auto flex min-h-full w-full max-w-7xl flex-col px-4 py-6 pb-20',
            APP_GRID_CONTAINER,
          )}
        >
          {appsGate.isLoading ? (
            <AppGridSkeleton />
          ) : !appsGate.enabled ? (
            <FeatureGateScreen
              featureName="Apps"
              description="Apps deploy static sites, JavaScript bundles, Dockerfiles, and OCI images to stable URLs. Each App wakes on its next request and suspends after its idle timeout."
            />
          ) : apps.isLoading ? (
            <AppGridSkeleton />
          ) : apps.isError ? (
            <ErrorState
              size="sm"
              title="Failed to load Apps"
              description={(apps.error as Error).message}
              action={
                <Button size="sm" variant="outline" onClick={() => apps.refetch()}>
                  Retry
                </Button>
              }
            />
          ) : apps.data?.length ? (
            /* A gallery grid, sized by the space it has rather than by the
               window (`APP_GRID_COLUMNS`). `gap-y` is larger than `gap-x`
               because each tile's caption hangs BELOW it with no border to
               close it off — an equal gap would let the next row's thumbnail
               crowd the previous row's text. */
            <ul className={cn('grid gap-x-4 gap-y-6', APP_GRID_COLUMNS)}>
              {apps.data.map((app) => (
                <AppCard
                  key={app.app_id}
                  projectId={projectId}
                  app={app}
                  onOpen={() => setOpenAppId(app.app_id)}
                />
              ))}
            </ul>
          ) : (
            <AppsEmptyState />
          )}
        </div>
      </div>

      {openApp ? (
        <AppDetailModal
          key={openApp.app_id}
          projectId={projectId}
          app={openApp}
          canWrite={canWrite}
          canDeploy={canDeploy}
          open
          onOpenChange={(next) => {
            if (!next) setOpenAppId(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Shape-matched placeholder: same grid, same 4:5 tile, same ONE-line caption
 * hanging below it as `AppCard`. Eight tiles — two full rows at the four
 * columns a desktop lands on, so the placeholder fills the page it stands in
 * for instead of trailing off half way down it.
 *
 * The second caption bar went when the card's hostname line did. A skeleton
 * taller than the thing it stands in for is a layout shift dressed as a
 * loading state.
 */
function AppGridSkeleton() {
  return (
    <ul className={cn('grid gap-x-4 gap-y-6', APP_GRID_COLUMNS)}>
      {Array.from({ length: 8 }).map((_, index) => (
        <li key={index}>
          <Skeleton className={cn(PREVIEW_TILE_ASPECT, 'w-full rounded-lg')} />
          <Skeleton className="mt-3 h-3.5 w-1/2 rounded-sm" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Nothing here yet — so hand over the exact command that changes that.
 *
 * The old empty state described the feature and stopped, which left the one
 * question it raises ("how do I get an App onto this page?") unanswered on the
 * one screen that has room to answer it. The command is copyable, not prose:
 * `kortix apps deploy .` run in a project directory is the whole path from
 * this screen to a card.
 */
function AppsEmptyState() {
  return (
    <EmptyState
      icon={GlobeIcon}
      title="No Apps yet"
      description="Deploy a static site, JavaScript bundle, Dockerfile, or OCI image from your project directory. It shows up here the moment it goes live."
      action={<DeployCommand code={FIRST_DEPLOY_COMMAND} />}
    />
  );
}

function AppCard({ projectId, app, onOpen }: { projectId: string; app: App; onOpen: () => void }) {
  // SESSION only, and only when the viewer may actually open this App. The
  // access POLICY is an administrative read that 403s for an ordinary member,
  // and the card never renders it — the detail modal asks. The SESSION 403s for
  // any App the viewer may see but not open, which is a state the server now
  // reports up front instead of leaving the card to discover it by failing.
  const canAccess = app.viewer_can_access !== false;
  const access = useAppAccess(projectId, app.app_id, { policy: false, session: canAccess });
  const status = appStatus(app);

  return (
    <li>
      {/* Still ONE control per card, and that is why there is no hover `⋯`
          menu on the tile: the whole card is the button, and a second button
          inside it is invalid HTML and a nested hit area. Every per-App action
          lives in the detail modal's header instead. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${app.name}`}
        className="group w-full text-left focus-visible:outline-none"
      >
        {/* The thumbnail is the ONLY bordered surface. The card used to be one
            panel with the text inside it under a divider, which framed the
            name and the host as card chrome; here they sit on the page like a
            caption under a picture, and the picture is the object. */}
        <div
          className={cn(
            'relative overflow-hidden rounded-lg border transition-transform duration-150 ease-out group-hover:-translate-y-1',
          )}
        >
          <AppPreview
            key={app.active_deployment_id ?? app.app_id}
            app={app}
            url={access.session.data?.url ?? null}
            accessError={!canAccess || access.session.isError}
            interactive={false}
          />
        </div>

        {/* The caption: the App's name and whether it is up. One line.
            No padding of its own — it is page text, not the inside of a panel.

            The hostname used to sit under the name in monospace. It is the
            same `<generated-key>.apps.<domain>` shape on every card, so a
            column of them is a column of near-identical strings that differ in
            a random token nobody reads or types — noise measured in a third of
            the caption's height, on the surface whose whole job is to show the
            App. The full URL is still one click away in the detail layer,
            beside the control that opens it, which is where someone who wants
            to copy it is already going. */}
        <div className="mt-3 flex items-center gap-2">
          <h3 className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
            {app.name}
          </h3>
          <Badge size="xs" variant={status.live ? 'success' : 'muted'} className="shrink-0">
            {status.label}
          </Badge>
        </div>
      </button>
    </li>
  );
}

/**
 * The App, full screen, with its controls above it.
 *
 * Opening an App used to mean a new browser tab, which left Kortix behind and
 * lost every control the moment you arrived. The App now runs in place and the
 * actions that used to crowd the card sit in one bar over the top of it.
 */
function AppDetailModal({
  projectId,
  app,
  canWrite,
  canDeploy,
  open,
  onOpenChange,
}: {
  projectId: string;
  app: App;
  canWrite: boolean;
  canDeploy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const apps = useProjectApps(projectId);
  const deployments = useAppDeployments(projectId, app.app_id);
  const canAccess = app.viewer_can_access !== false;
  const access = useAppAccess(projectId, app.app_id, { policy: canWrite, session: canAccess });
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const latest = deployments.data?.[0];
  const status = appStatus(app);
  const notice = deployNotice(latest);
  const running = app.desired_state === 'running';
  const busy = apps.start.isPending || apps.stop.isPending || apps.remove.isPending;
  const liveUrl = access.session.data?.url ?? app.url;

  const lifecycle = async (action: 'start' | 'stop') => {
    try {
      await (action === 'start'
        ? apps.start.mutateAsync(app.app_id)
        : apps.stop.mutateAsync(app.app_id));
      successToast(`${app.name} ${action === 'start' ? 'is ready' : 'suspended'}`);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : `Failed to ${action} App`);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        side="fullscreen"
        showCloseButton={false}
        // Radix focuses the first focusable descendant on open, which is an
        // action in the bar — and a focused icon button shows its Hint, so the
        // modal opened with a black tooltip sitting over its own controls.
        // Focus the dialog instead: the focus trap still holds, Tab still walks
        // into the bar, and nothing pops unbidden.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus?.();
        }}
        className="border-border bg-background! inset-0! h-dvh! max-h-none! min-h-dvh! w-auto! max-w-none! translate-x-0! translate-y-0! gap-0! space-y-0! overflow-hidden! rounded-none! border-0! focus:outline-none focus-visible:outline-none md:inset-4! md:h-auto! md:min-h-0! md:rounded-md! md:border!"
        aria-label={`${app.name} App`}
      >
        <div className="flex h-full min-h-0 flex-col">
          {/* Name, and what the name needs qualifying with — nothing else.
              This row carried five things: a dot, the name, the status word, a
              raw pipeline-stage badge, an access-mode badge, and the hostname
              in monospace underneath. Four of those are answers to questions
              nobody asked while looking at their own App, and together they
              read as a debug readout rather than a title bar.

              What each one became:
               - the status WORD now appears only when it is not "Running" —
                 the green dot already says the happy path, and a permanent
                 label restating it is the noisiest kind of quiet;
               - the pipeline stage became one plain badge, and only while
                 something is actually happening (`deployNotice`);
               - the access mode moved onto the control that changes it, where
                 it reads as a current value instead of a floating label;
               - the hostname moved into the Open button's tooltip. It is a
                 thing you act on, not a thing you read. */}
          <header className="flex shrink-0 items-center gap-3 border-b px-3 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', status.dot)} />
              <h2 className="text-foreground truncate text-sm font-medium">{app.name}</h2>
              {/* One announcement, either way. The dot is `aria-hidden`, so the
                  running case needs a screen-reader-only label — but rendering
                  it unconditionally alongside the visible one made every
                  non-running state read its status out twice. */}
              {status.live ? (
                <span className="sr-only">{status.label}</span>
              ) : (
                <span className="text-muted-foreground shrink-0 text-xs">{status.label}</span>
              )}
              {notice ? (
                <Badge size="xs" variant={notice.tone} className="shrink-0">
                  {notice.label}
                </Badge>
              ) : null}
            </div>

            {/* Two registers, and the gap is what separates them: the App's own
                actions on the left, the window's Close on the right. Close was
                the fifth button inside the group, which made "stop this App"
                and "shut this panel" look like peers of each other. It is
                `ghost` for the same reason — chrome, not an action. */}
            <div className="flex shrink-0 items-center gap-2">
              <ButtonGroup>
                {canDeploy ? (
                  <Hint
                    label={running ? 'Put this App to sleep' : 'Wake this App up'}
                    side="bottom"
                  >
                    <Button
                      size="icon"
                      variant="outline"
                      disabled={busy || !status.deployed}
                      aria-label={running ? 'Put this App to sleep' : 'Wake this App up'}
                      onClick={() => lifecycle(running ? 'stop' : 'start')}
                    >
                      {busy ? (
                        <Loading className="size-4 shrink-0" />
                      ) : running ? (
                        <PauseIcon weight="fill" className="size-4 shrink-0" />
                      ) : (
                        <PlayIcon className="size-4 shrink-0" />
                      )}
                    </Button>
                  </Hint>
                ) : null}
                <Hint label={`Open ${appHost(app.url)} in a new tab`} side="bottom">
                  <Button asChild size="icon" variant="outline">
                    <a
                      href={liveUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Open in a new tab"
                    >
                      <ArrowSquareOutIcon className="size-4 shrink-0" />
                    </a>
                  </Button>
                </Hint>
                {/* Everything rare or configural, behind one control. Three
                    icon buttons became one, and Delete came UP out of the
                    version drawer — a destructive action does not belong
                    hidden behind a history toggle, where you find it by
                    looking for something else. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="outline" aria-label="More actions">
                      <DotsThreeIcon className="size-4 shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60">
                    {canWrite ? (
                      <DropdownMenuItem onClick={() => setAccessOpen(true)}>
                        <LockKeyIcon className="size-3.5 shrink-0" />
                        Who can open this
                        {/* The current value, on the row that changes it. */}
                        <span className="text-muted-foreground ml-auto pl-3 text-xs">
                          {ACCESS_COPY[app.access_mode].label}
                        </span>
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem onClick={() => setVersionsOpen((value) => !value)}>
                      <ClockCounterClockwiseIcon className="size-3.5 shrink-0" />
                      {versionsOpen ? 'Hide earlier versions' : 'Earlier versions'}
                    </DropdownMenuItem>
                    {canWrite ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                          <TrashIcon className="size-3.5 shrink-0" />
                          Delete App
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </ButtonGroup>

              <Hint label="Close" side="bottom">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Close"
                  onClick={() => onOpenChange(false)}
                >
                  <XIcon className="size-4 shrink-0" />
                </Button>
              </Hint>
            </div>
          </header>

          <div className="relative min-h-0 flex-1">
            <AppPreview
              key={app.active_deployment_id ?? app.app_id}
              app={app}
              url={access.session.data?.url ?? null}
              accessError={!canAccess || access.session.isError}
              interactive
              className="absolute inset-0 size-full"
            />
          </div>

          {versionsOpen ? (
            <div className="bg-muted/20 max-h-[40vh] shrink-0 overflow-y-auto border-t px-4 py-3">
              {/* One thing, so no `justify-between` row to hold it. Delete used
                  to sit on the right of this line: a destructive action parked
                  inside a history panel, reachable only by opening something
                  else. It lives in the header's overflow menu now.

                  The command is spelled out rather than hidden behind a copy
                  glyph — it is the only way a new version gets here, and a bare
                  icon made the reader guess what it would put on their
                  clipboard. */}
              <div className="mb-2 flex items-center gap-3">
                <DeployCommand code={appCommand(app)} className="min-w-0" />
              </div>
              {deployments.isLoading ? (
                <Loading className="text-muted-foreground" />
              ) : deployments.data?.length ? (
                <div className="space-y-1">
                  {deployments.data.map((deployment) => (
                    <DeploymentRow
                      key={deployment.deployment_id}
                      deployment={deployment}
                      active={deployment.deployment_id === app.active_deployment_id}
                      canDeploy={canDeploy}
                      rollbackPending={deployments.rollback.isPending}
                      onRollback={async () => {
                        try {
                          await deployments.rollback.mutateAsync(deployment.deployment_id);
                          successToast(`Rolled back to version ${deployment.version}`);
                        } catch (error) {
                          errorToast(error instanceof Error ? error.message : 'Rollback failed');
                        }
                      }}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">No deployments yet.</p>
              )}
            </div>
          ) : null}
        </div>
      </ModalContent>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete App"
        description={`Delete ${app.name} and every runtime? This action cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        isPending={apps.remove.isPending}
        onConfirm={async () => {
          try {
            await apps.remove.mutateAsync(app.app_id);
            setDeleteOpen(false);
            // The App this modal is about no longer exists — close it, or the
            // frame keeps rendering a deleted App behind a dead action bar.
            onOpenChange(false);
            successToast(`${app.name} deleted`);
          } catch (error) {
            errorToast(error instanceof Error ? error.message : 'Failed to delete App');
          }
        }}
      />
      {accessOpen ? (
        <AppAccessModal
          projectId={projectId}
          app={app}
          access={access}
          open={accessOpen}
          onOpenChange={setAccessOpen}
        />
      ) : null}
    </Modal>
  );
}

function AppAccessModal({
  projectId,
  app,
  access,
  open,
  onOpenChange,
}: {
  projectId: string;
  app: App;
  access: ReturnType<typeof useAppAccess>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Modal open={open} onOpenChange={(value) => !access.update.isPending && onOpenChange(value)}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>App access</ModalTitle>
          <ModalDescription>
            Choose who can open {app.name}. Apps are private by default.
          </ModalDescription>
        </ModalHeader>
        {access.policy.isLoading ? (
          <ModalBody>
            <Skeleton className="h-48 w-full rounded-md" />
          </ModalBody>
        ) : access.policy.isError ? (
          <>
            <ModalBody>
              <ErrorState
                size="sm"
                title="Failed to load App access"
                description={(access.policy.error as Error).message}
                action={
                  <Button size="sm" variant="outline" onClick={() => access.policy.refetch()}>
                    Retry
                  </Button>
                }
              />
            </ModalBody>
            <ModalFooter>
              <Button variant="outline-ghost" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </ModalFooter>
          </>
        ) : access.policy.data ? (
          <AppAccessForm
            key={access.policy.data.revision}
            projectId={projectId}
            policy={access.policy.data}
            update={access.update}
            onSaved={() => onOpenChange(false)}
          />
        ) : null}
      </ModalContent>
    </Modal>
  );
}

function AppAccessForm({
  projectId,
  policy,
  update,
  onSaved,
}: {
  projectId: string;
  policy: AppAccessConfig;
  update: ReturnType<typeof useAppAccess>['update'];
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<AppAccessMode>(policy.mode);
  const [memberIds, setMemberIds] = useState<string[]>(policy.member_ids);
  const [groupIds, setGroupIds] = useState<string[]>(policy.group_ids);
  const [password, setPassword] = useState('');
  const incomplete = mode === 'restricted' && memberIds.length + groupIds.length === 0;
  const passwordMissing = mode === 'password' && !password && !policy.password_configured;

  const save = async () => {
    try {
      await update.mutateAsync({
        mode,
        ...(mode === 'restricted' ? { member_ids: memberIds, group_ids: groupIds } : {}),
        ...(mode === 'password' && password ? { password } : {}),
      });
      successToast('App access updated');
      onSaved();
    } catch (error) {
      errorToast(error instanceof Error ? error.message : 'Failed to update App access');
    }
  };

  return (
    <>
      <ModalBody className="max-h-[65vh] space-y-4 overflow-y-auto">
        <RadioGroup
          value={mode}
          onValueChange={(value) => setMode(value as AppAccessMode)}
          className="space-y-2"
        >
          {(Object.keys(ACCESS_COPY) as AppAccessMode[]).map((value) => (
            <ShareOption
              key={value}
              value={value}
              label={ACCESS_COPY[value].label}
              desc={ACCESS_COPY[value].desc}
            />
          ))}
        </RadioGroup>
        {mode === 'restricted' ? (
          <SubjectPicker
            projectId={projectId}
            memberIds={memberIds}
            groupIds={groupIds}
            onChange={(members, groups) => {
              setMemberIds(members);
              setGroupIds(groups);
            }}
          />
        ) : null}
        {mode === 'password' ? (
          <div className="space-y-2">
            <Label htmlFor="app-access-password">
              {policy.password_configured ? 'Replace password' : 'Password'}
            </Label>
            <Input
              id="app-access-password"
              type="password"
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              placeholder={
                policy.password_configured
                  ? 'Leave blank to keep the current password'
                  : 'At least 8 characters'
              }
            />
          </div>
        ) : null}
      </ModalBody>
      <ModalFooter className="sm:justify-between">
        <Button variant="outline-ghost" size="sm" onClick={onSaved} disabled={update.isPending}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={save}
          disabled={update.isPending || incomplete || passwordMissing}
        >
          {update.isPending ? <Loading className="size-4 shrink-0" /> : null}
          Save
        </Button>
      </ModalFooter>
    </>
  );
}

function DeploymentRow({
  deployment,
  active,
  canDeploy,
  rollbackPending,
  onRollback,
}: {
  deployment: AppDeployment;
  active: boolean;
  canDeploy: boolean;
  rollbackPending: boolean;
  onRollback: () => void;
}) {
  return (
    <div className="hover:bg-muted/40 flex items-center gap-3 rounded-md px-2 py-1.5">
      <span className="text-foreground w-8 shrink-0 font-mono text-xs tabular-nums">
        v{deployment.version}
      </span>
      {/* "Live" is the state of THIS version, so the active one says so and the
          rest report their own build outcome. Showing both — a `ready` badge
          and a separate "Live" word on the same row — said one thing twice. */}
      <Badge size="xs" variant={active ? 'success' : DEPLOYMENT_COPY[deployment.status].tone}>
        {active ? 'Live' : DEPLOYMENT_COPY[deployment.status].label}
      </Badge>
      {/* Age, not `hosting_provider`. That field is the name of the sandbox
          fleet the build landed on ("daytona", "platinum") — infrastructure
          this reader neither chose nor can change, printed where the one fact
          they actually want ("when was this?") was missing. */}
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        {relativeTime(deployment.created_at)}
      </span>
      {canDeploy && deployment.status === 'ready' && !active ? (
        <Button
          size="xs"
          variant="ghost"
          className="shrink-0"
          disabled={rollbackPending}
          onClick={onRollback}
        >
          {rollbackPending ? (
            <Loading className="size-3.5 shrink-0" />
          ) : (
            <ClockCounterClockwiseIcon className="size-3.5 shrink-0" />
          )}
          Restore
        </Button>
      ) : null}
    </div>
  );
}
