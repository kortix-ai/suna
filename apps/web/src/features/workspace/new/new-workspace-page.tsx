'use client';

import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';

import { readOnboardingParam } from '@/features/workspace/new/onboarding-param';
import { readSourceParam } from '@/features/workspace/new/source-param';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';

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
  isForeignAccountList,
  isSubmittable,
  resolveDefaultCreatableAccountId,
  shouldShowAccountLine,
  type NewWorkspaceFormState,
} from '@/features/workspace/new/new-workspace-form';
import { useCreateWorkspace } from '@/features/workspace/new/use-create-workspace';
import { WorkspaceHandoff } from '@/features/workspace/new/workspace-handoff';
import {
  WORKSPACE_NAME_MAX_LENGTH,
  validateWorkspaceName,
} from '@/features/workspace/new/workspace-name';
import { useAccountsList } from '@/hooks/account/use-accounts-list';
import { performSignOut } from '@/lib/auth/perform-sign-out';
import { isBillingEnabled } from '@/lib/config';
import { cn } from '@/lib/utils';

/**
 * The form <-> `WorkspaceHandoff` swap's ONLY transition — a plain opacity
 * cross-fade, no transform. The two states are different heights and the page
 * centers its column, so the swap already reflows; a slide or scale on top of
 * that reads as two competing motions. `mode="wait"` for the same reason —
 * overlapping two blocks of different heights shows both at once at two
 * vertical rhythms.
 *
 * Kept short because this is the response to pressing Create — 300ms total,
 * exit at ~66% of enter. The handoff's own caption stagger runs inside this
 * fade, so a slower swap would swallow it.
 */
const EASE_OUT: [number, number, number, number] = [0, 0, 0.2, 1];
const SWAP_IN = { duration: 0.18, ease: EASE_OUT };
const SWAP_OUT = { duration: 0.12, ease: EASE_OUT };

/**
 * The icon reveal — the name field gives up room for a tile that was not there.
 *
 * `ease-in-out`, not this file's `EASE_OUT`: this is a RESIZE of a row already
 * on screen, and an ease-out snaps it to a stop. Animating `width` is the
 * sanctioned exception to transform-and-opacity-only — both ends are KNOWN
 * (`0` and `ICON_WIDTH`), so there is no `auto` to measure and nothing outside
 * this one row to reflow. Exit runs at ~77% of enter.
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
 * It DOES read the account list on mount (`useAccountsList()`) — an
 * idempotent GET, needed to know whether there is anything to disambiguate
 * (`AccountPicker`) and to gate submission on the REAL account count instead
 * of a placeholder. That hook is the exact
 * cache entry `WorkspaceSwitcher` and `AccountSwitcher` already use, so a user
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
  const { user, isLoading: authLoading } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();

  useSignedOutRedirect();

  // Same `useSearchParams()` result `readSourceParam` reads below — one
  // subscription, two params. Non-null only between "the workspace was
  // created" and "the user finished or skipped onboarding for it".
  const onboardingProjectId = readOnboardingParam(
    new URLSearchParams(searchParams?.toString() ?? ''),
  );

  // `?source=` is how the picked repository source survives the real
  // navigation to `/github/setup` and back (`readSourceParam`). Read into the
  // INITIAL state only — a lazy `useState` initializer, so a later param
  // change never fights the user's own Select.
  const initialSource = readSourceParam(new URLSearchParams(searchParams?.toString() ?? ''));

  const [state, setState] = useState<NewWorkspaceFormState>(() => ({
    ...INITIAL_FORM_STATE,
    ...(initialSource ? { source: initialSource } : {}),
  }));
  const [touched, setTouched] = useState(false);
  // Never cleared: the document is replaced, not re-rendered.
  const [signingOut, setSigningOut] = useState(false);
  const reduceMotion = useReducedMotion();
  // One source for "is the icon column open" — the animation, the a11y
  // attributes and the inert gate all read the same value.
  const showIcon = state.name.trim().length > 0;
  const { create, status, error: createError, retry, canRetry } = useCreateWorkspace();
  const submitting = status === 'creating';
  /**
   * The form is gone and `WorkspaceHandoff` holds the page.
   *
   * ONE flag over both waiting windows — the create being in flight, and the
   * project existing while the wizard is still `null` — because the user is in
   * one continuous wait across them and the screen should not change at the
   * seam. Deriving it here rather than testing both conditions at the JSX also
   * means the two can never drift into a state that renders neither branch.
   */
  const handingOff = submitting || Boolean(onboardingProjectId);

  // Only surface a name error after the field has been left once. Validating
  // on the first keystroke would tell the user "Name is required" while they
  // are still typing the name.
  const nameError = useMemo(() => {
    if (!touched) return null;
    const result = validateWorkspaceName(state.name);
    return result.ok ? null : result.error;
  }, [state.name, touched]);

  // Same user-scoped cache entry `WorkspaceSwitcher`/`AccountSwitcher` read —
  // one shared query, not a page-local duplicate. `useAccountsList` is also
  // what makes the stale-list instance of symptom 3 unreachable here: the key
  // carries the signed-in user, so a previous user's list is not addressable
  // from this page at all.
  const accountsQuery = useAccountsList();
  const accounts = accountsQuery.data ?? [];

  // `filterCreatableAccounts` (`new-workspace-form.ts`) matches
  // `create-account-selection.ts`'s predicate exactly, so the two never
  // disagree about who can create a workspace while both exist. Called ONCE
  // here; the result feeds both `AccountPicker` and `isSubmittable` below —
  // never the raw list to one and this to the other, which would let "what
  // the user can pick" and "what gates submit" disagree.
  const creatableAccounts = filterCreatableAccounts(accounts);

  // `user?.id` is `string | undefined`; the identity helpers below require an
  // explicit `string | null` — an omitted/undefined argument used to compile
  // clean and silently degrade to "cannot establish identity", which failed
  // closed for the wrong reason (an accident, not a decision, G4). Normalized
  // once here and reused for every identity-aware call on this page.
  const userId = user?.id ?? null;

  // A creatableAccounts list the signed-in user's identity cannot be
  // anchored to (Task 2, G2 fail-closed) — see `isForeignAccountList`'s own
  // doc comment for exactly which shape this is, why a SOLE foreign account
  // (the ordinary invited-admin case) is deliberately excluded, and why the
  // stale single-account instance of symptom 3 is closed by the user-scoped
  // `qk.accounts.list(userId)` key above rather than here. This check is
  // still live and still required: it covers a 2+-account list with no anchor
  // to the viewer, a shape the key cannot rule out.
  const foreignAccountList = isForeignAccountList(creatableAccounts, userId);

  // Whether `AccountPicker` should reveal any account-specific info beyond
  // bare identity (Task 2 controller addendum A2.2 / item 2). `AccountPicker`
  // always gets the REAL `creatableAccounts` below — never a shrunk stand-in
  // — so `accounts` keeps meaning "the accounts the user can create in" and
  // this flag is the sole, explicit place suppression is decided.
  const showAccountLine = shouldShowAccountLine(creatableAccounts, userId);

  // Pre-select the personal / identity-matching account when the user has not
  // picked yet. Derived, not Effect-written — the signed-out guard above is the
  // only Effect this page is allowed, and no Effect here may perform a WRITE.
  // `isSubmittable` and submit both read the effective id so multi-account users
  // are not blocked on "Choose an account" when a clear default exists. `null`
  // outright for a FOREIGN list — nothing in it can be trusted enough to
  // pre-fill or submit.
  const defaultAccountId = foreignAccountList
    ? null
    : resolveDefaultCreatableAccountId(creatableAccounts, userId);
  const effectiveAccountId = foreignAccountList ? null : (state.accountId ?? defaultAccountId);
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
  // The source-specific part of the gate lives in `isSubmittable`
  // (`githubSourceReady`), not here. It used to be a flat
  // `state.source === 'managed'` on this line, because `useCreateWorkspace`
  // only knew how to POST `/projects/provision` — so the two GitHub sources
  // were unreachable and their Select options were rendered `disabled`. Both
  // now have their own route (`/projects/create-repo`,
  // `/projects/link-repository`) and their own inputs, so what blocks submit
  // is a MISSING input, the same as an empty name — never the choice itself.
  const canSubmit =
    isSubmittable(effectiveState, creatableAccounts.length) &&
    !accountsQuery.isLoading &&
    !submitting &&
    // Belt and braces on top of `effectiveAccountId` already being forced
    // null above for a FOREIGN list — `isSubmittable`'s own
    // `accountCount > 1 && !accountId` check already fails on that null, but
    // naming the condition here directly means a future edit to either
    // function cannot silently reopen the disclosure by accident.
    !foreignAccountList;

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
          showAccountLine={showAccountLine}
          className="min-w-0"
        />
        {/* `text-muted-foreground hover:text-foreground` (not the bare `ghost`
            default) so this reads as one quiet secondary row at rest, same
            treatment as `(auth)/auth/phone-verification/page.tsx:223-227` —
            otherwise it sits at full-contrast `text-foreground` beside the
            identity's dim muted text and reads louder than the page's actual
            primary action.

            `performSignOut`, not the old bare `void signOut()`: that neither
            awaited the sign-out nor navigated, so pressing Log out here signed
            the user out and left them sitting on the create form. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground shrink-0"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            void performSignOut();
          }}
        >
          {signingOut ? <Loading className="size-4 shrink-0" /> : null}
          {signingOut ? 'Signing out' : 'Log out'}
        </Button>
      </div>

      {/* TWO states, one swap — see the `SWAP_IN`/`SWAP_OUT` doc comment above.
          `initial={false}` so neither side fades in on first paint.

          `handingOff` deliberately folds the onboarding param in with
          `submitting` rather than gating the whole block on it separately. The
          param OWNS this page: `/new?onboarding=<id>` means the workspace
          already exists, so the create form has nothing left to say — and on a
          RELOAD the create hook restarts at `status: 'idle'`, so `submitting`
          alone would paint the live form (Name input, `autoFocus`, fully
          interactive) in the window before `getProjectDetail` settles. A user
          who reloaded mid-onboarding could type into it, and if the account
          list resolved first, Enter fired a SECOND `runCreate`.

          The header lives INSIDE the form branch, not above the swap. It is
          the form's title — "Create a workspace" above a screen that is already
          creating one is stale, and leaving it mounted would make the swap two
          motions (a block fading while a heading holds still) instead of the
          page turning over as one thing. */}
      <AnimatePresence mode="wait" initial={false}>
        {handingOff ? (
          <m.div
            key="handoff"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: SWAP_IN }}
            exit={{ opacity: 0, transition: SWAP_OUT }}
          >
            {/* `state.name` survives the whole handoff — this component is a
                sibling of the form in the same render, not a route away — so
                the name shown is the one submitted, never re-fetched. */}
            <WorkspaceHandoff workspaceName={state.name.trim()} projectId={onboardingProjectId} />
          </m.div>
        ) : (
          <m.div
            key="form"
            className="flex flex-col gap-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: SWAP_IN }}
            exit={{ opacity: 0, transition: SWAP_OUT }}
          >
            <header className="flex flex-col gap-2 text-center">
              <h1 className="text-foreground text-2xl font-semibold tracking-tight">
                Create a workspace
              </h1>
              <p className="text-muted-foreground text-[15px] text-balance">
                A workspace is where your agents, files and sessions live.
              </p>
            </header>

            <form
              className="flex flex-col space-y-8"
              onSubmit={(event) => {
                event.preventDefault();
                setTouched(true);
                if (!canSubmit) return;
                void create(effectiveState);
              }}
            >
              {/* No card. A single question does not need a bordered surface
                    to group it — the border was drawing a box around one field
                    on an otherwise empty page, which reads as chrome rather than
                    structure. */}
              <div className="flex flex-col space-y-4">
                {/* One row: the icon, then the labelled name field.
                      `grid-cols-[auto_1fr]` rather than a flex row — the icon
                      takes exactly its own width and the field takes the rest,
                      with no flex-basis guessing. `items-end` bottom-aligns the
                      tile with the input rather than the label above it.

                      The icon is held back until the workspace has a name, for
                      the same reason Advanced is: it is a decision about a thing
                      that does not exist yet, and an empty page led by a smiley
                      asks you to decorate before it asks you to name. Once
                      named the tile is never blank — it shows the initial the
                      workspace would carry anyway, through `EntityAvatar`, the
                      same chalk tile the switcher rows and project cards draw.
                      So the default is a real default you can see and keep.

                      No `gap` while the column can still be closed: a gap is
                      there whether the icon is or not, so it would hold a hole
                      open before the first keystroke and make the reveal start
                      from a ledge. The spacing lives INSIDE the collapsing box
                      as an animated `paddingRight`. Once an icon is PICKED the
                      column is open for good and the tile is tinted, so the
                      extra `gap-1.5` is safe and keeps the fill off the input. */}
                <div className={cn('grid grid-cols-[auto_1fr] items-end', state.icon && 'gap-2')}>
                  <m.div
                    // ONE element, always mounted, retargeting its width —
                    // NOT an AnimatePresence enter/exit. Mount/unmount
                    // restarts from zero, so backspacing to empty and typing
                    // again (one space flips `trim()`) put a second tile in
                    // the grid track while the first was still leaving. A
                    // persistent element blends instead: interrupt it
                    // mid-collapse and it turns around from where it is.
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
                    transition={showIcon ? ICON_REVEAL : ICON_HIDE}
                    // Collapsed, the box is still in the DOM at zero width —
                    // without these it stays focusable and clickable.
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

                {/* The `isForeignAccountList` case (`new-workspace-form.ts`) —
                      2+ creatable accounts, none of them this user's own. Its
                      only reachable trigger today is a LEGITIMATE user with no
                      personal account (SAML JIT or a direct invite acceptance
                      that bypassed the personal-account bootstrap gate), not a
                      caching defect — see that function's own doc comment. Before
                      this note the page went silent here: no picker (the top
                      bar collapses to bare identity text), no "Create in" line,
                      and a permanently disabled submit with nothing explaining
                      why. Same treatment as the sibling message above —
                      gated on `!accountsQuery.isLoading` for the same reason. */}
                {!accountsQuery.isLoading && foreignAccountList ? (
                  <p className="text-muted-foreground text-xs">
                    We can't tell which of your accounts is yours, so we're not guessing. Email{' '}
                    <a
                      href="mailto:support@kortix.ai"
                      className="text-foreground underline underline-offset-2"
                    >
                      support@kortix.ai
                    </a>{' '}
                    and we'll get it fixed.
                  </p>
                ) : null}

                {/* `effectiveAccountId`, not `state.accountId`: the GitHub
                      queries inside are account-scoped, and `state.accountId`
                      is legitimately null for a single-account user (the
                      picker hides itself below two accounts). Passing the raw
                      value would leave those queries permanently disabled for
                      exactly the users who have nothing to pick. */}
                <AdvancedFields state={state} accountId={effectiveAccountId} onChange={setState} />
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

      {/* Onboarding runs HERE, not on the workspace page. It is a fullscreen
          portal, so whenever it mounts it covers the handoff above — which is
          exactly why the handoff has no "finished" state of its own to render.

          `key` on the project: `index`, `domain` and the survey `answers` are
          plain `useState` inside the wizard, none keyed on the project, so a
          change of id on a mounted instance would PATCH workspace A's answers
          onto workspace B. */}
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
