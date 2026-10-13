import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import { SECURITY_SELFHOST_TRANSLATION_KEYS } from '@/i18n/security-selfhost-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';

/**
 * `/security` copy — the page a security reviewer reads.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `kortix-brand` skill. ACCURACY GATE for this page specifically —
 * every line below traces to shipped code, and the citation is in the comment
 * above it. This is the page an enterprise reviewer will hold us to.
 *
 *  - SOC 2 Type I is held (certified — the report has landed). SOC 2 Type II is
 *    IN PROGRESS — never "compliant", never "certified" for it until its report
 *    lands. No ISO, no HIPAA — we do not hold them. GDPR is a posture we run,
 *    not a third-party certificate, so it carries no "in progress" state.
 *  - Never name a licence — "open source" and stop.
 *  - Say "cloud computer" / "sandbox". NEVER "container".
 *  - No invented metrics, customers, latency, or uptime numbers.
 *  - Nothing merges itself: work reaches `main` through a change request a
 *    person approves.
 *
 * CORRECTIONS made against the claims on neighbouring pages, all verified
 * against code before this page shipped. Do not "restore" any of them:
 *
 *  1. "Never visible to the model" (the /enterprise secrets bullet) is FALSE
 *     for project secrets. A granted runtime secret is a real environment value
 *     inside the session, readable by any command the agent runs — that is how
 *     a tool uses it. What IS true, and is all this page claims: connector credentials
 *     are resolved server-side and never enter the machine, Kortix's own
 *     upstream keys never enter it either, and a session only receives the
 *     secrets both the person's role and the agent's declared grant allow.
 *  2. "Each session runs in its own VM" / blanket "microVM" is NOT true of the
 *     DEFAULT provider. Platinum is a Cloud Hypervisor microVM; Daytona, the
 *     default, is not. The copy claims one isolated sandbox per session, and
 *     names microVM only where it is accurate.
 *  3. "Egress controlled at the network" (a `kortix-brand` proof point) is NOT
 *     substantiated anywhere in this tree — E2B ships `allowInternetAccess:
 *     true` and the network design is "Proposed — not scheduled". Dropped.
 *  4. Approval gates are NOT on by default. `policy.default_mode` falls back to
 *     `allow_all` for a project with no `policy:` block
 *     (apps/api/src/projects/policies.ts). The copy says "turn it on".
 *  5. "Only a human can merge" is too strong. Merge is default-deny for agents
 *     and needs an explicit `project.cr.merge` grant. The copy says exactly
 *     that, which is the stronger claim anyway.
 *  6. Secrets are NOT scoped per person or per group — that model was retired
 *     (migration 20260706_secrets_v2_identifier_model.sql). Scoping is per
 *     project, per agent grant, and connector-scoped.
 *  7. SSO is SAML 2.0 only. There is no enterprise OIDC login. Never write
 *     "SAML/OIDC".
 */

export const hero = {
  eyebrow: 'Security',
  title: 'Built to survive a security review.',
  sub: 'An agent that can install anything, call anything and write anywhere is only safe if the walls are real. In Kortix they sit below the agent, in the platform, where a prompt cannot talk its way past them.',
  ctaPrimary: 'Talk to us',
  ctaPrimaryHref: '/contact',
  ctaSecondary: 'Read the docs',
  ctaSecondaryHref: '/docs',
  microline: 'One sandbox per session · Connector keys never enter it · Nothing merges itself',
  /** Four mono facts the rest of the page proves. Every value is defensible. */
  specs: [
    { k: 'Isolation', v: 'One sandbox per session', visual: 'isolation' },
    { k: 'Secrets', v: 'AES-256-GCM, key per project', visual: 'encrypt' },
    { k: 'Principals', v: 'People and service accounts', visual: 'principals' },
    { k: 'Path to main', v: 'Change request, default-deny merge', visual: 'diff' },
  ],
} as const;

/* ── 1 · isolation ─────────────────────────────────────────────────────────
   One sandbox per session is enforced by a UNIQUE constraint on
   session_sandboxes.session_id. One branch per session is the boot sequence.
   "microVM" is named ONLY for Platinum, which really is Cloud Hypervisor —
   see correction 2 in the header. */
/* ── 2 · credentials ───────────────────────────────────────────────────────
   Grounded in apps/api/src/projects/secrets.ts (AES-256-GCM, per-project key
   from HKDF-SHA256 over API_KEY_SECRET salted with the project id, versioned
   envelope), apps/api/src/iam/agent-scope.ts (the userRole ∩ agentGrant rule),
   apps/api/src/connectors/pipedream.ts (connector credentials resolved
   server-side), apps/api/src/projects/lib/sessions.ts
   (buildSessionSandboxEnvVars builds the sandbox env from project secrets, never
   from the API's own env) with apps/api/src/projects/lib/sandbox-env-names.ts
   (the names a sandbox never receives) and
   apps/kortix-sandbox-agent-server/src/harness/shared/agent-env-file.ts (tmpfs, 0600,
   shredded on shutdown).

   DO NOT reintroduce "the model never sees it" for project secrets. It is
   false, we know it is false, and a reviewer will disprove it in one command.
   The claim this section makes instead is narrower and actually holds. */
export const credentials = {
  eyebrow: 'Credentials',
  title: 'A key is granted to a session, not pasted into a prompt.',
  sub: 'A tool needs a real credential to do real work, so the honest question is not whether the machine ever holds one. It is which machine holds which key, who decided that, and what never gets in at all.',
  /** The five-step path a credential takes. Drawn as a mono flow. */
  flow: [
    { n: '01', k: 'Stored', v: 'Encrypted with AES-256-GCM under a key derived per project.' },
    {
      n: '02',
      k: 'Granted',
      v: 'The person’s role and the agent’s declared grant must both allow it.',
    },
    {
      n: '03',
      k: 'Delivered',
      v: 'Placed in the session at boot, by name, on tmpfs at mode 0600.',
    },
    {
      n: '04',
      k: 'Used',
      v: 'The tool reads it from the environment. It is not written into the prompt.',
    },
    {
      n: '05',
      k: 'Shredded',
      v: 'The file is wiped on shutdown and the machine is destroyed with it.',
    },
  ],
  rows: [
    {
      id: 'crypto',
      k: 'Encrypted per project',
      v: 'Values are sealed with AES-256-GCM. The key is derived per project with HKDF-SHA256, so one project’s ciphertext cannot be opened with another project’s key. The envelope is versioned, so the scheme can move forward without a flag day.',
    },
    {
      id: 'grant',
      k: 'Two gates, not one',
      v: 'An agent declares in kortix.yaml which secrets it may ever be given. A session receives the intersection of that grant and the role of the person who started it — so an agent can never reach past its own declaration, or past the human behind it.',
    },
    {
      id: 'connectors',
      k: 'Connector credentials never enter the machine',
      v: '3,000+ apps in a click, plus MCP, OpenAPI, GraphQL and raw HTTP. The third-party credential is held and resolved server-side; the machine holds one scoped Kortix token and calls through it. The same rule covers Kortix’s own provider keys, which no sandbox is allowed to hold.',
    },
    {
      id: 'honest',
      k: 'What we will not claim',
      v: 'A runtime secret a session is granted is a real environment value inside that session, because that is how a tool uses it. We would rather say so than tell you it is invisible. The controls that matter are the two gates above, and the fact that the machine is destroyed with it.',
    },
  ],
} as const;

/* ── 3 · identity & permissions ────────────────────────────────────────────
   Grounded in apps/api/src/accounts/iam/*. Resource types are the literal
   VALID_RESOURCE_TYPES list in iam/app.ts. Preset roles are role-presets.ts.
   Service accounts are iam/service-accounts.ts — "non-human IAM principals",
   evaluated purely against their own policies with no minter inheritance.
   The entitlement split is TierEntitlements in apps/api/src/types.ts. */
export const identity = {
  eyebrow: 'Identity & permissions',
  title: 'An agent is a principal, not a loophole.',
  sub: 'Most AI tools give the agent whatever the person who started it can reach. Kortix does not. An agent identity carries its own policies, evaluated on their own, so it cannot inherit its way up to something you never granted it.',
  /** The permission matrix, drawn from the shipped resource types + presets. */
  matrix: {
    caption: 'Permissions attach to a principal, for an action, on a resource type.',
    principals: ['person', 'group', 'service account'],
    resources: ['account', 'project', 'sandbox', 'trigger', 'channel', 'member', 'group'],
  },
  presets: {
    label: 'Built-in roles — on every plan',
    account: [
      { k: 'Owner', v: 'Full account control.' },
      { k: 'Admin', v: 'Manage members, groups, roles and tokens.' },
      { k: 'Member', v: 'Baseline account membership.' },
    ],
    project: [
      { k: 'Manager', v: 'Full project control, including members and delete.' },
      { k: 'Member', v: 'Read, run sessions and fire triggers. The project floor role.' },
    ],
  },
  enterprise: {
    label: 'Enterprise',
    /** Every item here is an entitlement key that really exists. SAML only —
        there is no enterprise OIDC login, so never write "SAML/OIDC". */
    items: [
      {
        k: 'SAML 2.0 SSO',
        v: 'Provider config, just-in-time provisioning, and group-claim mapping. One identity provider per account today.',
      },
      {
        k: 'SCIM 2.0',
        v: 'Directory sync over /scim/v2, with tokens you mint and revoke. Built against Okta and Microsoft Entra.',
      },
      {
        k: 'Custom roles',
        v: 'Your own roles and fine-grained policy bindings beyond the presets.',
      },
      { k: 'Groups', v: 'Grant to a group once instead of to twenty people twenty times.' },
    ],
    note: 'Available on Enterprise, and on a self-hosted instance with an Enterprise license. The built-in roles above are free on every plan.',
  },
  agents: {
    title: 'Service accounts',
    body: 'A service account is a first-class machine identity the account owns, not a human token wearing a hat. Policies attach to it directly, and a request it makes is evaluated purely against its own policies — it never inherits the reach of whoever created it.',
  },
  scoping: {
    title: 'Scope a team to specific agents',
    body: 'A person or a group can be narrowed to named agents and skills inside a project: marketing may use this agent and that skill, and nothing else. Anything you leave unscoped stays project-wide, so narrowing is something you opt into rather than something you have to undo.',
  },
} as const;

/* ── 4 · control ───────────────────────────────────────────────────────────
   Grounded in apps/api/src/projects/policies.ts. The YAML below is the real
   parsed shape: `match` globs over fully-qualified tool paths, three actions,
   and argument `conditions`. CORRECTION: default_mode falls back to `allow_all`
   for a project with no `policy:` block, so the copy tells you to set `risk`
   rather than claiming it is already on. */
/* ── 5 · change request ────────────────────────────────────────────────────
   Grounded in apps/api/src/projects/routes/change-request-actions.ts, which gates merge twice: the
   human capability `project.gitops.merge` and the per-agent `project.cr.merge`,
   which is DEFAULT-DENY. CORRECTION: "only a human can merge" is too strong —
   an admin can grant an agent that capability. The grant lives in kortix.yaml,
   so widening it is itself a merged change request. That is the real claim. */
/* ── 6 · audit ─────────────────────────────────────────────────────────────
   Grounded in TierEntitlements.auditAccess in apps/api/src/types.ts, which is
   explicit that RECORDING is never gated and only read/export/streaming is.
   Stated narrowly on purpose: this is the claim a reviewer will test first. */
/* ── 7 · deployment + posture ──────────────────────────────────────────────
   HONESTY GATE. SOC 2 Type I is held (the report has landed). SOC 2 Type II is
   IN PROGRESS. GDPR is a posture we operate, not a pending third-party
   certificate, so it has no state string. No ISO. No HIPAA. Do not add a badge
   here without a report to point at. */
/* ── disclosure ────────────────────────────────────────────────────────────
   The mailbox is ALREADY published publicly on
   /support (support/page.tsx), so naming it here adds no new exposure, and the
   three timelines below are the security disclosure policy, quoted exactly.
   ⚠️ BEFORE THIS PAGE GOES LIVE: security@kortix.com is
   a PLACEHOLDER that "must be created and monitored before this policy is
   published externally". Confirm the mailbox is real and watched, or cut the
   SLA rows — publishing a 3-day acknowledgement against an unread inbox is
   worse than publishing no timeline at all. */
export function getLocalizedSecurityContent(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(
    { hero, credentials, identity },
    tI18nComplete,
    SECURITY_SELFHOST_TRANSLATION_KEYS,
  );
}
