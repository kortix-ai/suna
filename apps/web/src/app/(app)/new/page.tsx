'use client';

import { Suspense } from 'react';

/**
 * Create a workspace.
 *
 * This page makes ZERO backend calls on mount. Visiting `/new` has no side
 * effects — the only request it ever issues is the one the submit button fires.
 * That is deliberate: the old `/projects?new=1` door could auto-provision, and a
 * page that creates something because you looked at it is a page nobody can
 * link to safely.
 *
 * Auth comes from the `(app)` route group; `/new` is on DESKTOP_ALLOWED_ROUTES
 * (middleware.ts) and deliberately absent from PUBLIC_ROUTES.
 */
export default function NewWorkspacePage() {
  return (
    <Suspense fallback={null}>
      <NewWorkspaceForm />
    </Suspense>
  );
}

function NewWorkspaceForm() {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center gap-6 px-6 py-16">
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-foreground text-xl font-semibold tracking-tight">
          Create a workspace
        </h1>
        <p className="text-muted-foreground text-sm text-balance">
          A workspace is where your agents, files and sessions live.
        </p>
      </header>
    </main>
  );
}
