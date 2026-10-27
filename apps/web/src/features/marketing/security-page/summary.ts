/**
 * The /security page, condensed. Every line here is a shorter form of a claim
 * in `content.ts`, which ties each claim to the code it rests on — read that
 * file's header before changing a fact here. `**phrase**` renders in ink.
 *
 * English only for now: the long-form copy in `content.ts` keeps its
 * translations; this summary has none yet.
 */

export const isolationSummary = {
  title: 'Nothing is shared.',
  titleMuted: 'Each session gets a machine of its own.',
  body: [
    'A session is not a tab in a shared runtime. It is **a machine of its own**, and the database will not let two sessions share one.',
    'Every edit lands on **a branch named after the session**. Only what it commits survives the machine.',
  ],
  cells: [
    { k: 'One sandbox per session', v: 'Enforced in the database, not by convention.' },
    { k: 'A microVM on Platinum', v: 'Cloud Hypervisor on Kortix compute. Daytona is a legacy fallback.' },
    { k: 'One branch per session', v: 'Every edit and commit lives on that branch.' },
    { k: 'Disposable', v: 'A bad install goes away with the machine.' },
  ],
} as const;

export const credentialsSummary = {
  title: 'A key is granted, not pasted.',
  titleMuted: 'Who holds which key is a decision.',
  body: [
    'Project secrets are **encrypted per project**. A session receives only what **both the person’s role and the agent’s grant** allow.',
    '**Connector credentials never enter the machine.** A granted secret is a real environment value in that session, because that is how a tool uses it.',
  ],
  cells: [
    { k: 'Stored', v: 'AES-256-GCM, with a key per project.' },
    { k: 'Granted', v: 'Role and agent grant must both allow it.' },
    { k: 'Delivered', v: 'Placed at boot on tmpfs, mode 0600.' },
    { k: 'Used', v: 'Read from the environment, not the prompt.' },
    { k: 'Shredded', v: 'Wiped on shutdown with the machine.' },
  ],
} as const;

export const identitySummary = {
  title: 'An agent is a principal.',
  titleMuted: 'It carries policies of its own.',
  body: [
    'An agent does not inherit whatever the person who started it can reach. **Its identity carries its own policies**, evaluated on their own.',
    'Every plan **records every action**. The plan decides who may read, export or stream that record.',
  ],
  cells: [
    { k: 'Principals', v: 'People, groups and service accounts.' },
    { k: 'Built-in roles', v: 'Owner, Admin and Member, on every plan.' },
    { k: 'SAML SSO and SCIM', v: 'On Enterprise, with group-claim mapping.' },
    { k: 'Audit log', v: 'Each gated tool call is a row, with its outcome.' },
  ],
} as const;

export const controlSummary = {
  title: 'Decide what needs a human.',
  titleMuted: 'The rules live in kortix.yaml.',
  sub: 'Approval is a versioned block in kortix.yaml, not a setting buried in an admin panel.',
  /** One line each; ids match `control.notes` so the yaml focus ranges apply. */
  notes: [
    { id: 'actions', k: 'Three actions', v: 'Every rule is always_run, require_approval or block.' },
    { id: 'conditions', k: 'Gate the target', v: 'Conditions match the arguments, such as who an email goes to.' },
    { id: 'percall', k: 'Approve each call', v: 'No session-wide “allow always”: each gated call waits for you.' },
    { id: 'default', k: 'Set the default', v: 'default_mode: risk runs reads and sends writes to a person.' },
  ],
} as const;

export const landingSummary = {
  title: 'Opening and merging are different powers.',
  titleMuted: 'For agents, merge is default-deny.',
  body: [
    'An agent can write as much as it likes **on its own branch**. Landing that work on main is **a capability it does not have** unless an admin grants it.',
  ],
  cells: [
    { k: 'Works on its branch', v: 'Nothing reaches other sessions or main.' },
    { k: 'Opens a change request', v: 'Committing and opening one is the only door.' },
    { k: 'A person reads the diff', v: 'A prompt change is reviewed like code.' },
    { k: 'Merge is default-deny', v: 'Refused to every agent unless granted.' },
  ],
} as const;
