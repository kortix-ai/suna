/**
 * Home-page "open source" section copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `comms` skill.
 *
 * WHAT THIS SECTION IS. Two things and nothing else: the live star count, and
 * the reason the code is open at all. The number on its own is a vanity metric;
 * the reason is what earns it the slot between the security close and the
 * questions under it. Everything that was neither of those has been cut.
 *
 * WHERE THE REASON COMES FROM. `title` is the `/about` thesis, taken from
 * `marketing/about/content.ts` → `hero.title` plus the first clause of
 * `hero.lead`, because that page is already accuracy-reviewed and the home page
 * must not invent a second version of it. `aboutHref` sends a reader there for
 * the rest — the enumeration ("every agent, all of their data, every skill,
 * every connector, the memory, the whole configuration") stays on `/about`
 * rather than being restated here. Do not widen the claim past what `/about`
 * says.
 *
 * WHAT WAS CUT, AND WHY IT IS NOT LOST. A lifted `bg-card` slab, a headline, a
 * two-command self-host terminal, a four-row self-hosting ledger and a centred
 * closing line — 1014px of it — came out on 2026-07-31, then a three-job body
 * paragraph and a mono fact line went with them. The two commands are still on
 * the page in the hero's CLI panel; the self-hosting ledger reads better on
 * `/self-hosted`; and the fact line ("Developed in the / Self-host or
 * managed cloud / Any model, your keys") only restated the paragraph above it.
 *
 * ACCURACY GATE for this section specifically. Every item is still binding on
 * whatever this file grows back into:
 *  1. NEVER name a licence. "open source" and stop — no badge, no Apache/MIT/
 *     Elastic. (`comms` §7, "On the license".)
 *  2. ONE superlative form is sanctioned: "the leading closed-source
 *     alternative" (`comms` §7, decided 2026-07-31). The hero already carries
 *     it (`marketing/landing/content.ts` → `heroEyebrow.lead`), so this
 *     section does not repeat it. No other superlative — "the go-to", "#1",
 *     "the best" — is allowed, and the sanctioned one is never extended.
 *  3. The star count is READ LIVE from `/api/github-stars` via
 *     `useGitHubStars`. Nothing here hardcodes it, and no other repo metric
 *     (forks, contributors, downloads) is claimed — none is read.
 *  4. "Air-gapped" is NOT what `kortix self-host start` gives you: it pulls
 *     images from docker.io and reaches a sandbox provider over egress. This
 *     section now makes no self-hosting claim at all; if one comes back, it
 *     stops at "hardware you control" and is never upgraded to "offline",
 *     "disconnected" or "air-gapped". Isolated topologies are scoped through
 *     `/enterprise`, which `/self-hosted` routes to.
 *  5. Do not claim "egress controlled at the network" — nothing implements it.
 *  6. Do not claim blanket "microVM isolation" — true for Platinum, not for
 *     Daytona, which is the default. This section names no isolation boundary.
 *  7. Any CLI command put back here must be a shipped one. The two that used to
 *     sit in this file were `kortix self-host start`
 *     (`apps/cli/src/commands/self-host.ts`) and `kortix hosts use <host>`
 *     (`apps/cli/src/commands/hosts.ts:240`, which prints the exact string
 *     "Active host is now <host>"). This section now shows neither.
 *  8. Do NOT claim you can fork someone else's company / project, or publish
 *     your own. The `registry:project` machinery ships, but the catalog holds
 *     exactly one project item — dosco's own starter
 *     (`apps/api/src/marketplace/catalog.ts:487` `buildStarterKitProjectItem`;
 *     `packages/starter/src/index.test.ts:459` pins the template list to `[]`),
 *     and there is no publish route at all
 *     (`apps/api/src/marketplace/index.ts` is read-only + admin source
 *     registration). This section makes neither claim.
 *  9. Do NOT write that secrets are invisible to the model. A granted runtime
 *     secret is a real env value any command in the session can read
 *     (`docs/ENV_SECRET_EXPOSURE_BASELINE.md`). This section claims nothing
 *     about secrets.
 * 10. "The dosco agent platform" is aspiration, and `/about` is allowed to say it
 *     because that page is explicitly a vision page. It must never be dressed
 *     up as shipped capability here: training, RL and evals are NOT shipped, so
 *     do not name them in this section at all.
 */

export const openSource = {
  /** The one number on this section. Read live; never hardcoded. */
  stars: {
    /** Sits under the digits, and is the accessible label with them. */
    caption: 'GitHub stars on kortix-ai/suna',
  },

  /**
   * The whole note. Sentence one is `/about` → `hero.title` verbatim; sentence
   * two is the first clause of `hero.lead`. Keep the two files in step.
   */
  title: 'We are building the dosco agent network. Every company should own all of it.',

  /** Primary way out: the rest of the reason. */
  aboutLabel: 'Why we are building it',
  aboutHref: '/about',

  /** Secondary: the proof the number is about something real. */
  repoLabel: 'Read the source',
  repoHref: 'https://github.com/kortix-ai/suna',
} as const;
