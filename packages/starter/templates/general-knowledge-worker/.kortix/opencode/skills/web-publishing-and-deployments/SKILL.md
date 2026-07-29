---
name: web-publishing-and-deployments
description: "Publish a website or web app from the sandbox to a public URL, and deploy to cloud providers — get a live link to share, ship a static site or SPA, put a built site online, or deploy a framework app / container. Use when the user says 'publish this', 'deploy it', 'put it online', 'give me a live URL', 'host this', 'share a preview link', or wants to make a site/app they (or you) just built reachable on the web. Covers the zero-account instant path (Cloudflare) and permanent hosting (Vercel, incl. any Dockerfile). Also owns the publish GUARDRAILS: never publish unprompted, how to honestly take a site down, the runtime-dependency and data-persistence checks, and the mandatory pre-publish security review. Points at kortix-marketplace for other providers and deeper provider-specific skills."
defaultProjectInstall: true
---

# Web Publishing & Deployments

Get a site or app that exists in the sandbox onto a public URL — and decide
whether it should go up at all. **When** to publish is the first half of this
skill; **how** is the second.

## Never publish unprompted

Default posture: **everything stays a local preview until the user explicitly
asks to go live.** Previewing is free and re-runnable; publishing is a
deliberate, opt-in step that puts code on a URL other people can reach.

Publish only when the user asks in plain terms — "publish this", "make it
live", "give me a real/permanent/shareable link", "put this online", "I want to
send this to people".

- **Never publish unprompted.** If the site looks finished and you suspect
  they'll want it live, *offer* — "Want me to publish this to a shareable
  URL?" — and wait for the yes.
- **Don't auto-republish after edits.** Re-running a local preview is fine any
  time. Pushing changes to a live URL is not — offer, then wait.
- **Don't publish from memory.** If you believe a site went live earlier but the
  current state doesn't confirm it's still up, assume the user took it down on
  purpose. Re-publish only on a fresh, explicit request.
- **Subagents never publish.** Approval only routes back to the main thread.
  Finish the build, verify the preview, hand the project path back.

## Taking a published site down

You cannot quietly revoke a live URL, and you must never fake a takedown by
overwriting the site with a blank page, a placeholder, or a redirect — that
leaves confusing, half-broken state and is not a real unpublish. Point the user
at the real control (their deploy platform's dashboard, or stopping the shared
sandbox preview), leave the project files untouched, and say plainly that a
shared preview URL is public-by-link if they asked for privacy.

## Before you publish

1. **Verify the live build, not just the source.** Start the server, exercise
   the real URL, and confirm the *built* output works. Don't grep the source and
   assume.
2. **Run the pre-publish security review** — mandatory, every publish. See
   "Security review" below.
3. **Flag runtime-only dependencies that won't survive publishing.** API keys
   set in the dev environment aren't automatically present in a standalone
   deployment, and anything reaching back into the Kortix agent runtime or its
   connectors has no bridge once deployed. Scan first:

   ```bash
   grep -rn -E "(ANTHROPIC_API_KEY|OPENAI_API_KEY|ELEVENLABS_API_KEY|generate_image|generate_video|generate_audio)" \
     --include='*.py' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
     --exclude-dir=node_modules --exclude-dir=dist . 2>/dev/null
   ```

   For each hit: refactor it out (bake the output as a static asset at build
   time — cleanest), provision the credential on the deploy host, or tell the
   user the feature will be degraded and let them choose.
4. **Disclose data-persistence limits.** If the app stores user-submitted data
   in SQLite, an in-memory store, or a local file, that data is not durable on
   an ephemeral host. Say so plainly *before* publishing, once per publish, in
   non-technical terms. For real multi-user persistence use Supabase, with the
   URL and anon key provisioned as production env vars — never hardcoded into
   the shipped bundle.
5. **Use secure cookies behind the preview proxy.** Sites served through the
   sandbox preview proxy sit behind Kortix's domain — set `Secure`,
   explicitly-named, properly-scoped session cookies rather than relying on
   framework defaults.

## Security review

Before publishing, run a security-review **subagent** with the prompt in
`references/security-review-prompt.md`. The checks are mostly grep/bash, so a
fast, cheap model is fine. Pass it `{{project_path}}` (absolute path) and
`{{context}}` (one or two lines on what the site is and whether it handles user
data — "public marketing page, no user data" vs "small-team task tracker backed
by Supabase") so it can calibrate severity.

- **BLOCK** (exposed secrets, leaked credentials, critical exploitable
  vulnerabilities): fix what you can automatically — pull hardcoded keys into
  env vars, add `.env` to `.gitignore`. If a fix needs the user, surface it and
  stop. **Never publish over an unaddressed BLOCK.**
- **WARN**: present it and let the user decide.

---

Once the user has said yes and the checks are clean, there are two worlds, and
picking the right one is 90% of the job:

- **Instant & throwaway** — a live URL in seconds, **no account, no login**, for
  a preview/demo the user can click and share. It self-destructs after ~1 hour
  unless claimed. This is the default when someone just wants to *see it live*.
- **Permanent** — a real deployment on the user's own hosting account (custom
  domain, stays up, redeploys). This needs their account, so it involves them.

Always build the site first (`npm run build`, etc.) so you're publishing the
final output directory (`dist/`, `out/`, `build/`, `.next/`, …), not source.

## Which one?

**First, check whether the project already answers this.** If the repo targets a
host — a Vercel or Cloudflare config, a Dockerfile, a CI deploy step — use that
exact workflow. Don't invent a competing one. The table below is for projects
with no deploy target of their own.

| The user wants… | Use | Account needed? |
| --- | --- | --- |
| A live URL right now to preview/share a **static** site or SPA | **Cloudflare temporary deploy** (`wrangler deploy --temporary`) — see below | **No** |
| To drag-and-drop it themselves in a browser | **Cloudflare Drop** (`cloudflare.com/drop`) or **Vercel Drop** (`vercel.com/drop`) — `references/cloudflare.md`, `references/vercel.md` | CF: no · Vercel: yes |
| A **framework app** (Next.js, etc.) built & hosted properly | **Vercel** (`vercel deploy`, or Vercel Drop which auto-builds) — `references/vercel.md` | Yes |
| It to **stay up** on their own domain | **Vercel** (or claim a Cloudflare temp deploy) — `references/vercel.md` | Yes |
| A **backend / container / any language** online | **Vercel Dockerfile** (`Dockerfile.vercel`) — `references/vercel.md` | Yes |

When in doubt for "just show me it live," reach for the Cloudflare temporary
deploy first — it's the only path that needs nothing from the user.

## Fast path — instant live URL, no account (Cloudflare)

`wrangler deploy --temporary` provisions a throwaway Cloudflare account, deploys,
and prints a **live URL** plus a **claim URL** — all with zero credentials. It is
the go-to for handing someone a working link in one turn.

```bash
# Build first, then point --assets at the output directory.
# --temporary ONLY works when wrangler is unauthenticated, so clear any creds:
npx wrangler@latest logout 2>/dev/null || true
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_API_KEY

npx wrangler@latest deploy --assets ./dist --temporary --name my-site
```

Parse the output for the two URLs and hand **both** to the user:
- the **live URL** (`*.workers.dev`) — works immediately, share it,
- the **claim URL** — valid ~60 min; the user opens it to keep the site by
  signing into (or creating) a Cloudflare account.

Caveats to state plainly when you hand it over:
- **It's temporary.** The deployment expires after ~60 min of inactivity;
  **re-running the deploy resets the timer**, and unclaimed accounts auto-delete.
  To make it permanent, the user claims it (or use Vercel instead).
- Requires **wrangler ≥ 4.102.0**, **Node 18+**, and a genuinely
  **unauthenticated** wrangler (no OAuth login, no `CLOUDFLARE_*` token env).
- **Static assets only** on this path (HTML/CSS/JS/images/fonts). Dynamic apps →
  a Worker (still works with `--temporary`) or Vercel. Full detail + the browser
  drag-drop flow: **`references/cloudflare.md`**.

## Permanent / framework / container (Vercel)

For a site that stays up on the user's account, a framework project that needs a
real build, or any backend/container, use Vercel — `vercel deploy` from the CLI
(deployment limits were removed, so it's agent/CI-friendly), the browser
**Vercel Drop** (auto-detects and builds frameworks), or **`Dockerfile.vercel`**
to run any Dockerfile as an autoscaling function. All of this needs the user's
Vercel account/token. Full detail: **`references/vercel.md`**.

## Handing off — always do this

1. Give the user the **live URL** first thing (that's the payoff).
2. If it's a temporary deploy, say so in one line + give the **claim URL** and
   the ~60-min window. Don't let them assume it's permanent.
3. Offer the permanent path as the natural next step ("want this to stay up on
   your own domain? I'll set it up on Vercel / you can claim it on Cloudflare").
4. **Never publish secrets or private data to a temporary, unauthenticated
   public URL** — anything you deploy this way is world-readable. Treat a public
   URL as public.

## Other providers & going deeper (`kortix-marketplace`)

This skill covers the two fast paths (Cloudflare + Vercel) inline. For anything
beyond that — **a different provider** (Netlify, Render, Fly.io, AWS, Deno
Deploy, GitHub Pages, Railway, …) or a **deeper, provider-specific skill** for
Vercel or Cloudflare (full framework configs, edge functions, DNS/domains, CI) —
use the **`kortix-marketplace`** skill to search the catalog and import a
battle-tested one:

```bash
kortix marketplace search "netlify deploy" --json
kortix marketplace search "cloudflare workers" --json
kortix marketplace search "fly.io deploy docker" --json
```

Reach for `kortix-marketplace` whenever the user names a provider this skill
doesn't cover, or wants richer, dedicated Vercel/Cloudflare tooling than the
quickstarts here — import and use the specialized skill rather than
hand-rolling it.
