# Auth sub-surfaces redesign — cli, github, oauth, slack, teams, tunnel

Date: 2026-07-13 · Branch: `other-section` · Status: approved direction (user-pinned reference)

## Brief

Rebuild the six auth-adjacent surfaces to match the `/auth` page's quiet, flat
design language exactly — layout, spacing, alignment, motion, and tone. Clean,
simple, minimal, fast. Kortix serves 400k+ users: clarity and consistency over
decoration.

**Design read:** trust-first product utility surfaces (consent / status), not
marketing. Variance low, motion minimal (the existing two-part Rise only),
density airy. The user pinned the direction — match `(auth)/auth` — so the
reference dialect wins over any invented aesthetic.

Pattern research (Mobbin: GitHub authorize-app, Cloudflare confirm-access,
Laravel Cloud install & authorize, X/xAI consent): one headline naming the
requester, quiet signed-in identity, short scannable permission list, one
primary action + quiet cancel, revoke note in small text. All of it maps 1:1
onto the `/auth` dialect.

## The reference dialect (source of truth)

From `apps/web/src/app/(auth)/auth/page.tsx` + `features/auth/auth-primitives.tsx`
+ `features/auth/auth-card-shell.tsx`:

- **Frame:** `bg-background relative flex min-h-svh flex-col`; `AuthMobileLogo`
  pinned top-left on mobile; `<main>` centered with `px-6 py-24`; content column
  `w-full max-w-[380px]`, left-aligned; `AuthLegalFooter` pinned at the bottom.
  No card, no shadow, no wallpaper.
- **Header:** `StepHeader` — Kortix icon mark (22px, desktop), `text-2xl
  font-medium tracking-tight` title, `text-muted-foreground mt-2 text-sm
  text-pretty` description, `mb-10` below the block.
- **Motion:** `Rise` — header at delay 0, body at 0.06; ease `[0.23,1,0.32,1]`,
  0.3s, y 8 → 0; opacity-only under reduced motion. Nothing else animates.
- **Status strips:** `ErrorStrip` / `InfoStrip` / `SuccessStrip`.
- **Buttons:** full-width `Button size="lg"`, stacked (primary, then
  `variant="secondary"`); pending state swaps in `Loading` (never `Loader2`).
- **Quiet links:** `text-muted-foreground` → `hover:text-foreground`,
  `underline-offset-4 hover:underline`, hit area grown with `-my-2 py-2`.
- **Color:** semantic tokens + `kortix-*` only.

## What's wrong today

| Page | Problems |
| --- | --- |
| `cli/authorize` | Old card dialect: `bg-muted/30` page, shadowed card, `Loader2`, raw emerald palette, rounded-full icon circles, two-column footer actions. |
| `slack/login/[token]`, `teams/login/[token]` | Same old card dialect, duplicated between the two files. |
| `oauth/authorize` | Centered column, rounded-full Shield tile, uppercase-tracking eyebrow, `fixed inset-0`, mixed muted panels. |
| `tunnel/authorize/[code]` | Entirely different world: wallpaper + backdrop-blur glass card, `rounded-2xl`, uppercase tracked labels, `font-extralight`, opacity-based colors instead of tokens. |
| `github/setup` | Centered status text, its own heading scale, `ConnectingScreen` dependency; near but not in the dialect. |

## Design

### Shared pieces

1. **Extract `AuthFrame`** into `features/auth/auth-card-shell.tsx` (it already
   exists twice: privately in `auth/page.tsx` and inline in `AuthCardShell`).
   Export it; reuse from `/auth`, `AuthCardShell`, and all six pages.
2. **New `features/auth/auth-consent.tsx`** with the small vocabulary the six
   surfaces share:
   - `AuthPendingScreen` — `AuthFrame` + centered `Loading` (session checks /
     initial fetches). Quiet, no text flash.
   - `AuthStatusScreen({ title, description, action? })` — `AuthFrame` +
     `StepHeader` + optional action row. Terminal states (success / error /
     expired / missing link). Tone lives in copy, not decoration.
   - `DetailPanel` / `DetailRow({ label, value, mono? })` — quiet bordered
     panel (`rounded-md border bg-muted/40`), label muted left, value right,
     `font-mono` only for technical values (host:port, device code).
3. **Extract `validateCallback`** (cli) into a pure module with a co-located
   bun test — the one real logic unit in these pages (testing rule).

### Per page

- **cli/authorize** — StepHeader "Sign in to the Kortix CLI" + "`kortix login`
  in your terminal is waiting for approval." DetailPanel: Account / Sends to /
  Device. Full-width primary **Authorize CLI**; quiet Cancel link below.
  ErrorStrip on failure. Success → StatusScreen "CLI connected · return to
  your terminal, you can close this tab." Revoke note as small muted text.
- **slack + teams login** — identical connect-account pattern: StepHeader
  "Connect Slack/Teams to Kortix" + one-sentence why (bot acts as you).
  DetailPanel: Account. Primary **Connect account**; quiet Cancel. Success →
  StatusScreen with the existing context-aware message. Disconnect note small.
- **oauth/authorize** — StepHeader "Authorize {client}" + "{client} wants to
  access your Kortix account." Permission list (plain rows, small check/bullet)
  in a DetailPanel-style block titled in sentence case (no uppercase eyebrow);
  "Signed in as {email}" as a quiet row. Stacked **Allow** (primary) /
  **Deny** (secondary). Revoke note small.
- **tunnel/authorize** — drop wallpaper/glass entirely. StepHeader "Authorize
  this device" + "Check the code below matches your terminal." Device code as
  a mono, tracked, `tabular-nums` display row with the countdown; connection
  name `Input`; capability checklist rows in dialect tokens (selection =
  `bg-primary/[0.06]`, real checkbox squares); **Approve connection** primary,
  quiet Deny link. Terminal states → StatusScreen.
- **github/setup** — automatic flow: pending = StatusScreen-with-Loading
  ("Connecting GitHub…"); done/error = StatusScreen with message and, on
  error, a **Back to projects** button. Drop `ConnectingScreen`.

### Behavior is untouched

All effects, redirects, API calls, timeouts, token-revocation cleanup, and
param handling stay exactly as they are. This is a presentation-layer change.
New copy uses plain strings (the reference `/auth` page does the same; the
`hardcodedUi` keys are auto-extracted later by the i18n codemod).

## Approaches considered

- **A (chosen): reuse `/auth` primitives + a thin consent vocabulary.** Max
  consistency, minimal new API, exactly what was asked.
- **B: new standalone ConsentShell feature.** More API surface, drifts from
  `AuthCardShell` over time.
- **C: per-page inline rebuilds.** Six copies of the same dialect — the drift
  that produced today's mess.

## Verification

`tsc` + eslint on changed files; bun test for the extracted logic; boot the
worktree web app and screenshot reachable states (signed-in via the local
session cookie trick where the stack allows); `make-interfaces-feel-better`
checklist pass; fresh-eyes review subagent at the end.
