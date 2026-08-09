'use client';

import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';

import { readCloneParam } from '@/features/workspace/new/clone-param';
import { readOnboardingParam } from '@/features/workspace/new/onboarding-param';

import { ProjectOnboardingWizard } from '@/components/projects/project-onboarding-wizard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { GlobalUpgradeModal } from '@/features/billing/global-upgrade-modal';
import { ProjectIconField } from '@/features/projects/modal/project-icon-field';
import { useAuth } from '@/features/providers/auth-provider';
import { AccountPicker } from '@/features/workspace/new/account-picker';
import { AdvancedFields } from '@/features/workspace/new/advanced-fields';
import {
  INITIAL_FORM_STATE,
  filterCreatableAccounts,
  isSubmittable,
  resolveDefaultCreatableAccountId,
  type NewWorkspaceFormState,
} from '@/features/workspace/new/new-workspace-form';
import { ProvisionProgress } from '@/features/workspace/new/provision-progress';
import { useCreateWorkspace } from '@/features/workspace/new/use-create-workspace';
import {
  WORKSPACE_NAME_MAX_LENGTH,
  validateWorkspaceName,
} from '@/features/workspace/new/workspace-name';
import { isBillingEnabled } from '@/lib/config';
import { cn } from '@/lib/utils';
import { listAccounts } from '@kortix/sdk';

/**
 * The form <-> `ProvisionProgress` swap's ONLY transition — a plain opacity
 * cross-fade, no transform. "Nothing else moves" (task brief) is deliberate:
 * this page centers its column with `justify-center`, so the two states'
 * differing heights already reflow the header on swap; layering a slide or
 * scale on top of that reflow would read as two competing motions instead of
 * one. `mode="wait"` (not a true overlapping crossfade) because the form and
 * the panel are different heights — overlapping them mid-transition would
 * show both at once, at two different vertical rhythms. Same curve and
 * duration family as `session-starting-loader.tsx`'s `EASE_OUT`/`MESSAGE_IN`
 * — this codebase's other phase-swap surface — exit deliberately faster than
 * enter (~75%), matching the doctrine in `animations-dev`.
 */
const EASE_OUT: [number, number, number, number] = [0, 0, 0.2, 1];
const SWAP_IN = { duration: 0.2, ease: EASE_OUT };
const SWAP_OUT = { duration: 0.15, ease: EASE_OUT };

/**
 * The icon reveal: the tile is not on screen, then it is, and the name field
 * gives up the room for it.
 *
 * `ease-in-out`, NOT this file's `EASE_OUT`. Different job: `EASE_OUT` is for
 * something entering or leaving the screen, where the acceleration up front
 * reads as responsiveness. This is a RESIZE of a row already on screen — the
 * doctrine's "acceleration and deceleration of a car" case — and it wants a
 * curve that eases at both ends, or the row snaps to a stop.
 *
 * Width is the exception here, not the rule: the hard rule is transform and
 * opacity only, because layout properties re-layout every frame. It is
 * sanctioned when both ends are KNOWN rather than measured, which they are —
 * `0` and `size-14`'s `3.5rem`. There is no `auto` to measure and nothing to
 * reflow beyond this one row.
 *
 * Exit runs at ~77% of enter, per the same doctrine.
 */
const EASE_IN_OUT: [number, number, number, number] = [0.77, 0, 0.175, 1];
const ICON_REVEAL = { duration: 0.22, ease: EASE_IN_OUT };
const ICON_HIDE = { duration: 0.17, ease: EASE_IN_OUT };

/** `size-10`, as a width Motion can interpolate. Keep in step with the
 *  trigger's own `triggerClassName` below — they are the same box. */
const ICON_WIDTH = '2.5rem';

/**
 * Create a workspace.
 *
 * This page issues no MUTATING request on mount. Visiting `/new` never
 * creates anything — the only write it ever fires is the one the submit
 * button drives, routed through `useCreateWorkspace` (`use-create-workspace.ts`),
 * which POSTs `/projects/provision` with a stable `idempotency_key`. A page
 * that creates something because you looked at it is a page nobody can link
 * to safely.
 *
 * It DOES read the account list on mount (`useQuery(['accounts'],
 * listAccounts)`) — an idempotent GET, needed to know whether there is
 * anything to disambiguate (`AccountPicker`) and to gate submission on the
 * REAL account count instead of a placeholder. `['accounts']` is the exact
 * cache key `WorkspaceSwitcher` and `AccountSwitcher` already use, so a user
 * who reaches `/new` from either menu (the common path) hits a warm cache,
 * not a second request. That list is filtered to `creatableAccounts` (owner
 * or admin — `POST /provision` 403s on anything else, same predicate as
 * `create-account-selection.ts`) before it reaches either the picker or the
 * submit gate, so a user can never pick, or implicitly submit into, an
 * account that would fail.
 *
 * Layout: one centered column. The icon leads at `size-12` on its own line —
 * it is the only thing here you can express something with, and inline beside
 * the input it read as an adornment on the field rather than a choice. Then the
 * name, then the account, then Advanced, which stays hidden until the workspace
 * has a name: it is a second decision about a thing that does not exist yet.
 *
 * No bordered card. A single question does not need a surface to group it — the
 * border drew a box around one field on an otherwise empty page, which reads as
 * chrome rather than structure. The primary button is still a sibling below the
 * field group at full width, so the fields read as "the thing you fill in" and
 * the button as "the thing you press".
 *
 * There is no slug or URL field. `POST /provision` derives the repo slug as
 * `${baseSlug}-${projectId}` precisely so two workspaces can share a name —
 * there is no uniqueness constraint to validate against and no availability
 * check to run. This component holds no validation rules of its own; both the
 * charset/length check and the submit gate come from the shared form model.
 *
 * `/new` is also where `/projects` sends an account with zero workspaces
 * (Task 8), so a user must never be trapped here — the create-into account
 * picker (or email fallback) sits top-left and a `Log out` control sits
 * top-right, independent of the form below.
 */
export function NewWorkspacePage() {
  const { user, signOut } = useAuth();
  const searchParams = useSearchParams();
  const cloneItemId = readCloneParam(new URLSearchParams(searchParams?.toString() ?? ''));
  const router = useRouter();
  // Same `useSearchParams()` result the clone param reads — one subscription,
  // two params. Non-null only between "the workspace was created" and "the
  // user finished or skipped onboarding for it".
  const onboardingProjectId = readOnboardingParam(
    new URLSearchParams(searchParams?.toString() ?? ''),
  );

  const [state, setState] = useState<NewWorkspaceFormState>(() => ({
    ...INITIAL_FORM_STATE,
    templateId: cloneItemId,
  }));
  const [touched, setTouched] = useState(false);
  const reduceMotion = useReducedMotion();
  // One source for "is the icon column open" — the animation, the a11y
  // attributes and the inert gate all read the same value.
  const showIcon = state.name.trim().length > 0;
  const { create, status, error: createError, phase, retry, canRetry } = useCreateWorkspace();
  const submitting = status === 'creating';

  // Only surface a name error after the field has been left once. Validating
  // on the first keystroke would tell the user "Name is required" while they
  // are still typing the name.
  const nameError = useMemo(() => {
    if (!touched) return null;
    const result = validateWorkspaceName(state.name);
    return result.ok ? null : result.error;
  }, [state.name, touched]);

  // Same `['accounts']` cache entry `WorkspaceSwitcher`/`AccountSwitcher` read
  // — one shared query, not a page-local duplicate.
  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    staleTime: 60_000,
  });
  const accounts = accountsQuery.data ?? [];

  // `filterCreatableAccounts` (`new-workspace-form.ts`) matches
  // `create-account-selection.ts`'s predicate exactly, so the two never
  // disagree about who can create a workspace while both exist. Called ONCE
  // here; the result feeds both `AccountPicker` and `isSubmittable` below —
  // never the raw list to one and this to the other, which would let "what
  // the user can pick" and "what gates submit" disagree.
  const creatableAccounts = filterCreatableAccounts(accounts);

  // Pre-select the personal / email-matching account when the user has not
  // picked yet. Derived, not Effect-written — this page forbids useEffect
  // (no eager side effects on mount). `isSubmittable` and submit both read
  // the effective id so multi-account users are not blocked on "Choose an
  // account" when a clear default exists.
  const defaultAccountId = resolveDefaultCreatableAccountId(creatableAccounts, user?.email);
  const effectiveAccountId = state.accountId ?? defaultAccountId;
  const effectiveState: NewWorkspaceFormState = {
    ...state,
    accountId: effectiveAccountId,
  };

  // `accountsQuery.isLoading` is checked here AS WELL AS inside
  // `isSubmittable`'s own `accountCount < 1` floor. Belt and braces on
  // purpose, not redundant: during the loading window `creatableAccounts` is
  // `[]` for every user, no matter how many accounts they really have.
  // `isSubmittable`'s floor already blocks a submit at that `0` — so a
  // multi-account user could not slip through even without this line. What
  // this line adds is making the REASON legible at the call site: without it,
  // a reader sees the button disabled and has no way to tell "no creatable
  // accounts yet" apart from "accounts still loading". The bug this whole
  // gate exists to prevent — a multi-account user submitting with no
  // `account_id`, and the server silently defaulting the workspace into the
  // wrong account — is exactly what a stale reading of that count during the
  // loading window would let through.
  //
  // `state.source === 'managed'` is gated here, not in the shared
  // `isSubmittable`: `POST /provision` (the only wired submit path —
  // `useCreateWorkspace`) has no installation-id or repo fields, so a
  // `github-create` / `github-import` source can never be submittable through
  // it. `AdvancedFields` explains this inline and links to the real GitHub
  // connect flow instead of shipping a form that would 400.
  const canSubmit =
    isSubmittable(effectiveState, creatableAccounts.length) &&
    !accountsQuery.isLoading &&
    state.source === 'managed' &&
    !submitting;

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center gap-6 px-6 py-16">
      {/* No `relative` on <main> on purpose: with no positioned ancestor in
          this tree, `absolute` resolves against the initial containing block —
          the true viewport edges — rather than the right edge of the centered
          max-w-md column. `inset-x-0` + padding (not `w-full` + `right-*`) so
          the row spans the viewport without overflowing left. Sits ahead of
          the <form> so it stays reachable regardless of form state. */}
      <div className="absolute inset-x-0 top-3 z-10 flex items-center justify-between gap-3 px-4 sm:top-4 sm:px-6">
        {/* Create-into account lives here — not in the form body. One account
            collapses to muted identity text (email when none); two or more
            opens the Select on click. */}
        <AccountPicker
          accounts={creatableAccounts}
          value={effectiveAccountId}
          onChange={(accountId) => setState((s) => ({ ...s, accountId }))}
          fallbackLabel={user?.email}
          className="min-w-0"
        />
        {/* `text-muted-foreground hover:text-foreground` (not the bare `ghost`
            default) so this reads as one quiet secondary row at rest, same
            treatment as `(auth)/auth/phone-verification/page.tsx:223-227` —
            otherwise it sits at full-contrast `text-foreground` beside the
            identity's dim muted text and reads louder than the page's actual
            primary action. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground shrink-0"
          onClick={() => void signOut()}
        >
          Log out
        </Button>
      </div>

      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-foreground text-2xl font-semibold tracking-tight">
          Create a workspace
        </h1>
        <p className="text-muted-foreground text-[15px] text-balance">
          A workspace is where your agents, files and sessions live.
        </p>
      </header>

      {/* The onboarding param OWNS this page. `/new?onboarding=<id>` means the
          workspace already exists, so neither the create form nor
          `ProvisionProgress` has anything left to say — and on a reload the
          create hook restarts at `status: 'idle'`, which used to paint the live
          form (Name input, `autoFocus`, fully interactive) in the window before
          `getProjectDetail` settles. A user who reloaded mid-onboarding could
          type into it, and if `['accounts']` resolved first, Enter fired a
          SECOND `runCreate`.

          Inside the gate: the form <-> ProvisionProgress swap's ONE transition
          — see the `SWAP_IN`/`SWAP_OUT` doc comment above. `mode="wait"`, not a
          true overlap: the two states are different heights, so a moment with
          neither mounted reads better than both visible at once at two
          different rhythms. `initial={false}` — the form must not fade in on
          first paint, only on the swap back from the panel. */}
      {!onboardingProjectId && (
        <AnimatePresence mode="wait" initial={false}>
          {submitting ? (
            <m.div
              key="creating"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: SWAP_IN }}
              exit={{ opacity: 0, transition: SWAP_OUT }}
            >
              <ProvisionProgress workspaceName={state.name.trim()} current={phase} />
            </m.div>
          ) : (
            <m.div
              key="form"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: SWAP_IN }}
              exit={{ opacity: 0, transition: SWAP_OUT }}
            >
              <form
                className="flex flex-col space-y-8"
                onSubmit={(event) => {
                  event.preventDefault();
                  setTouched(true);
                  if (!canSubmit) return;
                  void create(effectiveState);
                }}
              >
                {state.templateId && (
                  <p className="text-muted-foreground text-center text-xs">
                    This workspace will be seeded from the template you picked.
                  </p>
                )}

                {/* No card. A single question does not need a bordered surface
                    to group it — the border was drawing a box around one field
                    on an otherwise empty page, which reads as chrome rather than
                    structure. */}
                <div className="flex flex-col space-y-4">
                  {/* Held back until the workspace has a name, for the same
                      reason Advanced is: an icon is a decision about a thing
                      that does not exist yet, and an empty page led by a smiley
                      asks you to decorate before it asks you to name.

                      Once named, the tile is never empty — it shows the initial
                      the workspace would carry anyway, drawn by `EntityAvatar`
                      exactly as the switcher rows and the project cards draw it.
                      So the default is a real default you can see and keep, not
                      a placeholder demanding to be filled. The caption says
                      "Change" rather than "Select" for the same reason: there is
                      already something there. */}
                  {/* One row: the icon, then the labelled name field.
                      `grid-cols-[auto_1fr]` rather than a flex row — the icon
                      takes exactly its own width and the field takes the rest,
                      with no flex-basis guessing. `items-end` bottom-aligns the
                      tile with the input rather than the label above it, so the
                      two controls sit on one baseline.

                      The tile is never blank: with a name it shows that
                      workspace's initial through `EntityAvatar` — the same
                      chalk-coloured tile the switcher rows and project cards
                      draw — so the default is a real default you can see and
                      keep rather than a placeholder demanding to be filled.
                      Before a name it falls back to the neutral face.

                      Hidden until the name exists, and it does not pop in — it
                      OPENS the column. Beside the input the tile owns a track,
                      so appearing instantly would jump the field sideways
                      mid-word, right where the cursor is. Animating the width
                      turns that jump into the row making room, which is what
                      actually happened.

                      No `gap` on the grid: a gap is there whether the column is
                      or not, so it would hold a hole open before the first
                      keystroke and make the reveal start from a ledge. The
                      spacing lives INSIDE the collapsing box as `pr-3`, which
                      border-box sizing clamps to nothing at `width: 0`. */}
                  <div
                    className={cn(
                      'grid grid-cols-[auto_1fr] items-end',
                      state.icon && 'gap-1.5',
                    )}
                  >
                    <m.div
                      // ONE element, always mounted, retargeting its width —
                      // NOT an AnimatePresence enter/exit. Mount/unmount
                      // restarts from zero, so backspacing to empty and typing
                      // again put a second tile in the same grid track while the
                      // first was still leaving: two boxes fighting over one
                      // column. `trim()` makes that easy to hit, since a single
                      // space flips it. A persistent element blends instead —
                      // interrupt it mid-collapse and it turns around from where
                      // it is, which is the whole reason the doctrine says
                      // transitions rather than enter/exit for anything
                      // retriggerable.
                      initial={false}
                      animate={
                        reduceMotion
                          ? { opacity: showIcon ? 1 : 0 }
                          : {
                              width: showIcon ? ICON_WIDTH : 0,
                              // Animated, not a static `pr-3`: border-box clamps
                              // CONTENT, not padding, so a fixed padding-right
                              // survives `width: 0` as a 12px stub holding the
                              // column open. This closes it completely.
                              paddingRight: showIcon ? '0.75rem' : 0,
                              opacity: showIcon ? 1 : 0,
                              filter: showIcon ? 'blur(0px)' : 'blur(2px)',
                            }
                      }
                      // Collapsing runs faster than opening, per the doctrine's
                      // ~75-80% rule: taking room back should not cost the user
                      // as long as giving it.
                      transition={showIcon ? ICON_REVEAL : ICON_HIDE}
                      // Collapsed, the box is still in the DOM at zero width.
                      // Without these it stays focusable and clickable — an
                      // invisible control the keyboard can land on.
                      aria-hidden={!showIcon}
                      inert={!showIcon ? true : undefined}
                      className="overflow-hidden"
                    >
                      <ProjectIconField
                        value={state.icon}
                        onChange={(emoji) => setState((s) => ({ ...s, icon: { emoji } }))}
                        onGlyphChange={(glyph) => setState((s) => ({ ...s, icon: { glyph } }))}
                        fallbackLabel={state.name}
                        triggerClassName="size-10"
                      />
                    </m.div>

                    {/* NO `col-span-2` when the name is empty. It looks like it
                        should reclaim the width, but the icon is still a grid
                        item needing track 1 — so spanning both tracks pushes it
                        onto a SECOND ROW, and the tile lands above the field
                        instead of beside it. That is what read as a broken exit
                        animation. Unnecessary as well as harmful: with the icon
                        track collapsed to nothing, `1fr` already takes the whole
                        row. */}
                    <div className="flex w-full min-w-0 flex-col space-y-3">
                      <Label htmlFor="workspace-name">Workspace name</Label>
                      <Input
                        id="workspace-name"
                        autoFocus
                        autoCapitalize="none"
                        autoCorrect="off"
                        value={state.name}
                        onChange={(event) => setState((s) => ({ ...s, name: event.target.value }))}
                        onBlur={() => setTouched(true)}
                        placeholder="Workspace name"
                        maxLength={WORKSPACE_NAME_MAX_LENGTH}
                        size="md"
                        className="w-full"
                        aria-invalid={nameError ? true : undefined}
                        aria-describedby={nameError ? 'workspace-name-error' : undefined}
                      />
                    </div>
                  </div>

                  {/* Below the grid, not inside the field's column: the message
                      is about the row as a whole and gets the full width rather
                      than wrapping inside the narrower right-hand track. */}
                  {nameError ? (
                    <p id="workspace-name-error" className="text-destructive text-xs">
                      {nameError}
                    </p>
                  ) : null}

                  {/* `isSubmittable`'s `accountCount < 1` floor already disables
                      the button here — this note is what stops that disabled
                      button from being unexplained. Gated on
                      `!accountsQuery.isLoading` so it cannot flash true during
                      the load window, when `creatableAccounts` is `[]` for
                      every user regardless of their real access. Plain muted
                      text in the field group's own flow, same treatment as
                      `AdvancedFields`' GitHub-source note — no `InfoBanner`, no
                      second card. Account picking itself lives in the top bar. */}
                  {!accountsQuery.isLoading && creatableAccounts.length === 0 ? (
                    <p className="text-muted-foreground text-xs">
                      You need owner or admin access in an account to create a workspace.
                    </p>
                  ) : null}

                  <AdvancedFields state={state} onChange={setState} />
                </div>

                <Button type="submit" size="lg" disabled={!canSubmit} className="w-full">
                  Create workspace
                </Button>
                {/* Form-level, not a field error: every failure `messageFor`
                    (`use-create-workspace.ts`) maps — 403 wrong-account, 400
                    bad name, a managed-git-unavailable 503, a retryable 502, or
                    a generic retry hint — is about the SUBMIT, not one input,
                    so it sits below the button rather than inside the card.
                    `role="alert"` announces it the moment `status` flips to
                    `'error'`, matching the a11y treatment already on the name
                    field.

                    The retry control is gated on `canRetry`
                    (`useCreateWorkspace`, derived from `isRetryableError`), not
                    just `status === 'error'`: the managed-git-unavailable 503
                    is a server configuration state, not a transient one, and
                    `retry` — which reuses the SAME idempotency key rather than
                    minting a new one — can never turn that into a success.
                    Offering it anyway would waste the user's time on a click
                    that cannot work. Styled to match the page's one other
                    secondary control (`Log out`, above) — `variant="ghost"
                    size="sm"` with the identical `text-muted-foreground
                    hover:text-foreground` treatment — rather than introducing a
                    third button weight beside the primary submit and that
                    one. */}
                {status === 'error' && createError ? (
                  <div role="alert" className="flex flex-col items-center gap-1.5">
                    <p className="text-destructive text-center text-xs">{createError}</p>
                    {canRetry ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={retry}
                      >
                        Try again
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </form>
            </m.div>
          )}
        </AnimatePresence>
      )}

      {/* The way into the workspace, always. The gate above means the page has
          no other content while the param is set, and the wizard is `null`
          until `getProjectDetail` settles — which, on an ERROR, it does: the
          wizard then renders rather than staying null (see `onboarding-param.ts`
          for why, and for why that is tolerable). So this link covers the
          in-flight window and a query that never settles at all, not a
          permanently-null wizard.
          The workspace has already been created and paid for, so a state with
          no route into it is not one this page is allowed to reach. This sits
          in normal flow rather than behind a readiness check because the wizard
          is a fullscreen portal: whenever it mounts, it covers this. */}
      {onboardingProjectId && (
        <div className="flex flex-col items-center gap-3">
          <Loading className="size-4" />
          <Link
            href={`/projects/${encodeURIComponent(onboardingProjectId)}`}
            className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4"
          >
            Go to workspace
          </Link>
        </div>
      )}

      {/* Onboarding runs HERE, not on the workspace page.

          BOTH exits stamp `metadata.onboarding_completed_at`, so the copy of
          this wizard mounted on the project shell self-gates to `completed` and
          renders nothing when we arrive. Skipping stamps too: this wizard has
          already warmed the SAME `qk.project.detail(id)` entry the shell reads,
          so an unstamped project meant the shell's copy — which has no skip
          control and cannot be dismissed — reopened the instant the user
          landed. Skipping was strictly worse than not skipping.

          `key` on the project: `index`, `domain` and the survey `answers` are
          plain `useState` inside the wizard, none keyed on the project, so a
          change of id on a mounted instance would PATCH workspace A's answers
          onto workspace B.

          `encodeURIComponent` on the way out mirrors `onboardingPath` on the
          way in — asymmetric encoding builds a broken URL for any id carrying a
          character that is not URL-safe. */}
      {onboardingProjectId && (
        <ProjectOnboardingWizard
          key={onboardingProjectId}
          projectId={onboardingProjectId}
          onCompleted={() => router.replace(`/projects/${encodeURIComponent(onboardingProjectId)}`)}
          onSkip={() => router.replace(`/projects/${encodeURIComponent(onboardingProjectId)}`)}
        />
      )}

      {/* The plan step's "See plans" option calls `openUpgrade()`, which needs a
          mounted `GlobalUpgradeModal` to answer it. The other hosts are
          `AppProviders` (mounted by `project-shell.tsx` and the share page,
          never by `app/(app)/layout.tsx`) and `accounts/[id]/page.tsx`, which
          mounts one bare — the precedent that this mount follows. Neither
          covers `/new`, so billing can be enabled here with no host at all and
          that option is a dead click. Same flag and
          same line as `app-providers.tsx:139`. */}
      {isBillingEnabled() && <GlobalUpgradeModal />}
    </main>
  );
}
