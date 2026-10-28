---
name: white-label
description: "White-label Kortix: fork it, run it on Platinum, and rebrand it as the user's own product. No license to sign. Load WHENEVER a user asks to white-label, rebrand, resell, fork, or host Kortix under their own name, logo, or domain, or asks what the license allows."
---

# White-label Kortix

Kortix is open source under the Apache License 2.0 (`LICENSE`). Anyone may
fork it, change it, rebrand it and sell it, also as a hosted service. There is
no agreement to sign and no license key to get. Do not give legal advice:
point the user to the files.

| File | What it says |
|---|---|
| `LICENSE` | Apache 2.0 for everything outside an `ee/` directory. |
| `ee/LICENSE` | The Kortix Enterprise License for every path under an `ee/` directory (SAML SSO, SCIM, custom roles and groups, audit log access). Development and testing are free. Production use needs a Kortix Enterprise subscription. `ee/README.md` explains it. |
| `TRADEMARKS.md` | Only Kortix may use the Kortix name and logo. A fork uses its own. |

## 1. Fork

Fork `kortix-ai/suna` on GitHub, or clone it. Keep every copyright and license
notice in the source. The UI does not need to show Kortix.

## 2. Compute: Platinum

Kortix runs its sessions on Platinum. It is the only sandbox provider for a new
deployment.

1. The user signs in at `https://platinum.dev/dashboard` and creates an API key
   (`pt_live_…`). Platinum shows the key once. When signup is closed for them,
   they email marko@kortix.ai.
2. Treat the key as a secret. Never write it into a tracked file, a commit, or a
   log. Put it in the deployment's secret store or untracked env file.
3. Set the API environment of the deployment:

   ```bash
   ALLOWED_SANDBOX_PROVIDERS=platinum
   PLATINUM_API_KEY=pt_live_...
   PLATINUM_API_URL=https://api.platinum.dev
   ```

   `apps/api/src/config.ts` reads these. With `kortix self-host start`, the same
   values come from the "Sandbox provider" prompt (choose `platinum`).
4. Start one session and confirm that it reaches a running sandbox.

Organization branding is free on every plan: no key turns it on. The Enterprise
features need `KORTIX_LICENSE_KEY`, a signed key that Kortix issues with an
Enterprise subscription (`kortix self-host` flag `--license-key <key>`).
Without a key, an owner can turn on the Enterprise Demo for development and
testing.

## 3. Rebrand

Choose the smallest path that meets the user's goal.

**A. No code: the Branding tab.** Open `/accounts/<account_id>?tab=branding` in
the instance. Set the product name and upload the logo, the symbol, and the
favicon (each with a dark variant). `packages/ui/src/primitives/kortix-logo.tsx`
and the browser-tab title use these values after the account loads.

**B. Source rebrand of `apps/web`.** For what path A does not cover:

| What | Where |
|---|---|
| Name, title, canonical domain | `packages/ui/src/internal/lib/site-metadata.ts` |
| Page metadata, author, icons | `apps/web/src/app/[locale]/layout.tsx` |
| Logo component | `packages/ui/src/primitives/kortix-logo.tsx` |
| Static icons and logos | `apps/web/public/` (`favicon.*`, `icon-*.png`, `apple-touch-icon.png`, `*.svg`) |
| PWA manifest | `apps/web/public/manifest.json` |
| Colors | `.agents/skills/kortix-brand/references/visual/visual-system.json`, then run `.agents/skills/kortix-brand/scripts/generate-tokens.ts`. Never edit the generated blocks of `globals.css` by hand. |
| Product name in UI copy | `apps/web/translations/*.json` |
| Email sender | `EMAIL_FROM` and `SMTP_SENDER_NAME` in the instance env |

**C. Own frontend on `@kortix/sdk`.** Three patterns live under
`apps/white-label/`. `apps/white-label/README.md` compares them and has the
id map.

- **Reskin the Kortix workspace:** `apps/white-label/reskin` (Lumen
  Workspace). Next.js. The Kortix product screens (`@kortix/ui` session,
  workspace and files modules) under your own typed theme, mark and fonts.
  Direct mode: each person pastes a Kortix PAT and the browser calls the
  Kortix API (the API must allow the origin through CORS). Wrapper mode:
  `KORTIX_API_KEY` stays on your server, people sign in to your app, and a
  same-origin proxy with a deny-by-default policy calls Kortix. Name and
  tagline: `src/config/brand.ts`. Colors, radius, fonts: `src/config/theme.ts`.
- **Wrap Kortix for your own team:** `apps/white-label/team-console`. A Vite
  static Kortix App. People sign in with their Kortix login (the App viewer
  identity). Kortix is the identity and the data. No backend.
- **Wrap Kortix as a SaaS you sell:** `apps/white-label/lumen` (AI for legal
  teams). Lumen owns customers, accounts, firms, plans, seats and data
  (Next.js + Convex + Better Auth). One Kortix project is the whole backend:
  each firm is a Drive folder, an agent (grants: that folder + the read-only
  kit; no repository, no Kortix permissions) and a service account (project
  role `member`, owns the firm's sessions). A restricted matter gets its own
  folder `/Lumen/Walled/<matterId>` and agent `lumen-m-<matterId>`. Members reach Kortix only through
  Lumen's same-origin proxy, which holds the firm's credential, pins the
  matter's agent (the firm's, or a restricted matter's own) and binds every session and sandbox to the matter. The
  isolation table: `apps/white-label/lumen/README.md` "One project, many firms". Name and tagline: `src/config/brand.ts`. Colors,
  radius, fonts: `src/config/theme.ts`.

## 4. Stay compliant

- Keep every copyright and license notice in the source code.
- Do not use the Kortix name or logo for the user's product. `TRADEMARKS.md`
  says which factual references to Kortix are allowed.
- Do not run code from an `ee/` directory in production without a Kortix
  Enterprise subscription.
