/**
 * The /enterprise page, condensed. Claims stay inside the accuracy gate in
 * the page header (and the /security content header behind it): connector
 * credentials never enter the machine, but a granted runtime secret does;
 * approval gates are opt-in; SOC 2 Type I is held and Type II is in progress.
 * `**phrase**` renders in ink.
 *
 * English only for now. The hero keeps its translated strings.
 */

export const enterpriseSpecs = [
  { k: 'Governance', v: 'Every tool call, secret and change' },
  { k: 'Identity', v: 'SAML SSO and SCIM' },
  { k: 'Isolation', v: 'A machine and a branch per session' },
  { k: 'Deployment', v: 'Cloud, your VPC or on-prem' },
] as const;

export const governanceSummary = {
  title: 'Govern actions.',
  titleMuted: 'Not just people.',
  body: [
    'Most platforms stop at login. Kortix governs **every tool call, secret read and config change** an agent makes.',
    'The control plane is **a git repo**, so policy is reviewed and reverted like code.',
  ],
  cells: [
    { k: 'Connector keys stay out', v: 'Resolved on the server, never in the machine.' },
    { k: 'Only the access it needs', v: 'Allow, ask or block per action and argument.' },
    { k: 'Reviewed like code', v: 'Agents and policy are files in kortix.yaml.' },
    { k: 'Reverted like code', v: 'Every change is a diff you can roll back.' },
  ],
} as const;

export const isolationSummary = {
  title: 'Isolation by default.',
  titleMuted: 'A machine and a branch per session.',
  body: [
    'Every session runs on **its own isolated machine**, on its own git branch. Session work reaches main **through a change request**.',
  ],
  cells: [
    { k: 'A sandbox per session', v: 'An isolated machine with a clone of the repo.' },
    { k: 'A branch per session', v: 'Work lands through change requests.' },
    { k: 'Built for whole companies', v: 'Members are free and unlimited, one credit pool.' },
  ],
} as const;

export const controlsSummary = {
  title: 'Everything procurement asks for.',
  titleMuted: 'Already answered.',
  body: [
    'The controls **a security review asks about**, in one place. The security page has the detail behind each one.',
  ],
  cells: [
    { k: 'SAML 2.0 SSO', v: 'Your identity provider, with group mapping.' },
    { k: 'SCIM 2.0', v: 'Directory sync, built against Okta and Entra.' },
    { k: 'Advanced RBAC', v: 'Custom roles, narrowed to named agents.' },
    { k: 'Audit export', v: 'CSV, JSONL, or a signed webhook to your SIEM.' },
    { k: 'Encrypted secrets', v: 'Connector keys stay on the server.' },
  ],
} as const;

export const deploymentSummary = {
  title: 'Your data never has to leave.',
  titleMuted: 'Run it where your policy says.',
  body: [
    'Kortix is **open source**, and **the same stack runs in every deployment**. Every config, session and file of context stays yours.',
  ],
  cells: [
    { k: 'Open source', v: 'The code you trust is code you can read.' },
    { k: 'One stack', v: 'The same images in every deployment.' },
    { k: 'Your config', v: 'Agents, grants and policy stay yours.' },
    { k: 'Your context', v: 'Every session and file of context stays yours.' },
  ],
} as const;
