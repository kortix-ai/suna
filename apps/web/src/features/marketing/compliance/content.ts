import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';
/**
 * `/compliance` copy: the page for IT and compliance reviewers, laid out like
 * the home page: a hero with one walkthrough of the admin view, four pillars,
 * one tab per topic, the trust band, the FAQ. Localized. The buyer story
 * (rollout, hosting, models, contract) lives on /enterprise.
 *
 * Every line was checked on 2026-10-28 against the source named above its
 * block. When code and a doc disagree, the code wins. Standing rules
 * (kortix-brand `claims.md`):
 *  - Enterprise is a feature layer on Free or Credits, not a plan that
 *    replaces them (billing skill, references/plans-and-access.md).
 *  - SAML 2.0 only, never OIDC. SOC 2 Type I verified, never Type II.
 *  - Approval rules are off until you set them (`default_mode` defaults to
 *    `allow_all`). Never write "risky calls pause by default".
 *  - Kortix does not filter a cloud computer's outbound traffic. No egress
 *    claim. Never "air-gapped".
 *  - No price references, no unmeasured metrics, no license names, no
 *    customer names. Sample data is the fictional Arcadia; people are
 *    initials or "Member N".
 *  - Depth on isolation and secrets lives on /security; hosting and the
 *    contract live on /enterprise. Link there; do not repeat it.
 */

/* Hero. Sources: guide.mdx "Teams", "Security" (Single sign-on and
   directory sync, Audit log), "Billing → Enterprise"; account-hub-content.tsx
   (Identity pane under Account settings). */
export const hero = {
  title: 'Compliance and control.',
  titleMuted: 'Your sign-in, your roles, your audit trail.',
  sub: 'What IT and compliance reviewers ask about: how people sign in, who may run which agent, which actions wait for a person, and what gets recorded.',
  caption: 'One account for the whole company.',
  captionMuted: 'Owners and admins set it up in Account settings.',
} as const;

export type StepId = 'sso' | 'directory' | 'access' | 'approvals' | 'audit';

export type Step = { readonly id: StepId; readonly label: string; readonly line: string };

/* Steps. Sources:
   sso: guide.mdx "Single sign-on and directory sync" (Enforce SSO for this
     domain); accounts/iam/sso.ts (DNS domain verification, enforce_sso).
   directory: guide.mdx same section (SCIM adds, updates, removes members and
     groups); scim/groups.ts; sso.ts group mappings.
   access: guide.mdx "Teams → Set it up" (Manager or Member, an end date,
     Agents: All agents or Only these…), "Groups".
   approvals: guide.mdx "Connectors → Approving a held action" (project
     manager or session starter, one exact action, 24 h).
   audit: guide.mdx "Audit log"; accounts/audit.ts (export, webhooks);
     shared/audit-webhooks.ts (X-Kortix-Signature, HMAC-SHA256). */
export const steps: readonly Step[] = [
  {
    id: 'sso',
    label: 'Sign-in',
    line: 'People sign in through your identity provider. Enforce it, and no other way in works for your domain.',
  },
  {
    id: 'directory',
    label: 'Directory',
    line: 'Your directory adds and removes people and groups. Someone who leaves loses access here too.',
  },
  {
    id: 'access',
    label: 'Access',
    line: 'Grant a project to a group. Each grant names the agents its people may run.',
  },
  {
    id: 'approvals',
    label: 'Approvals',
    line: 'An action you marked Ask waits for a person. One approval covers one exact call.',
  },
  {
    id: 'audit',
    label: 'Audit',
    line: 'Every action is recorded, refusals included. Stream it to your security tools as it happens.',
  },
];

/** Account settings → Identity. */
export const ssoRows = [
  { k: 'SAML 2.0 single sign-on', v: 'Your identity provider', status: 'Connected' },
  { k: 'Domain', v: 'arcadia.example', status: 'Verified' },
  { k: 'Enforce SSO for this domain', v: 'Other ways to sign in stop working', status: 'On' },
  { k: 'Directory sync (SCIM 2.0)', v: 'Members and groups', status: 'Syncing' },
] as const;

/** Groups synced from the directory. Fictional counts. */
export const groupRows = [
  { k: 'Engineering', v: '14 members · 3 projects' },
  { k: 'Support', v: '9 members · 1 project' },
  { k: 'Finance', v: '5 members · 2 projects' },
] as const;

/** Access to one project. */
export const accessProject = 'Support desk';
export const accessRows = [
  { who: 'Support', kind: 'group', role: 'Member', agents: 'Only support-triage' },
  { who: 'Engineering', kind: 'group', role: 'Manager', agents: 'All agents' },
  { who: 'Member 7', kind: 'person', role: 'Member', agents: 'All agents · ends Dec 31' },
] as const;

/** A held call. Fictional values. */
export const heldCall = {
  call: 'gmail.send_email',
  agent: 'support-triage',
  args: [
    { k: 'to', v: 'renewals@arcadia.example' },
    { k: 'subject', v: 'Your renewal' },
  ],
  who: 'Waiting for a project manager',
  expires: 'Expires in 24 h',
} as const;

/** Audit rows. Real action and outcome names (apps/api/src); people are initials. */
export const auditRows = [
  { t: '09:41', who: 'M.K.', action: 'connector.approval.approved', result: 'success' },
  { t: '09:33', who: 'support-triage, for M.K.', action: 'connector.call', result: 'denied' },
  { t: '09:12', who: 'Directory sync', action: 'scim.user.create', result: 'success' },
  { t: '08:55', who: 'A.R.', action: 'auth.login.success', result: 'success' },
] as const;
export const auditStream = 'Streaming to siem.arcadia.example · signed';

/* Pillars. Sources: guide.mdx "Teams" (roles, groups, agents per grant),
   "Security" (SSO, SCIM, Enforce SSO, Audit log), "Connectors → Allow, Ask,
   Block"; developers.mdx "Connector rules and approvals" (a set cannot
   loosen a project rule); accounts/iam/custom-roles.ts; accounts/audit.ts. */
export const pillars = {
  title: 'Four things IT asks for.',
  titleMuted: 'Each one ships in the product.',
  items: [
    {
      id: 'identity',
      name: 'Your identity provider',
      line: 'People sign in the way they already do.',
      facts: ['SAML 2.0 single sign-on', 'SCIM 2.0 directory sync', 'Enforce SSO for your domain'],
    },
    {
      id: 'access',
      name: 'Your roles and groups',
      line: 'Who opens which project, and runs which agent.',
      facts: [
        'Account and project roles',
        'Groups and custom roles',
        'All agents, or only the ones you pick',
      ],
    },
    {
      id: 'governance',
      name: 'Rules you set',
      line: 'Agents ask before the actions you choose.',
      facts: [
        'Allow, Ask or Block per action',
        'Project rules no agent can loosen',
        'One approval per exact call',
      ],
    },
    {
      id: 'audit',
      name: 'A record you keep',
      line: 'Every action, exported or streamed.',
      facts: ['Refusals recorded too', 'CSV or JSONL export', 'A signed webhook to your tools'],
    },
  ],
} as const;

/* Topics, one tab each.
   identity: guide.mdx "Single sign-on and directory sync"; sso.ts group
     mappings (claim value → Kortix group, synced on sign-in); scim/index.ts
     (request patterns Okta and Azure AD use).
   access: guide.mdx "Teams" (account and project roles, groups, Agents: All
     agents or Only these…, an end date); accounts/iam/custom-roles.ts (custom
     roles are action sets bound to a member, group or token at a scope).
   governance: guide.mdx "Allow, Ask, Block" and "Approving a held action";
     developers.mdx "Connector rules and approvals" (order; a set cannot loosen
     a project rule), `policy_sets`; claims.md Approval gates row.
   audit: guide.mdx "Audit log"; accounts/audit.ts (CSV, JSONL, webhooks,
     delivery replay); shared/audit-webhooks.ts (HMAC-SHA256).
   */
export const topics = {
  title: 'How it works.',
  titleMuted: 'One topic at a time.',
  tabs: [
    {
      id: 'identity',
      title: 'Single sign-on and directory sync',
      description: 'Your identity provider decides who gets in.',
      body: [
        'People sign in with SAML 2.0 single sign-on. Enforce it, and other ways to sign in for your domain stop working.',
        'SCIM 2.0 keeps members and groups in sync. Map an identity provider group to a Kortix group once.',
      ],
    },
    {
      id: 'access',
      title: 'Roles, groups and agents',
      description: 'Who opens which project, and runs which agent.',
      body: [
        'Each person holds an account role and a role in each project. Grant a project to a group, and everyone in it gets it.',
        'Each grant names the agents its people may run. Custom roles allow only the actions you pick.',
      ],
    },
    {
      id: 'governance',
      title: 'Approvals and policy',
      description: 'Rules in kortix.yaml, reviewed like code.',
      body: [
        'Each connector action is Allow, Ask or Block. Project rules run first, and no agent’s rule set can loosen them.',
        'Ask holds the call until a project manager or the session’s starter decides. Rules are off until you set them.',
      ],
    },
    {
      id: 'audit',
      title: 'Audit log',
      description: 'Read it, export it, stream it.',
      body: [
        'Kortix records who did what, when, how they signed in, and whether it was allowed. An agent’s row names the person it acted for.',
        'Export CSV or JSONL, or stream each new event to a signed webhook. Events stay readable for 90 days, then sit in a locked archive to day 365.',
      ],
    },
  ],
} as const;

export type TopicId = (typeof topics.tabs)[number]['id'];

/** sso.ts group mappings: a claim value from the identity provider → a Kortix group. */
export const groupMappings = [
  { claim: 'arcadia-eng', group: 'Engineering' },
  { claim: 'arcadia-support', group: 'Support' },
  { claim: 'arcadia-fin', group: 'Finance' },
] as const;

/** guide.mdx "Teams": account and project roles. */
export const roleTable = [
  { scope: 'Account', roles: ['Owner', 'Admin', 'Member'] },
  { scope: 'Project', roles: ['Manager', 'Member'] },
  { scope: 'Custom', roles: ['Your own actions'] },
] as const;

/** developers.mdx "Connector rules and approvals": project rules, then an agent's set. */
export const policyYaml = {
  title: 'kortix.yaml',
  lines: [
    '# project rules run first',
    'policies:',
    '  - match: gmail.send_email',
    '    action: require_approval',
    '  - match: "helpdesk.delete_*"',
    '    action: block',
    '',
    '# a read-only rule set for one agent',
    'agents:',
    '  support-triage:',
    '    policy_sets:',
    '      helpdesk: read-only',
  ],
} as const;

/** accounts/audit.ts and shared/audit-webhooks.ts. */
export const auditOutputs = [
  { k: 'Read', v: 'Account settings → Audit log, filtered by person, action or outcome.' },
  { k: 'Export', v: 'CSV or JSONL.' },
  {
    k: 'Stream',
    v: 'Each new event to your webhook, signed with HMAC-SHA256. Failed deliveries can be replayed.',
  },
] as const;

/* Trust band. Sources: claims.md Hosting, Source, Compliance rows;
   security-page/model.ts trust cells. */
export const trust = {
  title: 'Ready for your security review.',
  titleMuted: 'Run it where your policy says, and read every line.',
  /* The security model and the buyer page carry the depth. */
  cells: [
    { k: 'Kortix Cloud', v: 'We run the platform and the cloud computers.' },
    { k: 'Self-hosted', v: 'The app, the API and the database on your server.' },
    { k: 'Your VPC or on-prem', v: 'A single-tenant deployment, scoped with us.' },
    { k: 'Open source', v: 'Read it, fork it, audit it.' },
  ],
  seal: 'SOC 2 Type I verified',
  sealNote: 'GDPR operated. The security page has the full model.',
} as const;

/* FAQ. Sources per answer:
   idp: claims.md SSO row; scim/index.ts; guide.mdx "Single sign-on and
     directory sync" (team account).
   leave: guide.mdx "Single sign-on and directory sync".
   ends: billing plans-and-access.md principle 6 and License contracts.
   agent-identity: guide.mdx "Agents" (acts as itself, cannot grant itself).
   approvals: claims.md Approval gates row; guide.mdx "Allow, Ask, Block".
   audit: guide.mdx "Audit log"; accounts/audit.ts.
   oversight: accounts/iam/session-oversight.ts.
   soc2: claims.md Compliance row.
   selfhost: guide.mdx "Run Kortix on your own infrastructure". */
export const faqItems = [
  {
    id: 'compliance-idp',
    question: 'Which identity providers work?',
    answer:
      'Sign-in uses SAML 2.0. Directory sync uses SCIM 2.0 and covers the request patterns Okta and Microsoft Entra ID use. Both need a team account, not the personal account Kortix creates at sign-up.',
  },
  {
    id: 'compliance-leave',
    question: 'What happens when someone leaves the company?',
    answer:
      'Remove them in your identity provider. Directory sync removes them from Kortix, and they lose access to every project.',
  },
  {
    id: 'compliance-agent',
    question: 'Does an agent act with the role of the person who runs it?',
    answer:
      'No. An agent acts as itself, with only the access its block in kortix.yaml grants. It cannot give itself a permission it does not hold.',
  },
  {
    id: 'compliance-approvals',
    question: 'Do agents ask for approval by default?',
    answer:
      'No. Approval rules are off until you set them. Mark an action Ask, or mark a whole connector sensitive, and those calls wait for a person.',
  },
  {
    id: 'compliance-audit',
    question: 'How long is the audit log kept?',
    answer:
      'Events stay readable for 90 days. Events from 90 to 365 days old sit in a locked archive that nobody can shorten or delete, and you can export them.',
  },
  {
    id: 'compliance-oversight',
    question: 'Can admins open every session?',
    answer:
      'Only if an account owner turns on session oversight. It is off by default. Each change to it is recorded, and so is each session read that only oversight allowed.',
  },
  {
    id: 'compliance-ends',
    question: 'What happens if our Enterprise contract ends?',
    answer: 'Single sign-on and directory sync stay on for 14 days, so nobody is locked out.',
  },
  {
    id: 'compliance-soc2',
    question: 'Which certifications does Kortix hold?',
    answer: 'SOC 2 Type I verified. GDPR is a posture we run, not a certificate.',
  },
  {
    id: 'compliance-selfhost',
    question: 'Do these controls work on a self-hosted instance?',
    answer: 'Yes. On a self-hosted instance, Enterprise turns them on for every account.',
  },
] as const;

export function localizeMarketingContent(tMarketing: import('@/i18n/translator').UiTranslator) {
  return localizeUiCatalog(
    {
      hero,
      steps,
      ssoRows,
      groupRows,
      accessProject,
      accessRows,
      heldCall,
      auditRows,
      auditStream,
      pillars,
      topics,
      groupMappings,
      roleTable,
      policyYaml,
      auditOutputs,
      trust,
      faqItems,
    },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );
}
