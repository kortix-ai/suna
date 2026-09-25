# Cloudflare — instant, zero-account publishing

Cloudflare has two ways to get a live URL with **no account**, both with the
same deliberate ~60-minute half-life: a browser drag-drop (**Drop**) and a CLI
flow the agent can drive itself (**`wrangler deploy --temporary`**). Use the CLI
one from the sandbox; point the user at Drop when they'd rather do it by hand.

## `wrangler deploy --temporary` (the agent path)

Provisions a throwaway "preview" Cloudflare account, deploys to it, and prints a
**live URL** + a **claim URL**. No OAuth, no token, no email parsing.

### Requirements

- **Wrangler ≥ 4.102.0** (`npx wrangler@latest` gets you current).
- **Node 18+**.
- Wrangler must be **unauthenticated** — `--temporary` refuses to run if there's
  any credential present:
  - no OAuth login → `npx wrangler@latest logout` first,
  - no `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_API_KEY` in the env → `unset` them,
  - no cached OAuth in `~/.wrangler` / `~/.config/.wrangler`.

### Static site

```bash
npx wrangler@latest logout 2>/dev/null || true
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_API_KEY
npx wrangler@latest deploy --assets ./dist --temporary --name my-site
```

`--assets <dir>` serves a folder of static files (this replaces Workers Sites).
No `wrangler.jsonc` is needed for a pure static deploy; passing `--name` keeps it
non-interactive.

### Dynamic (a Worker)

If there's actual server logic, deploy a Worker instead — `--temporary` works the
same way. Minimal `wrangler.jsonc`:

```jsonc
{
  "name": "my-site",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-01",
  "assets": { "directory": "./dist" }
}
```

```bash
npx wrangler@latest deploy --temporary
```

### What you get back

- **Live URL** — a `*.workers.dev` address, live immediately. Share it.
- **Claim URL** — open within ~60 min to keep the deploy by signing into (or
  creating) a real Cloudflare account.

Parse both out of the command output and hand them to the user.

### Lifetime & limits

- Expires after **~60 minutes of inactivity**; **each redeploy resets the
  timer**, so an agent actively iterating keeps it alive. Unclaimed accounts
  auto-delete.
- **No API** to convert temporary → permanent — a human claims it in the browser.
- Each temporary deploy is an **isolated account** (agents can't share one).
- Supported at launch: **Workers, Workers Static Assets, KV, D1, Durable
  Objects, Hyperdrive, Queues**. **Not** R2 or Workers AI (excluded at launch).

## Cloudflare Drop (browser)

`https://cloudflare.com/drop` — drag a **folder or `.zip` of static assets**
(HTML/CSS/JS/images/fonts) into the page and get a live URL on Cloudflare's
network in seconds. No account, no config. Stays live **1 hour**; a **Claim**
button converts it to a real Cloudflare project (sign in or create an account;
the claim link runs on a visible countdown). After claiming you can add a domain,
enable observability, and control access.

Use this when the user wants to publish something themselves without touching a
terminal: build the site, `zip -r site.zip ./dist`, and tell them to drop
`site.zip` at `cloudflare.com/drop`.

## Choosing between them

- **Agent, from the sandbox, static** → `wrangler deploy --assets … --temporary`.
- **Agent, dynamic/Worker** → `wrangler deploy --temporary` with a `wrangler.jsonc`.
- **User does it by hand in a browser** → Cloudflare Drop.
- **Must persist / custom domain** → claim the temp deploy, or use Vercel
  (`references/vercel.md`).
