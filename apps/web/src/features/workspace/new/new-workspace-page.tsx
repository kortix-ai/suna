'use client';

import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { ProjectIconField } from '@/features/projects/modal/project-icon-field';
import { useAuth } from '@/features/providers/auth-provider';
import { AdvancedFields } from '@/features/workspace/new/advanced-fields';
import {
  INITIAL_FORM_STATE,
  isSubmittable,
  type NewWorkspaceFormState,
} from '@/features/workspace/new/new-workspace-form';
import {
  WORKSPACE_NAME_MAX_LENGTH,
  validateWorkspaceName,
} from '@/features/workspace/new/workspace-name';

/**
 * Create a workspace.
 *
 * This page makes ZERO backend calls on mount. Visiting `/new` has no side
 * effects — the only request it ever issues is the one the submit button
 * fires, and that wiring lands in Task 13. A page that creates something
 * because you looked at it is a page nobody can link to safely.
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
  const [state, setState] = useState<NewWorkspaceFormState>(INITIAL_FORM_STATE);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Only surface a name error after the field has been left once. Validating
  // on the first keystroke would tell the user "Name is required" while they
  // are still typing the name.
  const nameError = useMemo(() => {
    if (!touched) return null;
    const result = validateWorkspaceName(state.name);
    return result.ok ? null : result.error;
  }, [state.name, touched]);

  // accounts wiring lands in Task 12 — there is no accounts query in this
  // task, so `1` stands in for "exactly one implicit account, nothing to
  // disambiguate". `isSubmittable` still refuses at count < 1.
  //
  // `state.source === 'managed'` is gated here, not in the shared
  // `isSubmittable`: `POST /provision` (the only wired submit path, landing in
  // Task 13) has no installation-id or repo fields, so a `github-create` /
  // `github-import` source can never be submittable through it. `AdvancedFields`
  // explains this inline and links to the real GitHub connect flow instead of
  // shipping a form that would 400.
  const canSubmit = isSubmittable(state, 1) && state.source === 'managed' && !submitting;

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

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (!canSubmit) return;
          setSubmitting(true);
          // Submit wiring lands in Task 13.
        }}
      >
        <div className="bg-popover flex flex-col gap-1.5 rounded-md border px-4 py-5">
          <Label htmlFor="workspace-name">Name</Label>
          {/* `items-start`, not `items-center`: the icon trigger and the input
              are both 9 units tall today, so it reads identically either way,
              and it stays correct if the input ever grows a second line
              beneath it (the create modal's own row uses the same rule). */}
          <div className="flex items-start gap-2">
            <ProjectIconField
              value={state.icon}
              onChange={(emoji) => setState((s) => ({ ...s, icon: { emoji } }))}
              onGlyphChange={(glyph) => setState((s) => ({ ...s, icon: { glyph } }))}
              disabled={submitting}
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
                disabled={submitting}
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

          <AdvancedFields state={state} onChange={setState} />
        </div>

        <Button type="submit" disabled={!canSubmit} className="w-full">
          {submitting ? <Loading className="size-4 shrink-0" /> : 'Create workspace'}
        </Button>
      </form>
    </main>
  );
}
