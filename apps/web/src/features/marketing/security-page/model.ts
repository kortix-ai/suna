import { MARKETING_RELEASE_TRANSLATION_KEYS } from '@/i18n/marketing-release-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';
/**
 * `/security` copy, laid out like the home page: hero with one walkthrough,
 * pillars, one tab per layer, the enforcement table, trust band, FAQ.
 *
 * Localized. `content.ts` keeps the older, translated copy that the
 * security deck (`presentations/decks/security.tsx`) still imports.
 *
 * Every line was checked on 2026-10-28 against the source named above its
 * block. When code and a doc disagree, the code wins. Standing rules
 * (kortix-brand `claims.md`):
 *  - Kortix does not filter a computer's general outbound traffic today.
 *    `agents.<name>.network_egress` validates and is not enforced
 *    (packages/manifest-schema/src/json-schema.ts; developers.mdx). Never
 *    write "every crossing out of the computer is checked".
 *  - A secret delivered as an environment variable is a real value in the
 *    computer. Only connector logins, Kortix's own provider keys and the
 *    value of an enforced secret stay out.
 *  - Connector approval rules are off until you set them (`default_mode`
 *    defaults to `allow_all`).
 *  - Merge is default-deny for agents, except the built-in `kortix` agent.
 *  - SOC 2 Type I verified. Never mention Type II. SAML 2.0 only.
 *  - "cloud computer" or "sandbox", never "container". No customer names;
 *    sample data uses the fictional Arcadia.
 */

/* Hero + walkthrough. Sources: guide.mdx "Agents" (an agent acts as itself;
   access is deny-by-default), "Computers", "Connectors", "Security", "Models",
   "Teams" (how work reaches the repository); developers.mdx "Permission
   rules"; framework/architecture-diagram.tsx CROSSINGS. */
export const hero = {
  title: 'Secure by construction.',
  titleMuted: 'Agents reach your tools only through gates you control.',
  sub: 'A person grants an agent access. The agent runs as itself on its own isolated computer. Kortix decides which keys reach that computer, and checks every app call, model call and change it makes.',
  caption: 'One computer per session.',
  captionMuted: 'Connector logins and Kortix’s model keys never enter it.',
} as const;

export type GateStep = {
  readonly id: string;
  readonly action: string;
  readonly gate: string;
  readonly resource: string;
  readonly line: string;
  /** Where the check runs, under the gate's name. */
  readonly where: string;
};

export const gates: readonly GateStep[] = [
  {
    id: 'tool',
    action: 'Run a command',
    gate: 'Tool rules',
    resource: 'Files and commands',
    line: 'The runtime checks allow, ask or deny before every tool runs.',
    where: 'Checked by the runtime, before the tool runs.',
  },
  {
    id: 'connector',
    action: 'Call an app',
    gate: 'Connector broker',
    resource: 'Your apps',
    line: 'Kortix holds the login, applies Allow, Ask or Block, and records the call.',
    where: 'Checked outside the computer.',
  },
  {
    id: 'secret',
    action: 'Use a key',
    gate: 'Secret broker',
    resource: 'Your APIs',
    line: 'An enforced secret is a stand-in. Kortix swaps in the real value outside the computer, for the hosts you list.',
    where: 'Checked outside the computer.',
  },
  {
    id: 'model',
    action: 'Ask a model',
    gate: 'LLM gateway',
    resource: 'Models',
    line: 'Every model request passes the gateway, which applies budgets and access rules and logs the cost.',
    where: 'Checked outside the computer.',
  },
  {
    id: 'change',
    action: 'Change the project',
    gate: 'Review',
    resource: 'Your repository',
    line: 'The agent pushes to its own branch. Its work reaches main through a change request.',
    where: 'Checked outside the computer.',
  },
];

/* Pillars. Sources: guide.mdx "Security", "Agents", "Computers",
   "Connectors", "Audit log"; apps/api/src/iam/agent-grant-ceiling.ts. */
export const pillars = {
  title: 'Four guarantees.',
  titleMuted: 'They hold whoever runs the agent.',
  items: [
    {
      id: 'computer',
      name: 'Its own computer',
      line: 'Every session runs isolated.',
      facts: [
        'One cloud computer per session',
        'Its own branch of the repository',
        'Nothing shared with another session',
      ],
    },
    {
      id: 'identity',
      name: 'Its own identity',
      line: 'An agent never borrows your role.',
      facts: [
        'Grants are deny-by-default',
        'It cannot grant itself more',
        'You choose who may run it',
      ],
    },
    {
      id: 'credentials',
      name: 'Logins stay out',
      line: 'Connector logins never enter the computer.',
      facts: [
        'Kortix makes each app call',
        'Secrets encrypted per project',
        'Enforced secrets swapped outside',
      ],
    },
    {
      id: 'record',
      name: 'Checked and recorded',
      line: 'Rules first, then the audit log.',
      facts: [
        'Allow, Ask or Block per action',
        'One approval per exact call',
        'Every action on record',
      ],
    },
  ],
} as const;

/* Layers. Each tab cites its sources.
   identity: guide.mdx "Teams" (role tables, groups, Agents: All / Only these),
     "Security" (2FA, session length, SAML SSO, SCIM, Enterprise).
   agent: guide.mdx "Agents" (acts as itself, deny-by-default, kortix agent);
     developers.mdx L380 (kortix_permissions and ceiling role; the starter's
     role is not an input), kortix.yaml example (agents.support);
     iam/agent-grant-ceiling.ts (403 agent_grant_escalation).
   computer: guide.mdx "Computers" (own branch, sleeps ~15–20 min);
     claims.md (Platinum is a Cloud Hypervisor microVM);
     projects/lib/sandbox-env-names.ts; developers.mdx token table
     (KORTIX_TOKEN = the agent of one session); json-schema.ts
     (network_egress not enforced).
   connectors: guide.mdx "Connectors" (approvals: one exact action, 24 h,
     manager or session starter); connectors/routes/gateway.ts (200, 202
     pending_approval, 403 denied); developers.mdx rule order.
   secrets: projects/secrets/envelope.ts (AES-256-GCM, HKDF per project);
     guide.mdx "Security" (audience, delivery); feature-flags/registry.ts
     (secrets_egress experimental); secrets/http-broker.test.ts ([REDACTED]).
   models: guide.mdx "Models".
   changes: developers.mdx "Git" (own branch; project.gitops.merge;
     CR_SELF_MERGE_REFUSED); guide.mdx "Agents" warning callout. */
export const layers = {
  title: 'How it works.',
  titleMuted: 'One layer at a time.',
  tabs: [
    {
      id: 'identity',
      title: 'Identity and roles',
      description: 'Who may open a project, and which agents they may run.',
      body: [
        'People sign in with SAML single sign-on, or a password with two-factor.',
        'Each person holds an account role and a role in each project. Groups grant a project to many people at once.',
      ],
    },
    {
      id: 'agent',
      title: 'Agent permissions',
      description: 'An agent acts as itself, with only what you grant.',
      body: [
        'Access is deny-by-default. An agent gets only the connectors, secrets and permissions its block in kortix.yaml lists.',
        'Your role does not lend it power. It cannot grant itself, or another agent, more than it holds.',
      ],
    },
    {
      id: 'computer',
      title: 'The computer and egress',
      description: 'Each session gets its own isolated cloud computer.',
      body: [
        'A Cloud Hypervisor microVM on Platinum, with its own branch. The agent installs and runs what its tool rules allow.',
        'Logins, Kortix’s model keys and enforced secret values never enter it. Other outbound traffic is not filtered today.',
      ],
    },
    {
      id: 'connectors',
      title: 'Connectors and approvals',
      description: 'Kortix holds the login and decides each call.',
      body: [
        'Each action is Allow, Ask or Block. Ask holds the call until a project manager or the person who started the session decides.',
        'An approval covers one exact call and expires after 24 hours by default.',
      ],
    },
    {
      id: 'secrets',
      title: 'Secrets',
      description: 'Encrypted per project, delivered only where allowed.',
      body: [
        'Values are encrypted with AES-256-GCM under a key per project. No page or API shows a stored value again.',
        'A session gets a secret only when its audience and the agent’s grant both allow it.',
      ],
    },
    {
      id: 'models',
      title: 'Models',
      description: 'Every model request passes one gateway.',
      body: [
        'The agent calls models through the Kortix LLM gateway. It applies budgets and access rules, and reports the cost.',
        'Use your own provider keys, or Kortix-managed models served with zero data retention.',
      ],
    },
    {
      id: 'changes',
      title: 'Changes and review',
      description: 'Work reaches main through a change request.',
      body: [
        'A session pushes only its own branch. A person reads the change request and merges it.',
        'Merge is default-deny for agents. The built-in kortix agent may merge its own; remove that permission to require a person.',
      ],
    },
  ],
} as const;

/* Tab visuals. */
export const roles = {
  account: ['Owner', 'Admin', 'Member'],
  project: ['Manager', 'Member'],
  signIn: ['SAML 2.0 SSO', 'SCIM 2.0', 'Two-factor', 'Session timeout'],
} as const;

/* The agents.support block of the kortix.yaml example in developers.mdx. */
export const agentYaml = {
  title: 'kortix.yaml',
  lines: [
    'agents:',
    '  support:',
    '    permission:',
    '      bash:',
    '        "*": allow',
    '        "git push *": ask',
    '    connectors: [helpdesk]',
    '    secrets: [HELPDESK_TOKEN]',
    '    kortix_permissions: [project.gitops.push]',
  ],
} as const;

export const computerBox = {
  holds: [
    'The project on its own branch',
    'KORTIX_TOKEN, for this agent only',
    'Secrets granted to it',
  ],
  never: ['Connector logins', 'Kortix’s model provider keys', 'Enforced secret values'],
} as const;

/* A fictional held call (sample data: Arcadia). */
export const approval = {
  call: 'gmail.send_email',
  args: [
    { k: 'to', v: 'board@arcadia.example' },
    { k: 'subject', v: 'Q3 forecast' },
  ],
  who: 'Waiting for a project manager',
  expires: 'Expires in 24 h',
} as const;

export const secretModes = [
  {
    k: 'Environment variable',
    v: 'The real value. Code in the session can read it.',
    tag: 'default',
  },
  { k: 'Enforced', v: 'A stand-in. Swapped outside, for listed hosts only.', tag: 'experimental' },
  { k: 'Disabled', v: 'Kept on file. Reaches no session.', tag: '' },
] as const;

export const modelPath = [
  { k: 'Agent', v: 'In its computer' },
  { k: 'LLM gateway', v: 'Budgets, access rules, cost' },
  { k: 'Model provider', v: 'Your key, or Kortix-managed' },
] as const;

export const changePath = [
  { k: 'Session branch', chip: 'own branch only' },
  { k: 'Change request', chip: 'project.gitops.push' },
  { k: 'A person merges', chip: 'project.gitops.merge' },
] as const;

/* What enforces what. Sources: developers.mdx status codes and error table;
   iam/actor.ts, iam/authorize.ts, iam/agent-grant-ceiling.ts;
   connectors/routes/gateway.ts; connectors/egress.ts;
   secrets/network-boundary.ts; harness README (runtime permission check). */
export const enforcement = {
  title: 'What enforces each rule.',
  titleMuted: 'All but one run outside the computer.',
  head: ['Rule', 'Enforced by', 'On deny'],
  rows: [
    ['A valid credential', 'Kortix API', '401'],
    ['A role that allows the action', 'Kortix API, IAM', '403, or 404 if hidden'],
    ['The agent’s own permissions', 'Kortix API, IAM', '403'],
    ['No self-granted permissions', 'Kortix API, IAM', '403 agent_grant_escalation'],
    ['Tool, command and path rules', 'Runtime, inside the computer', 'Ask waits, deny refuses'],
    ['Connector rules', 'Connector broker', '202 held, 403 denied'],
    ['No connector calls to private addresses', 'Connector broker', 'connector_egress_blocked'],
    ['Enforced secret, listed hosts only', 'Secret broker', 'Not swapped'],
    ['Push only to its own branch', 'Kortix git', '403'],
    ['Merge needs project.gitops.merge', 'Kortix API', '403 CR_SELF_MERGE_REFUSED'],
  ],
} as const;

/* Trust band. Sources: claims.md (Compliance, Hosting, Source, SSO rows);
   guide.mdx "Run Kortix on your own infrastructure". */
export const trust = {
  title: 'Run it where your policy says.',
  titleMuted: 'And read every line of what you run.',
  cells: [
    { k: 'Kortix Cloud', v: 'We run the control plane and the computers.' },
    { k: 'Self-hosted', v: 'The app, API and database on your server.' },
    { k: 'Your VPC or on-prem', v: 'A single-tenant deployment, scoped with us.' },
    { k: 'Open source', v: 'Read it, fork it, audit it.' },
    { k: 'SAML 2.0 and SCIM 2.0', v: 'Your identity provider decides who gets in.' },
    { k: 'Any model', v: 'Your own provider keys, or Kortix-managed.' },
  ],
  seal: 'SOC 2 Type I verified',
  sealNote: 'GDPR operated. We hold no other certification and imply none.',
} as const;

/* FAQ. Sources per answer: developers.mdx token table and status codes;
   guide.mdx "Connectors", "Security", "Audit log", "Models", "Computers",
   "Run Kortix on your own infrastructure", "Agents"; json-schema.ts
   (network_egress); sandbox-egress-pin.ts; connectors/egress.ts. */
export const faqItems = [
  {
    id: 'faq-agent-token',
    question: 'How does an agent authenticate to Kortix?',
    answer:
      'Each session computer gets KORTIX_TOKEN. It acts as that session’s agent, limited to its project, and ends with the session. It holds the agent’s permissions, never the role of the person who started it.',
  },
  {
    id: 'faq-keys',
    question: 'Which API keys and tokens exist?',
    answer:
      'Every credential names its kind in its prefix: kortix_pat_ acts as you, kortix_sa_ as a service account, kortix_oat_ as a person who approved an app for 1 hour, kortix_gw_ reaches only the LLM gateway, and kortix_scim_ only directory sync. A missing or invalid token gets 401. A valid one without the permission gets 403.',
  },
  {
    id: 'faq-connector-login',
    question: 'Can an agent read our connector logins?',
    answer:
      'No. Kortix stores the login and makes each call itself. The login never enters the session’s computer.',
  },
  {
    id: 'faq-secret-read',
    question: 'Can code in a session read a secret?',
    answer:
      'A secret delivered as an environment variable is a real value, so code in the session can read it. Mark a web API key Enforced and the computer gets a stand-in instead. Kortix swaps in the real value outside the computer, only on requests to the hosts you list, and an echoed value comes back as [REDACTED].',
  },
  {
    id: 'faq-egress',
    question: 'Does Kortix filter outbound network traffic?',
    answer:
      'Not today. A computer can reach the internet directly, for example to install packages. What Kortix enforces: enforced secrets go only to listed hosts, connector calls never reach private addresses, and a copied session token gets no enforced secret outside its own computer.',
  },
  {
    id: 'faq-approve',
    question: 'Who can approve a held action?',
    answer:
      'A project manager, or the person who started the session. An approval covers one exact call. A held call expires after 24 hours unless the project sets another time, from 5 minutes to 30 days.',
  },
  {
    id: 'faq-merge',
    question: 'Can an agent merge its own changes?',
    answer:
      'Only with the project.gitops.merge permission. Without it, the merge answers 403. The built-in kortix agent holds every Kortix permission, so remove the merge permission from it to require a person every time.',
  },
  {
    id: 'faq-audit',
    question: 'What does the audit log record, and can we export it?',
    answer:
      'Who did what, when, how they signed in, and whether it was allowed, refusals included. When an agent acts, the row names the person it acted for. Events stay readable for 90 days and sit in a locked archive to day 365. Reading, exporting and streaming the log is an Enterprise feature.',
  },
  {
    id: 'faq-retention',
    question: 'Do the models keep our data?',
    answer:
      'Kortix-managed models run only through inference providers with zero data retention. With your own provider key, your agreement with that provider applies.',
  },
  {
    id: 'faq-selfhost',
    question: 'Where does a self-hosted Kortix run sessions?',
    answer:
      'The web app, API and database run on your server. Sessions still run on Platinum cloud computers, which call back to your server, so it must be reachable from the internet.',
  },
] as const;

export function localizeMarketingContent(tMarketing: import('@/i18n/translator').UiTranslator) {
  return localizeUiCatalog(
    {
      hero,
      gates,
      pillars,
      layers,
      roles,
      agentYaml,
      computerBox,
      approval,
      secretModes,
      modelPath,
      changePath,
      enforcement,
      trust,
      faqItems,
    },
    tMarketing,
    MARKETING_RELEASE_TRANSLATION_KEYS,
  );
}
