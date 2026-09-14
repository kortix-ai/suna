'use client';

/**
 * The account hub's lazy boundary, and the one way to warm it.
 *
 * The hub pulls in every IAM pane plus the billing and branding tabs. None of
 * that belongs in the bundle of someone who never opens it, and none of it
 * should be fetched at click time either — `preloadAccountHub()` warms the
 * chunk on pointer or focus intent, which `HubLink` does on every row.
 *
 * Its own module so a call site can warm the chunk without importing the modal
 * itself, and so the modal and the links share one `import()` specifier —
 * which is what makes them one chunk.
 */

const importAccountHubBody = () => import('./account-hub-overlay-body');

export { importAccountHubBody };

/** Idempotent: the module registry dedupes, so call it freely. */
export function preloadAccountHub(): void {
  void importAccountHubBody();
}
