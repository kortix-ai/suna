---
name: white-label
description: "White-label Kortix: license it, run it on Platinum, and rebrand it as the partner's own product. Load WHENEVER a user asks to white-label, rebrand, resell, or host Kortix under their own name, logo, or domain, or asks about the white-label license or the Exclusive Compute Agreement."
---

# White-label Kortix

The license is `WHITE-LABEL-LICENSE.md` at the repository root. Read its summary
first. The agreement there is the binding text. Do not paraphrase it as legal
advice.

The one requirement: the partner uses Platinum as its exclusive compute provider,
for every service Platinum offers (sandboxes today; volumes, runners, AI compute,
and inference when Platinum offers them and Kortix uses them).

## 1. License: a person signs, never the agent

1. Give the user the signing link from "Get a license" in
   `WHITE-LABEL-LICENSE.md`.
2. A person with authority for their organization signs it. You must not sign,
   type a signature, or accept the agreement for them.
3. Continue when the user confirms that they signed. Documenso emails them the
   signed copy.
4. Custom terms: the user emails marko@kortix.ai. Do not promise terms that the
   agreement does not contain.

## 2. Compute: Platinum

The license covers any fork or wrapper of this repository, on any infrastructure.
The deployment method does not matter. The compute provider does.

1. The user signs in at `https://platinum.dev/dashboard` and creates an API key
   (`pt_live_…`). Platinum shows the key once. When signup is closed for them,
   they email marko@kortix.ai from the address they signed with.
2. Treat the key as a secret. Never write it into a tracked file, a commit, or a
   log. Put it in the deployment's secret store or untracked env file.
3. Set the API environment of the deployment:

   ```bash
   ALLOWED_SANDBOX_PROVIDERS=platinum   # platinum only, never a list with another provider
   PLATINUM_API_KEY=pt_live_...
   PLATINUM_API_URL=https://api.platinum.dev
   ENTERPRISE_LICENSE_AVAILABLE=true    # turns on the branding entitlement
   ```

   `apps/api/src/config.ts` reads these. With `kortix self-host start`, the same
   values come from the "Sandbox provider" prompt (choose `platinum`) and the
   `--enterprise-license` flag.
4. Start one session and confirm that it reaches a running sandbox.

`ENTERPRISE_LICENSE_AVAILABLE=true` turns on the `branding` entitlement (and SSO,
SCIM, RBAC, and audit). Section 2.2(d) of the agreement permits it for a licensed
partner.

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

**C. Own frontend on `@kortix/sdk`.** Two patterns live under
`apps/white-label/`. `apps/white-label/README.md` compares them and has the
id map.

- **Wrap Kortix for your own team:** `apps/white-label/team-console`. A Vite
  static Kortix App. People sign in with their Kortix login (the App viewer
  identity). Kortix is the identity and the data. No backend.
- **Wrap Kortix as a SaaS you sell:** `apps/white-label/lumen` (AI for legal
  teams). Lumen owns customers, accounts, firms, plans, seats and data
  (Next.js + Convex + Better Auth). Each firm is one Kortix project. Members
  reach Kortix only through Lumen's same-origin proxy with a server-held,
  1 h, project-scoped token. Name and tagline: `src/config/brand.ts`. Colors,
  radius, fonts: `src/config/theme.ts`.

## 4. Stay compliant

- Never configure Daytona (the legacy fallback) or any other sandbox provider
  for a white-label instance. Platinum is the only one.
- When Kortix gives notice of a new Platinum service that the instance uses, move
  that work to Platinum within 90 days.
- Keep every copyright and license notice in the source code. The UI does not
  need to show Kortix.
- Do not use the Kortix or Platinum names or logos, except "powered by Kortix" or
  "powered by Platinum".
