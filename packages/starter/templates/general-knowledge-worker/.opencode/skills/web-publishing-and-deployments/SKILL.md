---
name: web-publishing-and-deployments
description: "Publish a website or web app from the sandbox to a public URL, and deploy to cloud providers — get a live link to share, ship a static site or SPA, put a built site online, or deploy a framework app / container. Use when the user says 'publish this', 'deploy it', 'put it online', 'give me a live URL', 'host this', 'share a preview link', or wants to make a site/app they (or you) just built reachable on the web. Covers the zero-account instant path (Cloudflare) and permanent hosting (Vercel, incl. any Dockerfile), and points at find-skills-sh for other providers and deeper provider-specific skills."
defaultProjectInstall: true
---

# Web Publishing & Deployments

Get a site or app that exists in the sandbox onto a public URL. There are two
worlds, and picking the right one is 90% of the job:

- **Instant & throwaway** — a live URL in seconds, **no account, no login**, for
  a preview/demo the user can click and share. It self-destructs after ~1 hour
  unless claimed. This is the default when someone just wants to *see it live*.
- **Permanent** — a real deployment on the user's own hosting account (custom
  domain, stays up, redeploys). This needs their account, so it involves them.

Always build the site first (`npm run build`, etc.) so you're publishing the
final output directory (`dist/`, `out/`, `build/`, `.next/`, …), not source.

## Which one?

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

## Other providers & going deeper (`find-skills-sh`)

This skill covers the two fast paths (Cloudflare + Vercel) inline. For anything
beyond that — **a different provider** (Netlify, Render, Fly.io, AWS, Deno
Deploy, GitHub Pages, Railway, …) or a **deeper, provider-specific skill** for
Vercel or Cloudflare (full framework configs, edge functions, DNS/domains, CI) —
use the **`find-skills-sh`** skill to search the open ecosystem and install a
battle-tested one:

```bash
npx skills find "netlify deploy"
npx skills find "cloudflare workers"
npx skills find "vercel deployment"
npx skills find "fly.io deploy docker"
```

Reach for `find-skills-sh` whenever the user names a provider this skill doesn't
cover, or wants richer, dedicated Vercel/Cloudflare tooling than the quickstarts
here — pull in and use the specialized skill rather than hand-rolling it.
