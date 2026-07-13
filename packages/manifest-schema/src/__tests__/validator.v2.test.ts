import { describe, expect, test } from 'bun:test';
import {
  type ManifestIssue,
  resolveGrantSet,
  validateAgentMdFrontmatter,
  validateManifest,
} from '../index.ts';

// v2's `agents:` map is GOVERNANCE ONLY (decision 2026-07-05, "one home per
// concern") — behavior (mode/model/temperature/permission/…) lives entirely
// in the agent's own `.kortix/opencode/agents/<name>.md` frontmatter, which
// this validator never reads. See the `validateAgentMdFrontmatter` describe
// block below for the behavioral-field rules, now exercised against that
// function directly instead of through `validateManifest`.
const V2_FIXTURE = `
kortix_version: 2
default_agent: support
runtime: opencode

project:
  name: acme-support
  description: Customer support automation

agents:
  support:
    connectors: [github, slack]
    secrets: [STRIPE_KEY, GH_TOKEN]
    kortix_cli: [project.session.start, project.cr.open]
    workspace: runtime
  pr-bot:
    connectors: [github]
    kortix_cli: [project.cr.open, project.cr.merge, project.review.submit]

triggers:
  - slug: nightly-digest
    type: cron
    cron: "0 9 * * *"
    prompt: Summarize open PRs and support tickets
    agent: support

connectors:
  - slug: github
    provider: pipedream
    app: github
  - slug: slack
    provider: channel
    platform: slack
`;

function summarize(input: string | Record<string, unknown>, format: 'toml' | 'yaml' = 'yaml') {
  const result = validateManifest(input, format);
  const errorPaths = result.issues.filter((i) => i.severity === 'error').map((i) => i.path);
  const warningPaths = result.issues.filter((i) => i.severity === 'warning').map((i) => i.path);
  return { ...result, errorPaths, warningPaths };
}

function frontmatterIssues(frontmatter: Record<string, unknown>): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  validateAgentMdFrontmatter(frontmatter, 'agents/w.md', issues);
  return issues;
}

const V1_REGRESSION_FIXTURE = `
kortix_version = 1

[project]
name = "acme-support"
description = "Customer support automation"

[env]
required = ["ANTHROPIC_API_KEY"]
optional = ["STRIPE_KEY"]

[opencode]
config_dir = ".kortix/opencode"

[[sandbox.templates]]
slug = "py"
name = "Python"
image = "python:3.12-slim"
cpu = 2
memory = 4
disk = 20

[sandbox]
default = "py"

[[triggers]]
slug = "nightly"
type = "cron"
cron = "0 9 * * *"
prompt = "Daily digest"

[[connectors]]
slug = "github"
provider = "pipedream"
app = "github"

[[connectors]]
slug = "kortix_slack"
provider = "channel"
platform = "slack"

[[agents]]
name = "support"
connectors = ["github"]
kortix_cli = ["project.read", "project.session.start"]
env = ["STRIPE_KEY"]

[[agents]]
name = "pr-bot"
connectors = "all"
kortix_cli = ["*"]

[[channels]]
platform = "slack"
enabled = true
events = ["message"]

`;

// Golden-fixture regression guard: this v1 manifest exercises project, env,
// opencode, sandbox.templates + default, triggers, connectors (incl. the
// platform-written channel connector), [[agents]] (incl. the env grant-set),
// and [[channels]]. Adding kortix_version 2 support must not change a
// single byte of how this validates — v1 stays byte-for-byte unchanged.
describe('validateManifest — v1 regression (byte-for-byte unchanged after adding v2)', () => {
  test('a comprehensive v1 manifest still validates clean with zero issues', () => {
    const result = validateManifest(V1_REGRESSION_FIXTURE, 'toml');
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test('the same manifest, translated to YAML, validates identically', () => {
    const yaml = `
kortix_version: 1
project:
  name: acme-support
  description: Customer support automation
env:
  required: [ANTHROPIC_API_KEY]
  optional: [STRIPE_KEY]
opencode:
  config_dir: .kortix/opencode
sandbox:
  default: py
  templates:
    - slug: py
      name: Python
      image: python:3.12-slim
      cpu: 2
      memory: 4
      disk: 20
triggers:
  - slug: nightly
    type: cron
    cron: "0 9 * * *"
    prompt: Daily digest
connectors:
  - slug: github
    provider: pipedream
    app: github
  - slug: kortix_slack
    provider: channel
    platform: slack
agents:
  - name: support
    connectors: [github]
    kortix_cli: [project.read, project.session.start]
    env: [STRIPE_KEY]
  - name: pr-bot
    connectors: all
    kortix_cli: ["*"]
channels:
  - platform: slack
    enabled: true
    events: [message]
`;
    const result = validateManifest(yaml, 'yaml');
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });
});

describe('validateManifest — kortix_version 2 happy path', () => {
  test('the full example manifest is valid with zero errors', () => {
    const { valid, errorPaths, issues } = summarize(V2_FIXTURE);
    expect(errorPaths).toEqual([]);
    expect(valid).toBe(true);
    expect(issues.every((i) => i.severity !== 'error')).toBe(true);
  });
});

describe('validateManifest — kortix_version 2 format gate', () => {
  test('kortix_version 2 in a TOML file is a validation error pointing at kortix.yaml', () => {
    const { valid, errorPaths, issues } = summarize(
      `kortix_version = 2\ndefault_agent = "w"\n[agents.w]\n`,
      'toml',
    );
    expect(valid).toBe(false);
    expect(errorPaths).toContain('kortix_version');
    expect(
      issues.some((i) => i.path === 'kortix_version' && i.message.includes('kortix.yaml')),
    ).toBe(true);
  });

  test('kortix_version 1 continues to work in TOML', () => {
    expect(validateManifest('kortix_version = 1', 'toml').valid).toBe(true);
  });

  test('kortix_version 1 continues to work in YAML', () => {
    expect(validateManifest('kortix_version: 1', 'yaml').valid).toBe(true);
  });
});

describe('validateManifest — kortix_version 2 behavior fields moved to the agent .md', () => {
  test('a flat behavioral field on the agent block is rejected with a pointer to the .md frontmatter', () => {
    const { errorPaths, issues } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    mode: primary
`);
    expect(errorPaths).toContain('agents.w.mode');
    expect(issues.find((i) => i.path === 'agents.w.mode')?.message).toContain('.md');
  });

  test('`model` on the agent block is rejected — model now lives in the .md frontmatter', () => {
    const { errorPaths, issues } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    model: anthropic/claude-sonnet-5
`);
    expect(errorPaths).toContain('agents.w.model');
    expect(issues.find((i) => i.path === 'agents.w.model')?.message).toContain('.md');
  });

  test('`description` on the agent block is rejected — description now lives in the .md frontmatter', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    description: "Handles support"
`);
    expect(errorPaths).toContain('agents.w.description');
  });

  test('a nested `opencode:` sub-object is rejected outright — the override concept is removed, not renamed', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    opencode:
      mode: primary
`);
    expect(errorPaths).toContain('agents.w.opencode');
  });

  test('a flat `disable` is rejected with a pointer to `enabled` AND the .md', () => {
    const { errorPaths, issues } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    disable: true
`);
    expect(errorPaths).toContain('agents.w.disable');
    expect(issues.find((i) => i.path === 'agents.w.disable')?.message).toContain('.md');
  });

  test('`permission`/`temperature`/`steps`/`color`/`hidden`/`variant`/`top_p`/`prompt` are all rejected flat on the agent block', () => {
    for (const key of [
      'permission',
      'temperature',
      'steps',
      'color',
      'hidden',
      'variant',
      'top_p',
      'prompt',
    ]) {
      const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    ${key}: x
`);
      expect(errorPaths).toContain(`agents.w.${key}`);
    }
  });
});

describe('validateManifest — kortix_version 2 secrets rename', () => {
  test('an `env` key on an agent block is rejected with a pointer to `secrets`', () => {
    const { errorPaths, issues } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    env: [STRIPE_KEY]
`);
    expect(errorPaths).toContain('agents.w.env');
    expect(issues.find((i) => i.path === 'agents.w.env')?.message).toContain('secrets');
  });

  test('a top-level [env] section is unaffected and still validates as in v1', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
env:
  required: [ANTHROPIC_API_KEY]
agents:
  w: {}
`);
    expect(valid).toBe(true);
  });

  test('`secrets` on an agent block is the accepted governance field', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    secrets: [STRIPE_KEY]
`);
    expect(valid).toBe(true);
  });
});

// `per_user` connector credential mode was removed 2026-07-05 (docs/specs/
// 2026-07-05-agent-first-config-unification.md §2.5): v1 tolerates it as a
// legacy value (warning; resolves to `shared` at runtime), v2 is a clean
// break and rejects it outright — same pattern as the removed CLI actions.
describe('validateManifest — connector `credential: per_user` removal', () => {
  test('v1 tolerates "per_user" as a legacy value (warning, not an error)', () => {
    const { valid, errorPaths, warningPaths } = summarize(
      'kortix_version = 1\n[[connectors]]\nslug = "gmail"\nprovider = "pipedream"\napp = "gmail"\ncredential = "per_user"',
      'toml',
    );
    expect(valid).toBe(true);
    expect(errorPaths).not.toContain('connectors[0].credential');
    expect(warningPaths).toContain('connectors[0].credential');
  });

  test('v2 rejects "per_user" outright', () => {
    const { valid, errorPaths, issues } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w: {}
connectors:
  - slug: gmail
    provider: pipedream
    app: gmail
    credential: per_user
`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('connectors[0].credential');
    expect(issues.find((i) => i.path === 'connectors[0].credential')?.message).toContain('kortix_version 2');
  });

  test('v2 accepts "shared" (the only mode) cleanly', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w: {}
connectors:
  - slug: gmail
    provider: pipedream
    app: gmail
    credential: shared
`);
    expect(valid).toBe(true);
  });

  // The runtime (apps/api connectors.ts `parseConnectorEntry`) hard-rejects
  // ANY credential value that isn't "shared"/"per_user" — a parse error, not
  // advisory. v2 mirrors that as a real error; v1 keeps it a warning (same
  // as this function's other v1-only soft checks).
  test('v1 tolerates a garbage credential value as a warning, still valid', () => {
    const { valid, errorPaths, warningPaths } = summarize(
      'kortix_version = 1\n[[connectors]]\nslug = "gmail"\nprovider = "pipedream"\napp = "gmail"\ncredential = "team"',
      'toml',
    );
    expect(valid).toBe(true);
    expect(errorPaths).not.toContain('connectors[0].credential');
    expect(warningPaths).toContain('connectors[0].credential');
  });

  test('v2 hard-rejects a garbage credential value (not just "per_user")', () => {
    const { valid, errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w: {}
connectors:
  - slug: gmail
    provider: pipedream
    app: gmail
    credential: team
`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('connectors[0].credential');
  });
});

// The connector-side agent gate (`[[connectors]].agent_scope`) was removed
// 2026-07 (wave-2 of the agent-first cut, docs/specs/
// 2026-07-05-agent-first-config-unification.md §2.5): connector access is now
// purely the agent's own `connectors` grant. The runtime (apps/api's
// connectors.ts `parseConnectorEntry`) no longer parses `agent_scope` at all —
// it is silently ignored, never round-tripped back into git. Same
// legacy-tolerated pattern as `credential: per_user`: v1 warns, v2 hard-errors.
describe('validateManifest — connector `agent_scope` removal', () => {
  test('v1 tolerates a legacy agent_scope as a warning, still valid', () => {
    const { valid, errorPaths, warningPaths } = summarize(
      'kortix_version = 1\n[[connectors]]\nslug = "gmail"\nprovider = "pipedream"\napp = "gmail"\nagent_scope = ["support"]',
      'toml',
    );
    expect(valid).toBe(true);
    expect(errorPaths).not.toContain('connectors[0].agent_scope');
    expect(warningPaths).toContain('connectors[0].agent_scope');
  });

  test('v2 rejects agent_scope outright', () => {
    const { valid, errorPaths, issues } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w: {}
connectors:
  - slug: gmail
    provider: pipedream
    app: gmail
    agent_scope: [support]
`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('connectors[0].agent_scope');
    expect(issues.find((i) => i.path === 'connectors[0].agent_scope')?.message).toContain(
      'kortix_version 2',
    );
  });

  test('v1 connector without agent_scope has no warning', () => {
    const { warningPaths } = summarize(
      'kortix_version = 1\n[[connectors]]\nslug = "gmail"\nprovider = "pipedream"\napp = "gmail"',
      'toml',
    );
    expect(warningPaths).not.toContain('connectors[0].agent_scope');
  });
});

// The 10 actions removed from IAM enforcement (dead-catalog cleanup) are
// still parseable in an existing v1 manifest (warning only — the audit
// found nothing asserts them on any route, so tolerating them is a no-op).
// v2 is a NEW schema version, so it gets the clean break: no tolerance.
describe('validateManifest — kortix_cli LEGACY_TOLERATED_KORTIX_CLI_ACTIONS clean break', () => {
  test('v1 tolerates a legacy-removed action as a warning, still valid', () => {
    const { valid, errorPaths, warningPaths } = summarize(
      'kortix_version = 1\n[[agents]]\nname = "w"\nkortix_cli = ["project.schedule.read"]\n',
      'toml',
    );
    expect(valid).toBe(true);
    expect(errorPaths).not.toContain('agents[0].kortix_cli[0]');
    expect(warningPaths).toContain('agents[0].kortix_cli[0]');
  });

  test('v2 hard-rejects the same legacy-removed action', () => {
    const { valid, errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    kortix_cli: [project.schedule.read]
`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('agents.w.kortix_cli[0]');
  });

  test('v2 still hard-rejects a truly unknown (never-was-valid) action, same as before', () => {
    const { valid, errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    kortix_cli: [project.frobnicate]
`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('agents.w.kortix_cli[0]');
  });
});

describe('validateManifest — kortix_version 2 channels removal', () => {
  test('`channels` is invalid in v2', () => {
    const { errorPaths, issues } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w: {}
channels:
  - platform: slack
`);
    expect(errorPaths).toContain('channels');
    expect(issues.find((i) => i.path === 'channels')?.message).toContain('connector');
  });
});

describe('validateManifest — kortix_version 2 default_agent', () => {
  test('default_agent referencing an undeclared agent is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: ghost
agents:
  w: {}
`);
    expect(errorPaths).toContain('default_agent');
  });

  test('missing default_agent is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
agents:
  w: {}
`);
    expect(errorPaths).toContain('default_agent');
  });

  test('default_agent naming a declared agent passes', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w: {}
`);
    expect(valid).toBe(true);
  });

  test('default_agent naming a disabled agent is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    enabled: false
`);
    expect(errorPaths).toContain('default_agent');
  });
});

describe('validateManifest — kortix_version 2 requires at least one agent', () => {
  test('a missing agents map is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
`);
    expect(errorPaths).toContain('agents');
  });

  test('an empty agents map is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents: {}
`);
    expect(errorPaths).toContain('agents');
  });

  test('an [[agents]] array (the v1 shape) is rejected in v2', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  - name: w
`);
    expect(errorPaths).toContain('agents');
  });
});

describe('validateManifest — kortix_version 2 trigger agent references', () => {
  test('a trigger agent naming an undeclared agent is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w: {}
triggers:
  - slug: t
    type: cron
    cron: "0 9 * * *"
    prompt: go
    agent: ghost
`);
    expect(errorPaths).toContain('triggers[0].agent');
  });

  test('a trigger with no agent falls back to default_agent (valid)', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w: {}
triggers:
  - slug: t
    type: cron
    cron: "0 9 * * *"
    prompt: go
`);
    expect(valid).toBe(true);
  });

  test('a trigger agent naming a declared agent passes', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w: {}
  other: {}
triggers:
  - slug: t
    type: cron
    cron: "0 9 * * *"
    prompt: go
    agent: other
`);
    expect(valid).toBe(true);
  });
});

describe('validateManifest — kortix_version 2 runtime enum', () => {
  test('runtime: opencode is accepted', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
runtime: opencode
agents:
  w: {}
`);
    expect(valid).toBe(true);
  });

  test('omitted runtime defaults implicitly (no error)', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w: {}
`);
    expect(valid).toBe(true);
  });

  test('an unknown runtime is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
runtime: codex
agents:
  w: {}
`);
    expect(errorPaths).toContain('runtime');
  });
});

describe('validateManifest — kortix_version 2 agent block is governance-only', () => {
  test('a non-boolean enabled is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    enabled: "yes"
`);
    expect(errorPaths).toContain('agents.w.enabled');
  });

  test('a bare governance-only block (every field omitted) is valid', () => {
    const { valid, issues } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w: {}
`);
    expect(valid).toBe(true);
    expect(issues).toEqual([]);
  });

  test('an invalid agent name key is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  "Not Valid":
    workspace: runtime
  w: {}
`);
    expect(errorPaths).toContain('agents.Not Valid');
  });
});

describe('validateManifest — kortix_version 2 grant sets are shape-optional', () => {
  test('omitting connectors, secrets, and kortix_cli on an agent is still valid shape', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w: {}
`);
    expect(valid).toBe(true);
  });

  test('kortix_cli rejects a non-grantable action, same enum as v1', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    kortix_cli: [billing.read]
`);
    expect(errorPaths).toContain('agents.w.kortix_cli[0]');
  });

  test('workspace accepts the declared enum', () => {
    for (const w of ['runtime', 'read', 'branch']) {
      const { valid } = summarize(`
kortix_version: 2
default_agent: a
agents:
  a:
    workspace: ${w}
`);
      expect(valid).toBe(true);
    }
  });

  test('an unknown workspace value is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    workspace: everywhere
`);
    expect(errorPaths).toContain('agents.w.workspace');
  });
});

describe('validateManifest — kortix_version 2 `skills` governance grant', () => {
  test('an explicit skill-name list is accepted', () => {
    const { valid, errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    skills: [pdf-export, web-research]
`);
    expect(valid).toBe(true);
    expect(errorPaths).toEqual([]);
  });

  test('"all" and "none" string sentinels are accepted', () => {
    for (const v of ['all', 'none']) {
      const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    skills: ${v}
`);
      expect(valid).toBe(true);
    }
  });

  test('omitting `skills` is still valid shape (v2 deny-by-default applies at resolution time)', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w: {}
`);
    expect(valid).toBe(true);
  });

  test('a non-string entry is rejected, same shape rule as connectors', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    skills: [42]
`);
    expect(errorPaths).toContain('agents.w.skills[0]');
  });

  test('an invalid sentinel string is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    skills: everything
`);
    expect(errorPaths).toContain('agents.w.skills');
  });
});

describe('validateManifest — version above known max still rejected', () => {
  test('kortix_version 4 is rejected as unsupported', () => {
    const { errorPaths, issues } = summarize(`
kortix_version: 4
default_agent: w
agents:
  w: {}
`);
    expect(errorPaths).toContain('kortix_version');
    expect(issues.some((i) => i.message.includes('Unsupported schema version'))).toBe(true);
  });
});

describe('resolveGrantSet — v1 default-all vs v2 default-none', () => {
  test('v1 semantics: an omitted grant resolves to "all"', () => {
    expect(resolveGrantSet(undefined, 'all')).toBe('all');
    expect(resolveGrantSet(null, 'all')).toBe('all');
  });

  test('v2 semantics: an omitted grant resolves to "none"', () => {
    expect(resolveGrantSet(undefined, 'none')).toBe('none');
    expect(resolveGrantSet(null, 'none')).toBe('none');
  });

  test('an explicit "all" resolves to "all" regardless of the omitted-default', () => {
    expect(resolveGrantSet('all', 'none')).toBe('all');
  });

  test('an explicit "none" resolves to "none" regardless of the omitted-default', () => {
    expect(resolveGrantSet('none', 'all')).toBe('none');
  });

  test('an explicit empty string resolves to "none" (runtime treats "" as deny)', () => {
    expect(resolveGrantSet('', 'all')).toBe('none');
  });

  test('an explicit array resolves to its trimmed, filtered entries', () => {
    expect(resolveGrantSet(['github', ' slack ', ''], 'none')).toEqual(['github', 'slack']);
  });
});

describe('validateManifest — kortix_version 2 v1 sections carry over unchanged', () => {
  test('sandbox.templates validates identically to v1', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w: {}
sandbox:
  templates:
    - slug: py
      image: python:3.12-slim
`);
    expect(valid).toBe(true);
  });

  test('connectors validates identically to v1 (unknown provider still rejected)', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w: {}
connectors:
  - slug: wat
    provider: made-up
`);
    expect(errorPaths).toContain('connectors[0].provider');
  });

});

// ─── validateAgentMdFrontmatter ─────────────────────────────────────────────
//
// The behavioral-field rules formerly enforced on the manifest's (removed)
// `agents.<name>.opencode` block now apply to the agent's native `.md`
// frontmatter instead — same rules, reused, exercised directly since this
// validator has no manifest/git context of its own (the compiler is the one
// caller that actually has the file content to validate).
describe('validateAgentMdFrontmatter', () => {
  test('an empty frontmatter object (a stock body-only .md) is valid', () => {
    expect(frontmatterIssues({})).toEqual([]);
  });

  test('every recognized field passes when well-formed', () => {
    const issues = frontmatterIssues({
      description: 'Handles support',
      model: 'anthropic/claude-sonnet-5',
      mode: 'primary',
      variant: 'thinking',
      temperature: 0.2,
      top_p: 0.9,
      steps: 200,
      color: '#7C5CFF',
      hidden: false,
      disable: false,
      options: { reasoningEffort: 'high' },
      permission: { edit: 'ask', bash: { 'git push': 'deny', '*': 'allow' } },
    });
    expect(issues).toEqual([]);
  });

  test('an invalid mode is rejected', () => {
    const issues = frontmatterIssues({ mode: 'bogus' });
    expect(issues.some((i) => i.path === 'agents/w.md.mode')).toBe(true);
  });

  test('non-numeric temperature is rejected', () => {
    const issues = frontmatterIssues({ temperature: 'hot' });
    expect(issues.some((i) => i.path === 'agents/w.md.temperature')).toBe(true);
  });

  test('non-numeric top_p is rejected', () => {
    const issues = frontmatterIssues({ top_p: 'high' });
    expect(issues.some((i) => i.path === 'agents/w.md.top_p')).toBe(true);
  });

  test('a zero steps value is rejected', () => {
    const issues = frontmatterIssues({ steps: 0 });
    expect(issues.some((i) => i.path === 'agents/w.md.steps')).toBe(true);
  });

  test('a non-integer steps value is rejected', () => {
    const issues = frontmatterIssues({ steps: 1.5 });
    expect(issues.some((i) => i.path === 'agents/w.md.steps')).toBe(true);
  });

  test('a hex color passes', () => {
    expect(frontmatterIssues({ color: '#ABCDEF' })).toEqual([]);
  });

  test('a theme color name passes', () => {
    expect(frontmatterIssues({ color: 'warning' })).toEqual([]);
  });

  test('an invalid color is rejected', () => {
    const issues = frontmatterIssues({ color: 'chartreuse' });
    expect(issues.some((i) => i.path === 'agents/w.md.color')).toBe(true);
  });

  test('a non-boolean hidden is rejected', () => {
    const issues = frontmatterIssues({ hidden: 'yes' });
    expect(issues.some((i) => i.path === 'agents/w.md.hidden')).toBe(true);
  });

  test('a non-boolean disable is rejected', () => {
    const issues = frontmatterIssues({ disable: 'yes' });
    expect(issues.some((i) => i.path === 'agents/w.md.disable')).toBe(true);
  });

  test('a non-object options value is rejected', () => {
    const issues = frontmatterIssues({ options: 'x' });
    expect(issues.some((i) => i.path === 'agents/w.md.options')).toBe(true);
  });

  test('a bare permission action is accepted', () => {
    expect(frontmatterIssues({ permission: 'allow' })).toEqual([]);
  });

  test('an invalid bare permission action is rejected', () => {
    const issues = frontmatterIssues({ permission: 'sometimes' });
    expect(issues.some((i) => i.path === 'agents/w.md.permission')).toBe(true);
  });

  test('an invalid action inside a glob-map permission rule is rejected', () => {
    const issues = frontmatterIssues({ permission: { bash: { '*': 'maybe' } } });
    expect(issues.some((i) => i.path === 'agents/w.md.permission.bash.*')).toBe(true);
  });

  test('action-only keys reject a glob-map form', () => {
    const issues = frontmatterIssues({ permission: { webfetch: { '*': 'allow' } } });
    expect(issues.some((i) => i.path === 'agents/w.md.permission.webfetch')).toBe(true);
  });

  test('`tools` is rejected with a pointer to `permission`', () => {
    const issues = frontmatterIssues({ tools: { bash: true } });
    expect(issues.find((i) => i.path === 'agents/w.md.tools')?.message).toContain('permission');
  });

  test('`maxSteps` is rejected with a pointer to `steps`', () => {
    const issues = frontmatterIssues({ maxSteps: 50 });
    expect(issues.find((i) => i.path === 'agents/w.md.maxSteps')?.message).toContain('steps');
  });
});
