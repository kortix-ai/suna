'use client';

import { readAccountParam } from '@kortix/ui/workspace/new/account-param';
import { readCloneParam } from '@kortix/ui/workspace/new/clone-param';
import { readSourceParam } from '@kortix/ui/workspace/new/source-param';
import { useTranslations } from '@/i18n/use-translations';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { DesktopCloseButton } from '@/components/desktop/desktop-close-button';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import { ProjectIconField } from '@kortix/ui/workspace/projects/modal/project-icon-field';
import { useAuth } from '@/features/providers/auth-provider';
import { AccountTopBar } from '@/features/workspace/account-top-bar';
import { AdvancedFields } from '@kortix/ui/workspace/new/advanced-fields';
import {
  INITIAL_FORM_STATE,
  isSubmittable,
  type NewWorkspaceFormState,
} from '@kortix/ui/workspace/new/new-workspace-form';
import { useCreateWorkspace } from '@kortix/ui/workspace/new/use-create-workspace';
import { WorkspaceHandoff } from '@kortix/ui/workspace/new/workspace-handoff';
import {
  WORKSPACE_NAME_MAX_LENGTH,
  suggestWorkspaceName,
  validateWorkspaceName,
} from '@kortix/ui/workspace/new/workspace-name';
import { useWorkspaceDirectory } from '@kortix/ui/workspace/sidebar/use-workspace-directory';
import { canCreateWorkspace } from '@kortix/ui/workspace/project-selector/project-selector-model';
import { useAdminRole } from '@kortix/ui/internal/hooks/admin/use-admin-role';
import { performSignOut } from '@/lib/auth/perform-sign-out';
import { isAccountCreationRestricted, isBillingEnabled } from '@/lib/config';
import { sanitizeAuthReturnUrl } from '@/lib/auth/return-url';
import { cn } from '@kortix/ui';

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

/**
 * The icon column's open width: the `size-10` tile PLUS the gap after it.
 * Border-box clamps content, not padding, so the animated `paddingRight`
 * (`ICON_GAP`) is carved out of this width — at the old `2.5rem` a wider gap
 * only clipped the tile. `size-10` is `10 × --spacing` (0.23rem) = 2.3rem.
 * Keep in step with the trigger's own `triggerClassName` below.
 */
const ICON_GAP = '0.5rem';
/** Tile + gap: 2.3rem + `ICON_GAP`. Change the two together. */
const ICON_WIDTH = '2.8rem';

/**
 * Create a workspace.
 *
 * ONE form: the name, the icon, and Advanced (the repository source). No
 * account picker: a workspace is one account and its project (Workspaces
 * D3), so Create makes the whole workspace, and the server always makes its
 * new account. The managed source sends `new_workspace: true`. The GitHub
 * sources name the account whose GitHub connection they use
 * (`githubSourceAccount`: a workspace the caller owns or administers), because
 * installations are account-scoped; the server creates the new workspace with
 * a grant for the one repository. With no such workspace Advanced offers the
 * managed source only, and GitHub connects later in Workspace settings › Git.
 *
 * This page issues no MUTATING request on mount. The only write is the one
 * the submit button drives, through `useCreateWorkspace`, with a stable
 * `idempotency_key`. It reads the workspace directory (the same queries the
 * chooser and the switcher read) for the source account.
 *
 * Self-host with account creation restricted (`KORTIX_RESTRICT_ACCOUNT_CREATION`)
 * lets only a platform admin create; the form says to ask an admin for an
 * invite.
 *
 * Layout: one centered column, no card. A user must never be trapped here:
 * the web row links back to `/workspaces`, the desktop shell shows its close
 * button, and Log out stays in the account menu.
 */
export function NewWorkspacePage() {
  const t = useTranslations('newWorkspace');
  const tWorkspaces = useTranslations('workspaces.create');
  const { user, isLoading: authLoading } = useAuth();
  const searchParams = useSearchParams();
  const cloneItemId = readCloneParam(new URLSearchParams(searchParams?.toString() ?? ''));
  const router = useRouter();
  const connectComputer = searchParams?.get('connect') === 'computer';
  // `?returnUrl=` sends the person back where a workspace was missing (the
  // CLI sign-in page) once it exists. Same-origin paths only
  // (`sanitizeAuthReturnUrl`); anything else falls back to the workspace.
  const rawReturnUrl = searchParams?.get('returnUrl');
  const returnUrl = rawReturnUrl ? sanitizeAuthReturnUrl(rawReturnUrl, '') : '';

  useSignedOutRedirect();

  // `?source=` is how the picked repository source survives the real
  // navigation to `/github/setup` and back (`readSourceParam`). Read into the
  // INITIAL state only — a lazy `useState` initializer, so a later param
  // change never fights the user's own Select.
  const initialSource = readSourceParam(new URLSearchParams(searchParams?.toString() ?? ''));

  // `?account=` survives the round trip to `/github/setup` (`readAccountParam`).
  // It only ever names the GitHub source account; any other id is ignored
  // below (`effectiveAccountId`).
  const returnedAccountId = readAccountParam(new URLSearchParams(searchParams?.toString() ?? ''));

  const [state, setState] = useState<NewWorkspaceFormState>(() => ({
    ...INITIAL_FORM_STATE,
    templateId: cloneItemId,
    ...(initialSource ? { source: initialSource } : {}),
  }));
  const [touched, setTouched] = useState(false);
  // Seed a friendly default name once, after mount — not in the `useState`
  // initializer, because a random value there differs between the server
  // render and the client's first render (a hydration mismatch). A name the
  // user already has (typed, or restored) is never replaced.
  useEffect(() => {
    setState((current) => (current.name ? current : { ...current, name: suggestWorkspaceName() }));
  }, []);
  // Never cleared: the document is replaced, not re-rendered.
  const [signingOut, setSigningOut] = useState(false);
  const reduceMotion = useReducedMotion();
  // One source for "is the icon column open" — the animation, the a11y
  // attributes and the inert gate all read the same value.
  const showIcon = state.name.trim().length > 0;
  const {
    create,
    status,
    error: createError,
    retry,
    canRetry,
    phase,
  } = useCreateWorkspace({
    enterProject: returnUrl
      ? () => router.replace(returnUrl)
      : connectComputer
        ? (projectId) => router.replace(`/workspaces/${encodeURIComponent(projectId)}/settings/computer`)
        : undefined,
  });
  const submitting = status === 'creating';

  // The too-long message fires LIVE, before the field is ever left: the input
  // no longer truncates typed or pasted names at the limit (there is no
  // `maxLength` — the browser used to clip silently at 120, which made this
  // message and the submit gate both unreachable for typing). The remaining
  // name errors wait for the field to be left once: validating on the first
  // keystroke would tell the user "Name is required" while they are still
  // typing the name.
  const nameError = useMemo(() => {
    const result = validateWorkspaceName(state.name);
    if (!result.ok && result.error.startsWith('Name must be')) {
      return t('validation.nameTooLong', { max: WORKSPACE_NAME_MAX_LENGTH });
    }
    if (!touched) return null;
    if (result.ok) return null;
    if (result.error === 'Name is required') return t('validation.nameRequired');
    return t('validation.nameCharacters');
  }, [state.name, t, touched]);

  // The account whose GitHub connection the GitHub sources use, if any
  // (`AdvancedFields`). The managed source names no account.
  const directory = useWorkspaceDirectory();
  const sourceAccountId = directory.githubSourceAccount?.account_id ?? null;
  const effectiveAccountId =
    returnedAccountId && returnedAccountId !== sourceAccountId ? null : sourceAccountId;
  const effectiveState: NewWorkspaceFormState = { ...state, accountId: effectiveAccountId };

  const { data: adminRole } = useAdminRole();
  const restrictedOut = !canCreateWorkspace({
    restricted: isAccountCreationRestricted(),
    isPlatformAdmin: Boolean(adminRole?.isAdmin),
  });

  // What blocks submit is a missing input (`isSubmittable`), the directory
  // still loading, an in-flight create, or a restricted instance. There is no
  // plan cap to pre-check: every create makes a new workspace.
  const canSubmit =
    isSubmittable(effectiveState) &&
    !directory.loading &&
    !submitting &&
    !restrictedOut;

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center gap-6 px-6 py-16">
      {/* No `relative` on <main> on purpose: with no positioned ancestor in
          this tree, the bar's `absolute` resolves against the initial
          containing block — the true viewport edges — rather than the centered
          max-w-md column. Sits ahead of the <form> so it stays reachable
          regardless of form state. `performSignOut`, not a bare `signOut()`:
          that neither awaited nor navigated, and left the user on the form. */}
      <AccountTopBar
        email={user?.email ?? null}
        name={user?.user_metadata?.name}
        signingOut={signingOut}
        onLogOut={() => {
          setSigningOut(true);
          void performSignOut();
        }}
        back={{ href: '/workspaces', label: t('actions.back') }}
        // Desktop only. The shell has no browser toolbar, so without this the
        // account menu was the only way off this page there. `replace`, not
        // `push`: `/workspaces/new` is where the user left, not somewhere to return to.
        trailing={<DesktopCloseButton onClose={() => router.replace('/workspaces')} />}
      />

      {/* TWO states, one swap — see the `SWAP_IN`/`SWAP_OUT` doc comment above.
          `initial={false}` so neither side fades in on first paint.

          The swap runs only while the create is in flight — the handoff holds
          the page from the click until the provision finishes; on success the
          orchestration navigates to `/workspaces/<id>` (KRTX-1419), so there is
          no post-create window on this page for the form to reappear in.

          The header lives INSIDE the form branch, not above the swap. It is
          the form's title — "Create a workspace" above a screen that is already
          creating one is stale, and leaving it mounted would make the swap two
          motions (a block fading while a heading holds still) instead of the
          page turning over as one thing. */}
      <AnimatePresence mode="wait" initial={false}>
        {submitting ? (
          <m.div
            key="handoff"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: SWAP_IN }}
            exit={{ opacity: 0, transition: SWAP_OUT }}
          >
            {/* `state.name` is the form's own state, so the name shown is the
                one submitted. `phase` is the latest streamed provisioning
                phase (KRTX-1543): the managed create reports its steps over
                `/projects/provision-stream` and the handoff renders them;
                `null` (GitHub sources, fallback) renders the base screen. */}
            <WorkspaceHandoff workspaceName={state.name.trim()} phase={phase} />
          </m.div>
        ) : (
          <m.div
            key="form"
            className="flex flex-col gap-10"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: SWAP_IN }}
            exit={{ opacity: 0, transition: SWAP_OUT }}
          >
            <header className="flex flex-col gap-2 text-center">
              <h1 className="text-foreground text-2xl font-medium tracking-tight">
                {tWorkspaces('title')}
              </h1>
              <p className="text-muted-foreground text-sm text-balance">{tWorkspaces('description')}</p>
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
              {state.templateId && (
                <p className="text-muted-foreground text-center text-xs">{t('templateSeed')}</p>
              )}

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
                <div className={cn('grid grid-cols-[auto_1fr] items-end', state.icon && 'gap-0')}>
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
                            paddingRight: showIcon ? ICON_GAP : 0,
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
                    <Label htmlFor="workspace-name">{t('name.label')}</Label>
                    <Input
                      id="workspace-name"
                      autoFocus
                      autoCapitalize="none"
                      autoCorrect="off"
                      value={state.name}
                      onChange={(event) => setState((s) => ({ ...s, name: event.target.value }))}
                      onBlur={() => setTouched(true)}
                      placeholder={t('name.placeholder')}
                      // No `maxLength`: the browser would clip typed and pasted
                      // names at the limit with no message, and the validation
                      // below would stay unreachable. The limit is enforced by
                      // `isSubmittable` (shared form model) + the live message.
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

                {/* The free-credit rule, before the create (finding 10): one
                    grant per person, on their first workspace. */}
                {isBillingEnabled() ? (
                  <p className="text-muted-foreground text-xs" data-testid="create-free-credits-rule">
                    {tWorkspaces('freeCreditsRule')}
                  </p>
                ) : null}

                {!directory.loading && restrictedOut ? (
                  <p className="text-muted-foreground text-xs">
                    {tWorkspaces('restricted', { email: user?.email ?? '' })}
                  </p>
                ) : null}

                {/* `effectiveAccountId`: the GitHub source account. Null hides
                    the GitHub sources (their installations are account-scoped);
                    managed needs no account. */}
                <AdvancedFields
                  connectComputer={connectComputer}
                  state={state}
                  accountId={effectiveAccountId}
                  onChange={setState}
                />
              </div>

              <Button type="submit" size="lg" disabled={!canSubmit} className="w-full">
                {tWorkspaces('submit')}
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
                      {t('actions.tryAgain')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </form>
          </m.div>
        )}
      </AnimatePresence>

    </main>
  );
}
