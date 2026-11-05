'use client';

/**
 * The account panes' lazy boundary, and the one way to warm it.
 *
 * The panes (Workspace settings › People, Billing, …) pull in every IAM pane
 * plus the billing and branding tabs. None of that belongs in the bundle of
 * someone who never opens them, and none of it should be fetched at click
 * time either — `preloadAccountHub()` warms the chunk on pointer or focus
 * intent, which `HubLink` does on every row.
 *
 * Its own module, free of the panes' imports, so a link can warm the chunk
 * without pulling them into its own graph. The host's `account-hub-router.tsx`
 * registers the one `import()` specifier here at module load.
 */

let importBody: (() => Promise<unknown>) | null = null;

/** Called once by the hub panel with its body import. */
export function setAccountHubImporter(load: () => Promise<unknown>): void {
  importBody = load;
}

/** Idempotent: the module registry dedupes, so call it freely. No-op before the panel loads. */
export function preloadAccountHub(): void {
  void importBody?.();
}
