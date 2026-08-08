'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, m } from 'motion/react';

import { readCloneParam } from '@/features/workspace/new/clone-param';
import { readOnboardingParam } from '@/features/workspace/new/onboarding-param';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ProjectOnboardingWizard } from '@/components/projects/project-onboarding-wizard';
import { ProjectIconField } from '@/features/projects/modal/project-icon-field';
import { useAuth } from '@/features/providers/auth-provider';
import { AccountPicker } from '@/features/workspace/new/account-picker';
import { AdvancedFields } from '@/features/workspace/new/advanced-fields';
import {
  INITIAL_FORM_STATE,
  filterCreatableAccounts,
  isSubmittable,
  type NewWorkspaceFormState,
} from '@/features/workspace/new/new-workspace-form';
import { ProvisionProgress } from '@/features/workspace/new/provision-progress';
import { useCreateWorkspace } from '@/features/workspace/new/use-create-workspace';
import {
  WORKSPACE_NAME_MAX_LENGTH,
  validateWorkspaceName,
} from '@/features/workspace/new/workspace-name';
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
 * Layout is fixed by the spec: one centered column, fields in a single
 * bordered card, primary button OUTSIDE the card at card width. The button
 * sits outside so the card reads as "the thing you fill in" and the button as
 * "the thing you press" — two objects, not one panel with a footer.
 *
 * There is no slug or URL field. `POST /provision` derives the repo slug as
 * `${baseSlug}-${projectId}` precisely so two workspaces can share a name —
 * there is no uniqueness constraint to validate against and no availability
 * check to run. This component holds no validation rules of its own; both the
 * charset/length check and the submit gate come from the shared form model.
 *
 * `/new` is also where `/projects` sends an account with zero workspaces
 * (Task 8), so a user must never be trapped here — the signed-in email and a
 * `Log out` control sit top-right, independent of the form below.
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
    isSubmittable(state, creatableAccounts.length) &&
    !accountsQuery.isLoading &&
    state.source === 'managed' &&
    !submitting;

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center gap-6 px-6 py-16">
      {/* No `relative` on <main> on purpose: with no positioned ancestor in
          this tree, `absolute` resolves against the initial containing block —
          the true top-right of the page — rather than the right edge of the
          centered max-w-md column. Sits ahead of the <form> so it renders and
          stays reachable regardless of form state. */}
      <div className="absolute top-4 right-6 flex items-center gap-3">
        <span className="text-muted-foreground max-w-40 truncate text-xs">{user?.email}</span>
        {/* `text-muted-foreground hover:text-foreground` (not the bare `ghost`
            default) so this reads as one quiet secondary row at rest, same
            treatment as `(auth)/auth/phone-verification/page.tsx:223-227` —
            otherwise it sits at full-contrast `text-foreground` beside the
            email's dim `text-xs text-muted-foreground` and reads louder than
            the page's actual primary action. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => void signOut()}
        >
          Log out
        </Button>
      </div>

      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-foreground text-xl font-semibold tracking-tight">Create a workspace</h1>
        <p className="text-muted-foreground text-sm text-balance">
          A workspace is where your agents, files and sessions live.
        </p>
      </header>

      {/* The form <-> ProvisionProgress swap's ONE transition — see the
          `SWAP_IN`/`SWAP_OUT` doc comment above. `mode="wait"`, not a true
          overlap: the two states are different heights, so a moment with
          neither mounted reads better than both visible at once at two
          different rhythms. `initial={false}` — the form must not fade in on
          first paint, only on the swap back from the panel. */}
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
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                setTouched(true);
                if (!canSubmit) return;
                void create(state);
              }}
            >
              {state.templateId && (
                <p className="text-muted-foreground text-center text-xs">
                  This workspace will be seeded from the template you picked.
                </p>
              )}

              <div className="bg-popover flex flex-col gap-1.5 rounded-md border px-4 py-5">
                <Label htmlFor="workspace-name">Name</Label>
                {/* `items-start`, not `items-center`: the icon trigger and the
                    input are both 9 units tall today, so it reads identically
                    either way, and it stays correct if the input ever grows a
                    second line beneath it (the create modal's own row uses the
                    same rule). */}
                <div className="flex items-start gap-2">
                  <ProjectIconField
                    value={state.icon}
                    onChange={(emoji) => setState((s) => ({ ...s, icon: { emoji } }))}
                    onGlyphChange={(glyph) => setState((s) => ({ ...s, icon: { glyph } }))}
                  />
                  <div className="min-w-0 flex-1">
                    <Input
                      id="workspace-name"
                      autoFocus
                      autoCapitalize="none"
                      autoCorrect="off"
                      value={state.name}
                      onChange={(event) => setState((s) => ({ ...s, name: event.target.value }))}
                      onBlur={() => setTouched(true)}
                      placeholder="my-agi-company"
                      maxLength={WORKSPACE_NAME_MAX_LENGTH}
                      aria-invalid={nameError ? true : undefined}
                      aria-describedby={nameError ? 'workspace-name-error' : undefined}
                    />
                  </div>
                </div>
                {nameError ? (
                  <p id="workspace-name-error" className="text-destructive text-xs">
                    {nameError}
                  </p>
                ) : null}

                <AccountPicker
                  accounts={creatableAccounts}
                  value={state.accountId}
                  onChange={(accountId) => setState((s) => ({ ...s, accountId }))}
                />
                {/* `isSubmittable`'s `accountCount < 1` floor already disables
                    the button here — this note is what stops that disabled
                    button from being unexplained. Gated on
                    `!accountsQuery.isLoading` so it cannot flash true during
                    the load window, when `creatableAccounts` is `[]` for
                    every user regardless of their real access. Plain muted
                    text in the field group's own flow, same treatment as
                    `AdvancedFields`' GitHub-source note — no `InfoBanner`, no
                    second card. */}
                {!accountsQuery.isLoading && creatableAccounts.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    You need owner or admin access in an account to create a workspace.
                  </p>
                ) : null}

                <AdvancedFields state={state} onChange={setState} />
              </div>

              <Button type="submit" disabled={!canSubmit} className="w-full">
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

      {/* Onboarding runs HERE, not on the workspace page. The wizard is a
          fullscreen portal, so it covers the completed ProvisionProgress panel
          that stays mounted behind it (a successful create never clears
          `status`, by design).

          Completing stamps `metadata.onboarding_completed_at`, so the copy of
          this wizard mounted on the project shell self-gates to `completed`
          and renders nothing when we arrive. Skipping deliberately does NOT
          stamp — that shell copy then catches the user on a later visit, which
          is the whole safety net behind letting them skip at all. */}
      {onboardingProjectId && (
        <ProjectOnboardingWizard
          projectId={onboardingProjectId}
          onCompleted={() => router.replace(`/projects/${onboardingProjectId}`)}
          onSkip={() => router.replace(`/projects/${onboardingProjectId}`)}
        />
      )}
    </main>
  );
}
