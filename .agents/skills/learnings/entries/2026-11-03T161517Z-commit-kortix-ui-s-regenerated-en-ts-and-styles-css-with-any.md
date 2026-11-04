---
recorded: 2026-11-03T16:15:17Z
incident_date: 2026-11-03
---
# Commit @kortix/ui's regenerated en.ts and styles.css with any UI change that adds a string or a class

**Rule:** When a change under `packages/ui/src` reads a new message or uses a new utility class, or `apps/web/translations/en.json` gains a message the package reads, run `pnpm --filter @kortix/ui gen-i18n-catalog` and `pnpm --filter @kortix/ui build:styles` and commit `packages/ui/src/i18n/en.ts` and `packages/ui/dist/styles.css` in the same change. Typecheck, lint and the web app do not notice the gap. Only the package's own tests do.

**Trigger surface:** Any new copy key or Tailwind class in a `packages/ui` component, such as a channel card, a mock or a dialog.

**Incident:** 2026-11-03.
- The Discord channel kortix-ai/suna#11561 added copy and classes to `packages/ui` without regenerating either file.
- `dev` stayed red on `en.ts matches its sources` and on `the committed styles.css matches src` until kortix-ai/suna#11602 regenerated them for the v0.14.18 release.
- The same day, kortix-ai/suna#11592 (the Discord Channels card) repeated the gap. Its follow-up regenerated the files and added the hook below.
- No runtime break: hosts that load `@kortix/ui/styles.css` lacked the new classes, and hosts without translations lacked the new English strings.

**Enforcement:**
- `.githooks/pre-commit` runs `gen-i18n-catalog --check` and `build-styles --check` (~0.5 s) when a commit stages `packages/ui/src/**/*.{ts,tsx,css}` or `apps/web/translations/en.json`. It refuses a stale file and prints both commands.
- After the merge, `packages/ui/src/i18n/i18n.test.tsx` and `packages/ui/src/styles/stylesheet-coverage.test.ts` still catch it, in the nightly and release lanes.
