/**
 * Automations for the signed-out preview.
 *
 * Every row is a trigger that a real Kortix project template declares — the
 * name and the cron expression are copied out of the `triggers:` block of a
 * shipped `kortix.yaml`, and `manifest` records which one. demo-content.test.ts
 * opens each manifest and fails if a name or expression is not in it.
 *
 * The cadence text is NOT written here. It is produced at render time by
 * `describeCron` from features/workspace/automations/cron.ts — the same
 * function the real screen calls — so the demo says "Mondays at 09:00" for the
 * same reason the product does, and changes with it.
 */

export interface DemoAutomation {
  /** The trigger's `slug` in the manifest. Unique per row. */
  slug: string;
  /** The trigger's `name` in the manifest. */
  name: string;
  type: 'cron' | 'webhook';
  /** 6-field croner expression, verbatim from the manifest. Cron triggers only. */
  cron?: string;
  /** Repo-relative manifest this trigger is declared in. */
  manifest: string;
}

export const DEMO_AUTOMATIONS: readonly DemoAutomation[] = [
  {
    slug: 'memory-reflector',
    name: 'Memory reflector',
    type: 'cron',
    cron: '0 0 3 * * *',
    manifest: 'packages/starter/templates/base/kortix.yaml',
  },
  {
    slug: 'daily-repo-seo-sweep',
    name: 'Daily repo SEO sweep',
    type: 'cron',
    cron: '0 0 6 * * *',
    manifest: 'packages/starter/templates/marketplace-projects/seo-department/kortix.yaml',
  },
  {
    slug: 'daily-serp-watch',
    name: 'Daily SERP watch',
    type: 'cron',
    cron: '0 0 7 * * *',
    manifest: 'packages/starter/templates/marketplace-projects/seo-department/kortix.yaml',
  },
  {
    slug: 'weekly-campaign-planning',
    name: 'Weekly campaign planning',
    type: 'cron',
    cron: '0 0 9 * * 1',
    manifest: 'packages/starter/templates/marketplace-projects/marketing-department/kortix.yaml',
  },
  {
    slug: 'heartbeat',
    name: 'Studio heartbeat',
    type: 'cron',
    cron: '0 0 */4 * * *',
    manifest: 'packages/starter/templates/marketplace-projects/web-studio/kortix.yaml',
  },
  {
    slug: 'seo-request-intake',
    name: 'SEO request intake',
    type: 'webhook',
    manifest: 'packages/starter/templates/marketplace-projects/seo-department/kortix.yaml',
  },
  {
    slug: 'inbound-email',
    name: 'Inbound email',
    type: 'webhook',
    manifest: 'packages/starter/templates/marketplace-projects/web-studio/kortix.yaml',
  },
];

/**
 * The exact phrase the real Automations screen uses for a webhook trigger
 * (`cadenceOf` in automations-view.tsx). Kept as a constant so the contract
 * test can assert the two still agree.
 */
export const WEBHOOK_CADENCE = 'On webhook delivery';
