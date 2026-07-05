import { describe, expect, test } from 'bun:test';
import { resolveGrantSet, validateManifest } from '../index.ts';

const V2_FIXTURE = `
kortix_version: 2
default_agent: support
runtime: opencode

project:
  name: acme-support
  description: Customer support automation

agents:
  support:
    description: Handles customer support triage
    mode: primary
    model: anthropic/claude-sonnet-5
    temperature: 0.2
    steps: 200
    color: "#7C5CFF"
    hidden: false
    prompt: agents/support.md
    permission:
      edit: ask
      bash:
        "git push": deny
        "*": allow
      webfetch: allow
    connectors: [github, slack]
    secrets: [STRIPE_KEY, GH_TOKEN]
    kortix_cli: [project.session.start, project.cr.open]
    workspace: runtime
  pr-bot:
    mode: subagent
    description: Reviews and lands PRs
    prompt: agents/pr-bot.md
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

[[apps]]
slug = "site"
name = "Marketing site"
[apps.source]
type = "git"
`;

// Golden-fixture regression guard: this v1 manifest exercises project, env,
// opencode, sandbox.templates + default, triggers, connectors (incl. the
// platform-written channel connector), [[agents]] (incl. the env grant-set),
// [[channels]], and apps. Adding kortix_version 2 support must not change a
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
apps:
  - slug: site
    name: Marketing site
    source:
      type: git
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

describe('validateManifest — kortix_version 2 deprecated upstream fields', () => {
  test('`tools` is rejected with a pointer to `permission`', () => {
    const { errorPaths, issues } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    tools:
      bash: true
`);
    expect(errorPaths).toContain('agents.w.tools');
    expect(issues.find((i) => i.path === 'agents.w.tools')?.message).toContain('permission');
  });

  test('`maxSteps` is rejected with a pointer to `steps`', () => {
    const { errorPaths, issues } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    maxSteps: 50
`);
    expect(errorPaths).toContain('agents.w.maxSteps');
    expect(issues.find((i) => i.path === 'agents.w.maxSteps')?.message).toContain('steps');
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

describe('validateManifest — kortix_version 2 subagent requires description', () => {
  test('mode: subagent without a description is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    mode: subagent
`);
    expect(errorPaths).toContain('agents.w.description');
  });

  test('mode: subagent with an empty-string description is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    mode: subagent
    description: "   "
`);
    expect(errorPaths).toContain('agents.w.description');
  });

  test('mode: subagent with a description passes', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    mode: subagent
    description: reviews PRs
`);
    expect(valid).toBe(true);
  });

  test('mode: primary does not require a description', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    mode: primary
`);
    expect(valid).toBe(true);
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

describe('validateManifest — kortix_version 2 agent field validation', () => {
  test('an invalid mode is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    mode: bogus
`);
    expect(errorPaths).toContain('agents.w.mode');
  });

  test('non-numeric temperature is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    temperature: "hot"
`);
    expect(errorPaths).toContain('agents.w.temperature');
  });

  test('non-numeric top_p is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    top_p: "high"
`);
    expect(errorPaths).toContain('agents.w.top_p');
  });

  test('a zero steps value is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    steps: 0
`);
    expect(errorPaths).toContain('agents.w.steps');
  });

  test('a non-integer steps value is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    steps: 1.5
`);
    expect(errorPaths).toContain('agents.w.steps');
  });

  test('a hex color passes', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    color: "#ABCDEF"
`);
    expect(valid).toBe(true);
  });

  test('a theme color name passes', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    color: warning
`);
    expect(valid).toBe(true);
  });

  test('an invalid color is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    color: chartreuse
`);
    expect(errorPaths).toContain('agents.w.color');
  });

  test('a non-boolean disable is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    disable: "yes"
`);
    expect(errorPaths).toContain('agents.w.disable');
  });

  test('a non-boolean hidden is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    hidden: "yes"
`);
    expect(errorPaths).toContain('agents.w.hidden');
  });

  test('an absolute prompt path is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    prompt: /etc/passwd
`);
    expect(errorPaths).toContain('agents.w.prompt');
  });

  test('a non-object options value is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    options: "x"
`);
    expect(errorPaths).toContain('agents.w.options');
  });

  test('a free-form options object passes through', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    options:
      reasoningEffort: high
      anything: [1, 2, 3]
`);
    expect(valid).toBe(true);
  });

  test('a model without a "/" warns but does not block', () => {
    const { valid, warningPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    model: sonnet
`);
    expect(valid).toBe(true);
    expect(warningPaths).toContain('agents.w.model');
  });

  test('an invalid agent name key is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  "Not Valid":
    description: x
  w: {}
`);
    expect(errorPaths).toContain('agents.Not Valid');
  });
});

describe('validateManifest — kortix_version 2 permission tree', () => {
  test('a bare action permission is accepted', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    permission: allow
`);
    expect(valid).toBe(true);
  });

  test('an invalid bare action permission is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    permission: sometimes
`);
    expect(errorPaths).toContain('agents.w.permission');
  });

  test('a nested glob-map permission rule is accepted', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    permission:
      bash:
        "git push": deny
        "*": allow
`);
    expect(valid).toBe(true);
  });

  test('an invalid action inside a glob-map is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    permission:
      bash:
        "*": maybe
`);
    expect(errorPaths).toContain('agents.w.permission.bash.*');
  });

  test('action-only keys reject a glob-map form', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    permission:
      webfetch:
        "*": allow
`);
    expect(errorPaths).toContain('agents.w.permission.webfetch');
  });

  test('an arbitrary passthrough tool-name key accepts the rule form', () => {
    const { valid } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    permission:
      my_custom_tool:
        "*": ask
`);
    expect(valid).toBe(true);
  });

  test('doom_loop only accepts a bare action', () => {
    const { valid, errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w:
    permission:
      doom_loop: deny
`);
    expect(valid).toBe(true);
    expect(errorPaths).toEqual([]);
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

describe('validateManifest — version above known max still rejected', () => {
  test('kortix_version 3 is rejected as unsupported', () => {
    const { errorPaths, issues } = summarize(`
kortix_version: 3
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

  test('apps validates identically to v1', () => {
    const { errorPaths } = summarize(`
kortix_version: 2
default_agent: w
agents:
  w: {}
apps:
  - slug: site
    source:
      type: ftp
`);
    expect(errorPaths).toContain('apps[0].source.type');
  });
});
