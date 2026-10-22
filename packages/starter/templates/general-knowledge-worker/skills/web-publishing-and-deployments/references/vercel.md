# Vercel — permanent hosting, frameworks, and any Dockerfile

Vercel is the path when the site should **stay up on the user's own account**,
when it's a **framework app** that needs a real build, or when it's a
**backend/container**. Everything here needs the user's Vercel account or token —
there's no zero-account path like Cloudflare's temporary deploy. When the user
just wants an instant throwaway preview, prefer Cloudflare (`references/cloudflare.md`).

## `vercel deploy` (CLI — the agent path)

Vercel **removed CLI deployment limits** across all plans (including the free
Hobby tier), so deploying from the sandbox / CI is now first-class.

```bash
# Auth once with the user's token (they create it at vercel.com/account/tokens):
export VERCEL_TOKEN=…            # or `npx vercel login`
npx vercel deploy --yes --token "$VERCEL_TOKEN"                 # preview URL
npx vercel deploy --prod --yes --token "$VERCEL_TOKEN"         # production URL
```

Build-then-upload (faster, fewer files) for a project you've already built:

```bash
npx vercel build --token "$VERCEL_TOKEN"
npx vercel deploy --prebuilt --archive=tgz --token "$VERCEL_TOKEN"
```

- `--prebuilt` deploys the local `.vercel/output` from `vercel build`. Don't use
  it if the build needs **System Environment Variables** at build time (they
  aren't injected in `--prebuilt` mode).
- `--archive=tgz` compresses the upload — handy for large outputs.

## Vercel Drop (browser)

`https://vercel.com/drop` — drag a **single HTML file, a folder, or a `.zip`**
into the browser. Unlike Cloudflare Drop it **auto-detects frameworks** (e.g.
Next.js), **builds them for you**, and publishes to production. The user picks a
team and project name — so it **requires a Vercel account**. Each drop creates a
**new project** and doesn't redeploy an existing one, so iterating means
switching to Git or the CLI afterward.

Use it when the user wants to publish a framework export by hand, or a build
they'd rather have Vercel run.

## Any Dockerfile → Vercel Functions

Vercel can run **any Dockerfile** as an OCI image on Fluid compute — good for a
backend or an app in a language that isn't JS.

1. Add a **`Dockerfile.vercel`** (or `Containerfile`) to the project. The only
   hard requirement: the server **listens on `PORT`** (defaults to 80).
2. Deploy normally (`vercel deploy`). Vercel **builds the image, stores it in the
   Vercel Container Registry, deploys it as a Function, and autoscales it**.

Works for Rails, Spring Boot, Express, Laravel, ASP.NET, FastAPI, nginx, etc.

**Limits to know:** these run as OCI images *on top of* Vercel Functions / Fluid
compute — so they inherit function limits (capped image size, memory, and
execution duration) and **scale to zero after ~5 min idle**. Great for
request/response backends and previews; not a place for a long-running stateful
process.

## Choosing within Vercel

- **Framework app, permanent** → `vercel deploy --prod` (or Vercel Drop to let it
  build).
- **Already built locally** → `vercel build` + `vercel deploy --prebuilt`.
- **Backend / non-JS / container** → `Dockerfile.vercel` + `vercel deploy`.
- **User wants to do it in a browser** → Vercel Drop.
