/**
 * `/security` copy — the page a security reviewer reads.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `comms` skill. ACCURACY GATE for this page specifically —
 * every line below traces to shipped code, and the citation is in the comment
 * above it. This is the page an enterprise reviewer will hold us to.
 *
 *  - SOC 2 is IN PROGRESS. Never "compliant", never "certified". No ISO, no
 *    HIPAA — we do not hold them. GDPR is a posture we run, not a third-party
 *    certificate, so it carries no "in progress" state.
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
 *     a tool uses it. See docs/ENV_SECRET_EXPOSURE_BASELINE.md, which states it
 *     plainly. What IS true, and is all this page claims: connector credentials
 *     are resolved server-side and never enter the machine, Kortix's own
 *     upstream keys never enter it either, and a session only receives the
 *     secrets both the person's role and the agent's declared grant allow.
 *  2. "Each session runs in its own VM" / blanket "microVM" is NOT true of the
 *     DEFAULT provider. Platinum is a Cloud Hypervisor microVM; Daytona, the
 *     default, is not. The copy claims one isolated sandbox per session, and
 *     names microVM only where it is accurate.
 *  3. "Egress controlled at the network" (a `comms` proof point) is NOT
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
export const isolation = {
  eyebrow: 'Isolation',
  title: 'Nothing is shared, because nothing is shared.',
  sub: 'A session is not a tab in a shared runtime. It is a machine of its own, and the database will not let two sessions have the same one. Separating two of your own sessions is the same mechanism as separating two different customers.',
  /** The boundary diagram: what is inside a session, and what stays out. */
  inside: {
    label: 'inside one session',
    items: [
      'Its own sandbox, with its own filesystem and its own lifetime',
      'A clone of the project repo on a branch named after the session',
      'The tools, dependencies and runtime the project declares',
      'Only the secrets that session is granted, placed there at boot',
    ],
  },
  outside: {
    label: 'never crosses in',
    items: [
      'Another session — same project, same team, or another customer',
      'Connector credentials, which are resolved server-side',
      'Kortix’s own upstream provider keys, which no sandbox may hold',
      'Write access to main; a session can only propose',
    ],
  },
  rows: [
    {
      id: 'sandbox',
      k: 'One sandbox per session',
      v: 'A session gets exactly one machine, enforced in the database rather than by convention. Sessions never share a filesystem with each other, and the machine has a bounded lifetime rather than living forever.',
    },
    {
      id: 'microvm',
      k: 'microVM where you ask for it',
      v: 'On Kortix’s own Platinum compute a sandbox is a Cloud Hypervisor microVM. Daytona and E2B are also supported. The provider is a deployment choice, and we will tell you which one you are on rather than blur them together.',
    },
    {
      id: 'branch',
      k: 'One branch per session',
      v: 'The machine clones the repo and cuts a branch named after the session. Every edit and commit that session makes lives on that branch and nowhere else.',
    },
    {
      id: 'disposable',
      k: 'Disposable by design',
      v: 'The machine is not precious. A bad install or a wiped directory goes away with it. Only what the session commits survives.',
    },
  ],
} as const;

/* ── 2 · credentials ───────────────────────────────────────────────────────
   Grounded in apps/api/src/projects/secrets.ts (AES-256-GCM, per-project key
   from HKDF-SHA256 over API_KEY_SECRET salted with the project id, versioned
   envelope), apps/api/src/iam/agent-scope.ts (the userRole ∩ agentGrant rule),
   apps/api/src/connectors/pipedream.ts (connector credentials resolved
   server-side), apps/api/src/platform/sandbox-env.ts (the allowlist that keeps
   Kortix's own upstream keys out of every sandbox) and
   apps/kortix-sandbox-agent-server/src/agent-env-file.ts (tmpfs, 0600,
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
    note: 'Available on Enterprise, and on a self-hosted instance with an Enterprise licence. The built-in roles above are free on every plan.',
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
export const control = {
  eyebrow: 'Control',
  title: 'Decide what needs a human before it happens.',
  sub: 'Approval is not a setting buried in an admin panel. It is a block in kortix.yaml, versioned with everything else, that says which tool calls run, which stop for a person, and which are refused outright.',
  yaml: {
    title: 'kortix.yaml',
    lines: [
      '# reads run; writes and destructive calls stop for a human',
      'policy:',
      '  default_mode: risk',
      '',
      'policies:',
      '  # a name-only rule cannot gate the target — conditions can',
      '  - match: gmail.send_email',
      '    action: require_approval',
      '    conditions:',
      '      - arg: to',
      '        match: /@example\\.com$/',
      '',
      '  # anything else through this tool is refused outright',
      '  - match: gmail.send_email',
      '    action: block',
      '',
      '  # whole connectors can be gated with one glob',
      '  - match: stripe.*',
      '    action: require_approval',
    ],
  },
  notes: [
    {
      id: 'actions',
      k: 'Three actions',
      v: 'always_run, require_approval, block. A rule matches a glob over fully-qualified tool paths, so one line can cover a single call or a whole connector.',
    },
    {
      id: 'conditions',
      k: 'Gate the target, not just the tool',
      v: '"May the agent send email" is not a guardrail. Conditions match the arguments, so the rule can be "only to these addresses". An argument that cannot be evaluated fails closed.',
    },
    {
      id: 'percall',
      k: 'No blanket "allow always"',
      v: 'Every gated call is approved on its own, with its arguments in front of you. There is no session-wide grant a later call with different arguments can hide behind — that shortcut was removed at the enforcement point, not just from the UI.',
    },
    {
      id: 'default',
      k: 'Set the default you want',
      v: 'default_mode: risk makes reads run and sends writes and destructive calls to a person. A project with no policy block keeps the permissive legacy default, so set this explicitly.',
    },
  ],
} as const;

/* ── 5 · change request ────────────────────────────────────────────────────
   Grounded in apps/api/src/projects/routes/r9.ts, which gates merge twice: the
   human capability `project.gitops.merge` and the per-agent `project.cr.merge`,
   which is DEFAULT-DENY. CORRECTION: "only a human can merge" is too strong —
   an admin can grant an agent that capability. The grant lives in kortix.yaml,
   so widening it is itself a merged change request. That is the real claim. */
export const landing = {
  eyebrow: 'How work lands',
  title: 'Opening a change request and merging it are different powers.',
  sub: 'An agent can write as much as it likes on its own branch. Landing that work on main is a separate capability it does not have unless you hand it over deliberately — and handing it over is itself a change someone has to approve.',
  steps: [
    {
      n: '00',
      title: 'The session works on its branch',
      body: 'Every edit lands on the branch cut for that session. Nothing the agent does is visible to any other session, or to main.',
    },
    {
      n: '01',
      title: 'It commits and opens a change request',
      body: 'When the agent wants something to survive the machine, it commits and opens a change request pointed at main. That is the only door.',
    },
    {
      n: '02',
      title: 'A person reads the diff',
      body: 'A change request is a diff. An agent rewriting its own prompt is reviewed the same way a code change is — because it is one. A change request whose manifest does not validate cannot merge at all.',
    },
    {
      n: '03',
      title: 'Merging is default-deny',
      body: 'Merge is a capability of its own, refused to every agent unless an admin grants it. That grant lives in kortix.yaml — so an agent cannot widen its own reach without a change request someone else approves.',
    },
  ],
} as const;

/* ── 6 · audit ─────────────────────────────────────────────────────────────
   Grounded in TierEntitlements.auditAccess in apps/api/src/types.ts, which is
   explicit that RECORDING is never gated and only read/export/streaming is.
   Stated narrowly on purpose: this is the claim a reviewer will test first. */
export const audit = {
  eyebrow: 'Audit',
  title: 'Recording is never the thing you pay for.',
  sub: 'Every account action and every agent action is captured on every plan. The plan decides who may read, export, or stream that record — not whether it exists.',
  rows: [
    {
      id: 'account',
      k: 'Account audit log',
      v: 'Membership, roles, policies, tokens, groups and IAM changes are recorded as they happen, on every plan.',
    },
    {
      id: 'agent',
      k: 'Every gated tool call',
      v: 'Each call an agent makes through a connector is a row: the action, the actor, the session, the risk class, whether it ran, was denied, or waited for a person, and who resolved it. Arguments are stored as a preview built by subtraction, so a credential cannot end up in the record.',
    },
    {
      id: 'stream',
      k: 'Export it or stream it',
      v: 'Pull the log as CSV or JSONL, or have every event posted to your own SIEM over a webhook signed with HMAC-SHA256. Read, export and streaming are Enterprise entitlements.',
    },
    {
      id: 'diff',
      k: 'The repo is its own history',
      v: 'Configuration is files. Who changed which agent, which skill and which policy, and who approved it, is git history you already know how to read.',
    },
  ],
} as const;

/* ── 7 · deployment + posture ──────────────────────────────────────────────
   HONESTY GATE. SOC 2 Type I and Type II are IN PROGRESS. GDPR is a posture we
   operate, not a pending third-party certificate, so it has no state string.
   No ISO. No HIPAA. Do not add a badge here without a report to point at. */
export const posture = {
  eyebrow: 'Deployment & posture',
  title: 'Run it where your policy says it has to run.',
  sub: 'The same product ships as managed cloud, as a stack inside your own network, and as an isolated deployment. Open source, so what you are trusting is code you can read.',
  deployments: [
    {
      id: 'cloud',
      k: 'Kortix Cloud',
      v: 'The managed service. We run the control plane and the compute; you run the company.',
    },
    {
      id: 'selfhost',
      k: 'Self-hosted',
      v: 'One Docker Compose stack on your box, from the same images the managed cloud runs. Your database and your files sit on disk you control.',
    },
    {
      id: 'vpc',
      k: 'Your VPC or on-prem',
      v: 'A single-tenant deployment inside your own network. Air-gapped and other isolated topologies are scoped with us rather than self-served.',
    },
  ],
  compliance: {
    label: 'Where we actually stand',
    /** Never move an item out of "In progress" without the report in hand. */
    items: [
      { k: 'SOC 2 Type I', v: 'In progress' },
      { k: 'SOC 2 Type II', v: 'In progress' },
      { k: 'GDPR', v: 'Operated' },
    ],
    note: 'We do not hold ISO 27001 or HIPAA, and we do not imply that we do. When a report lands, this line changes that day and not before.',
  },
} as const;

/* ── disclosure ────────────────────────────────────────────────────────────
   Grounded in docs/SECURITY.md. The mailbox is ALREADY published publicly on
   /support (support/page.tsx), so naming it here adds no new exposure, and the
   three timelines below are that document's policy quoted exactly.
   ⚠️ BEFORE THIS PAGE GOES LIVE: docs/SECURITY.md marks security@kortix.com as
   a PLACEHOLDER that "must be created and monitored before this policy is
   published externally". Confirm the mailbox is real and watched, or cut the
   SLA rows — publishing a 3-day acknowledgement against an unread inbox is
   worse than publishing no timeline at all. */
export const disclosure = {
  eyebrow: 'Responsible disclosure',
  title: 'Found something? Tell us privately.',
  sub: 'Please do not open a public issue for a vulnerability. Mail the security contact with the affected version or commit, the reproduction, and the impact.',
  email: 'security@kortix.com',
  slas: [
    { k: 'Acknowledgement', v: 'Within 3 business days' },
    { k: 'Triage & severity', v: 'Within 5 business days' },
    { k: 'Coordinated disclosure', v: 'Agreed with you, 90 days by default' },
  ],
  credit: 'We credit reporters who want it, once a fix has shipped.',
} as const;

export const closing = {
  eyebrow: 'Talk to us',
  title: 'Bring us your security review.',
  sub: 'Send the questionnaire, the architecture questions, the deployment constraints. We would rather answer them properly than have you guess from a marketing page.',
  ctaPrimary: 'Talk to us',
  ctaPrimaryHref: '/contact',
  ctaSecondary: 'See enterprise',
  ctaSecondaryHref: '/enterprise',
} as const;
