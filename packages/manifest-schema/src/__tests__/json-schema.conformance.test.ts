/**
 * Anti-drift conformance suite: the published JSON Schema
 * (`../json-schema.ts`) and the imperative validator (`../index.ts`) are two
 * independent implementations of "is this manifest valid" and MUST agree on
 * every fixture below, or this test fails CI. That's what makes the schema
 * safe to publish as the canonical, single validator reference (spec ask:
 * "it must always return the correct, fully-valid schema").
 *
 * Fixtures are drawn from (and kept in sync with) the same manifests
 * exercised in `validator.v2.test.ts` / `validator.test.ts`, run through the
 * COMBINED schema (`KORTIX_JSON_SCHEMA`) via ajv — the one public URL meant
 * to validate a manifest of either version.
 *
 * A separate, explicitly-labeled block at the bottom documents the KNOWN,
 * INTENTIONAL divergences: cross-field / dynamic-set rules (`default_agent`
 * must name a declared agent, a trigger's `agent` must too, `sandbox.default`
 * must name a declared template, `kortix_version: 2` in a `.toml` file) that
 * only the imperative validator can express (see `../json-schema.ts` module
 * doc). Those assertions pin down the EXPECTED asymmetry so a future change
 * that closes or widens the gap is a deliberate, reviewed diff — not a
 * silent one.
 */
import { describe, expect, test } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { KORTIX_JSON_SCHEMA, KORTIX_V1_JSON_SCHEMA, KORTIX_V2_JSON_SCHEMA } from '../json-schema';
import { validateManifest } from '../index';

// `strict: false` — see json-schema.ts's mutual-exclusion `oneOf` branches
// (image XOR dockerfile, etc.): ajv's strict-mode `strictRequired` check
// wants a `required` array's properties to be declared in the SAME schema
// object, which a bare `{ required: [...] }` branch inside a `oneOf` doesn't
// do (the sibling `properties` block covers it structurally, just not in a
// way strict mode can see). This is a well-known, benign ajv strict-mode
// false positive for this pattern, not a schema bug.
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateCombined = ajv.compile(KORTIX_JSON_SCHEMA as Record<string, unknown>);

function parse(input: string, format: 'toml' | 'yaml'): unknown {
  return format === 'yaml' ? parseYaml(input) : parseToml(input);
}

interface Fixture {
  name: string;
  format: 'toml' | 'yaml';
  input: string;
  /** What BOTH validators must agree on. */
  valid: boolean;
}

const FIXTURES: Fixture[] = [
  // ─── v1 ──────────────────────────────────────────────────────────────
  {
    name: 'v1: comprehensive manifest (project/env/opencode/sandbox/triggers/connectors/agents/channels/apps)',
    format: 'toml',
    valid: true,
    input: `
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
`,
  },
  {
    name: 'v1: the same manifest as YAML',
    format: 'yaml',
    valid: true,
    input: `
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
`,
  },
  {
    name: 'v1: per_user credential is tolerated (warning only, still valid)',
    format: 'toml',
    valid: true,
    input:
      'kortix_version = 1\n[[connectors]]\nslug = "gmail"\nprovider = "pipedream"\napp = "gmail"\ncredential = "per_user"',
  },
  {
    name: 'v1: legacy connector agent_scope is tolerated (warning only, still valid)',
    format: 'toml',
    valid: true,
    input:
      'kortix_version = 1\n[[connectors]]\nslug = "gmail"\nprovider = "pipedream"\napp = "gmail"\nagent_scope = ["support"]',
  },
  {
    name: 'v1: [[sandboxes]] renamed shape is a hard error',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[sandboxes]]\nslug = "py"\nimage = "python:3.12-slim"\n',
  },
  {
    name: 'v1: connector missing required slug',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[connectors]]\nprovider = "pipedream"\napp = "github"\n',
  },
  {
    name: 'v1: connector unknown provider',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[connectors]]\nslug = "x"\nprovider = "made-up"\n',
  },
  {
    name: 'v1: pipedream connector missing app',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[connectors]]\nslug = "gh"\nprovider = "pipedream"\n',
  },
  {
    name: 'v1: sandbox template missing both image and dockerfile',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[sandbox.templates]]\nslug = "py"\n',
  },
  {
    name: 'v1: sandbox template with both image and dockerfile',
    format: 'toml',
    valid: false,
    input:
      'kortix_version = 1\n[[sandbox.templates]]\nslug = "py"\nimage = "python:3.12-slim"\ndockerfile = ".kortix/Dockerfile"\n',
  },
  {
    name: 'v1: sandbox template slug reserved ("default")',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[sandbox.templates]]\nslug = "default"\nimage = "python:3.12-slim"\n',
  },
  {
    name: 'v1: cron trigger missing cron/run_at',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[triggers]]\nslug = "t"\ntype = "cron"\nprompt = "go"\n',
  },
  {
    name: 'v1: webhook trigger missing secret_env',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[triggers]]\nslug = "t"\ntype = "webhook"\nprompt = "go"\n',
  },
  {
    name: 'v1: trigger missing prompt',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[triggers]]\nslug = "t"\ntype = "cron"\ncron = "0 9 * * *"\n',
  },
  {
    name: 'v1: app missing slug',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[apps]]\nname = "site"\n',
  },
  {
    name: 'v1: app with invalid source.type',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[apps]]\nslug = "site"\n[apps.source]\ntype = "ftp"\n',
  },
  {
    name: 'v1: agent block kortix_cli non-grantable action',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[agents]]\nname = "w"\nkortix_cli = ["billing.read"]\n',
  },

  // ─── shared sections: path traversal ───────────────────────────────────
  {
    name: '[opencode].config_dir rejects a ".." traversal segment',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[opencode]\nconfig_dir = "../etc"\n',
  },
  {
    name: '[opencode].config_dir rejects an empty string',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[opencode]\nconfig_dir = ""\n',
  },
  {
    name: 'sandbox.templates[].dockerfile rejects a ".." traversal segment',
    format: 'toml',
    valid: false,
    input:
      'kortix_version = 1\n[[sandbox.templates]]\nslug = "py"\ndockerfile = "../Dockerfile"\n',
  },

  // ─── shared sections: connectors.auth ──────────────────────────────────
  {
    name: 'connectors.auth.secret is forbidden outright (credentials live in the platform)',
    format: 'toml',
    valid: false,
    input:
      'kortix_version = 1\n[[connectors]]\nslug = "x"\nprovider = "openapi"\nspec = "https://x/y.json"\n[connectors.auth]\ntype = "bearer"\nsecret = "TOK"\n',
  },
  {
    name: 'connectors.auth.type must be one of the known enum values',
    format: 'toml',
    valid: false,
    input:
      'kortix_version = 1\n[[connectors]]\nslug = "x"\nprovider = "openapi"\nspec = "https://x/y.json"\n[connectors.auth]\ntype = "oauth2"\n',
  },
  {
    name: 'connectors.auth.type oauth1 is a known enum value (openapi connector)',
    format: 'toml',
    valid: true,
    input:
      'kortix_version = 1\n[[connectors]]\nslug = "x"\nprovider = "openapi"\nspec = "https://x/y.json"\n[connectors.auth]\ntype = "oauth1"\n',
  },
  {
    name: 'channel connectors must not declare a non-"none" auth.type',
    format: 'toml',
    valid: false,
    input:
      'kortix_version = 1\n[[connectors]]\nslug = "kortix_slack"\nprovider = "channel"\nplatform = "slack"\n[connectors.auth]\ntype = "bearer"\n',
  },

  // ─── shared sections: connectors.policies ──────────────────────────────
  {
    name: 'connectors.policies entry missing `match`',
    format: 'toml',
    valid: false,
    input:
      'kortix_version = 1\n[[connectors]]\nslug = "x"\nprovider = "openapi"\nspec = "https://x/y.json"\n[[connectors.policies]]\naction = "block"\n',
  },
  {
    name: 'connectors.policies entry with an invalid `action`',
    format: 'toml',
    valid: false,
    input:
      'kortix_version = 1\n[[connectors]]\nslug = "x"\nprovider = "openapi"\nspec = "https://x/y.json"\n[[connectors.policies]]\nmatch = "*"\naction = "yolo"\n',
  },

  // ─── shared sections: reserved connector slugs ─────────────────────────
  {
    name: 'reserved slug "kortix_meet" rejects a mismatched provider',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[connectors]]\nslug = "kortix_meet"\nprovider = "pipedream"\napp = "x"\n',
  },
  {
    name: 'reserved slug "computer" rejects a mismatched (otherwise-valid) provider — regression guard for the computer-slug accept bug',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[connectors]]\nslug = "computer"\nprovider = "pipedream"\napp = "x"\n',
  },
  {
    name: 'provider="computer" is always rejected (synth-only, never hand-authored)',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[connectors]]\nslug = "computer"\nprovider = "computer"\n',
  },

  // ─── shared sections: triggers.enabled / timezone / session_mode ──────
  {
    name: 'trigger enabled accepts a case-insensitive string sentinel ("yes")',
    format: 'toml',
    valid: true,
    input:
      'kortix_version = 1\n[[triggers]]\nslug = "t"\ntype = "cron"\ncron = "0 9 * * *"\nprompt = "go"\nenabled = "yes"\n',
  },
  {
    name: 'trigger enabled rejects a non-sentinel garbage string',
    format: 'toml',
    valid: false,
    input:
      'kortix_version = 1\n[[triggers]]\nslug = "t"\ntype = "cron"\ncron = "0 9 * * *"\nprompt = "go"\nenabled = "maybe"\n',
  },
  {
    name: 'trigger timezone: an invalid IANA zone is a warning only, still valid',
    format: 'toml',
    valid: true,
    input:
      'kortix_version = 1\n[[triggers]]\nslug = "t"\ntype = "cron"\ncron = "0 9 * * *"\nprompt = "go"\ntimezone = "PST"\n',
  },
  {
    name: 'trigger session_mode accepts "reuse" (and its sessionMode alias)',
    format: 'toml',
    valid: true,
    input:
      'kortix_version = 1\n[[triggers]]\nslug = "t"\ntype = "cron"\ncron = "0 9 * * *"\nprompt = "go"\nsession_mode = "reuse"\n',
  },
  {
    name: 'trigger session_mode rejects an unknown value',
    format: 'toml',
    valid: false,
    input:
      'kortix_version = 1\n[[triggers]]\nslug = "t"\ntype = "cron"\ncron = "0 9 * * *"\nprompt = "go"\nsession_mode = "sometimes"\n',
  },

  // ─── shared sections: sandbox.default reserved sentinel ────────────────
  {
    name: 'sandbox.default = "default" (the reserved platform sentinel) is valid with no matching template',
    format: 'toml',
    valid: true,
    input: 'kortix_version = 1\n[sandbox]\ndefault = "default"\n',
  },

  // ─── shared sections: apps shapes ──────────────────────────────────────
  {
    name: 'apps: full shape (domains/source/build/env) is valid',
    format: 'toml',
    valid: true,
    input: `
kortix_version = 1
[[apps]]
slug = "site"
name = "Marketing site"
framework = "next"
enabled = true
domains = ["example.com", "www.example.com"]
[apps.source]
type = "git"
repo = "https://github.com/acme/site"
branch = "main"
[apps.build]
command = "pnpm build"
[apps.env]
NODE_ENV = "production"
`,
  },
  {
    name: 'apps: domains must be an array, not a bare string',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[apps]]\nslug = "site"\ndomains = "example.com"\n',
  },

  // ─── v2 ──────────────────────────────────────────────────────────────
  {
    name: 'v2: the full example manifest',
    format: 'yaml',
    valid: true,
    input: `
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
`,
  },
  {
    name: 'v2: flat `mode` on agent block rejected (moved to .md)',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    mode: primary\n',
  },
  {
    name: 'v2: flat `model` on agent block rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    model: anthropic/claude-sonnet-5\n',
  },
  {
    name: 'v2: flat `description` on agent block rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    description: "Handles support"\n',
  },
  {
    name: 'v2: nested `opencode:` sub-object rejected outright',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    opencode:\n      mode: primary\n',
  },
  {
    name: 'v2: flat `disable` rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    disable: true\n',
  },
  {
    name: 'v2: `permission` flat on agent block rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    permission: x\n',
  },
  {
    name: 'v2: `env` on agent block rejected (renamed to `secrets`)',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    env: [STRIPE_KEY]\n',
  },
  {
    name: 'v2: `secrets` on agent block accepted',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    secrets: [STRIPE_KEY]\n',
  },
  {
    name: 'v2: top-level [env] section unaffected',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 2\ndefault_agent: w\nenv:\n  required: [ANTHROPIC_API_KEY]\nagents:\n  w: {}\n',
  },
  {
    name: 'v2: connector credential per_user rejected outright',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nconnectors:\n  - slug: gmail\n    provider: pipedream\n    app: gmail\n    credential: per_user\n',
  },
  {
    name: 'v2: connector credential shared accepted',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nconnectors:\n  - slug: gmail\n    provider: pipedream\n    app: gmail\n    credential: shared\n',
  },
  {
    name: 'v2: connector agent_scope rejected outright',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nconnectors:\n  - slug: gmail\n    provider: pipedream\n    app: gmail\n    agent_scope: [support]\n',
  },
  {
    name: 'v2: [[channels]] rejected outright',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nchannels:\n  - platform: slack\n',
  },
  {
    name: 'v2: missing agents map',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\n',
  },
  {
    name: 'v2: empty agents map',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents: {}\n',
  },
  {
    name: 'v2: agents as a v1-style array is rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  - name: w\n',
  },
  {
    name: 'v2: invalid agent name key',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  "Not Valid":\n    workspace: runtime\n  w: {}\n',
  },
  {
    name: 'v2: kortix_cli rejects a non-grantable action',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    kortix_cli: [billing.read]\n',
  },
  {
    name: 'v2: kortix_cli accepts the wildcard',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    kortix_cli: ["*"]\n',
  },
  {
    name: 'v2: kortix_cli rejects a legacy-tolerated action outright (clean break, unlike v1\'s warn-only tolerance)',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    kortix_cli: [project.schedule.read]\n',
  },
  {
    name: 'v1: kortix_cli accepts a legacy-tolerated action (warn-only, still valid)',
    format: 'toml',
    valid: true,
    input: 'kortix_version = 1\n[[agents]]\nname = "w"\nkortix_cli = ["project.schedule.read"]\n',
  },
  {
    name: 'v2: workspace accepts the declared enum',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    workspace: branch\n',
  },
  {
    name: 'v2: unknown workspace value rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    workspace: everywhere\n',
  },
  {
    name: 'v2: skills explicit list accepted',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    skills: [pdf-export, web-research]\n',
  },
  {
    name: 'v2: skills "all" sentinel accepted',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    skills: all\n',
  },
  {
    name: 'v2: skills non-string entry rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    skills: [42]\n',
  },
  {
    name: 'v2: skills invalid sentinel string rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    skills: everything\n',
  },
  {
    name: 'v2: unknown runtime rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nruntime: codex\nagents:\n  w: {}\n',
  },
  {
    name: 'v2: runtime opencode accepted',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 2\ndefault_agent: w\nruntime: opencode\nagents:\n  w: {}\n',
  },
  {
    name: 'v2: non-boolean enabled rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    enabled: "yes"\n',
  },
  {
    name: 'v2: bare governance-only block is valid',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\n',
  },
  {
    name: 'v2: sandbox.templates carries over unchanged',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nsandbox:\n  templates:\n    - slug: py\n      image: python:3.12-slim\n',
  },
  {
    name: 'v2: connectors unknown provider still rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nconnectors:\n  - slug: wat\n    provider: made-up\n',
  },
  {
    name: 'v2: apps invalid source.type still rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\napps:\n  - slug: site\n    source:\n      type: ftp\n',
  },
];

describe('JSON Schema vs. imperative validator — accept/reject conformance', () => {
  for (const fixture of FIXTURES) {
    test(`[${fixture.format}] ${fixture.name}`, () => {
      const imperative = validateManifest(fixture.input, fixture.format);
      const parsed = parse(fixture.input, fixture.format);
      const schemaOk = validateCombined(parsed);

      expect(imperative.valid).toBe(fixture.valid);
      expect(schemaOk).toBe(fixture.valid);
    });
  }
});

describe('JSON Schema documents are themselves valid JSON Schema (ajv compiles them)', () => {
  test('kortix.v1.schema.json compiles', () => {
    expect(() => new Ajv2020({ strict: false }).compile(KORTIX_V1_JSON_SCHEMA as Record<string, unknown>)).not.toThrow();
  });

  test('kortix.v2.schema.json compiles', () => {
    expect(() => new Ajv2020({ strict: false }).compile(KORTIX_V2_JSON_SCHEMA as Record<string, unknown>)).not.toThrow();
  });

  test('kortix.schema.json (combined) compiles', () => {
    expect(() => new Ajv2020({ strict: false }).compile(KORTIX_JSON_SCHEMA as Record<string, unknown>)).not.toThrow();
  });

  test('each document declares the expected stable $id', () => {
    expect(KORTIX_V1_JSON_SCHEMA.$id).toBe('https://kortix.com/schema/kortix.v1.schema.json');
    expect(KORTIX_V2_JSON_SCHEMA.$id).toBe('https://kortix.com/schema/kortix.v2.schema.json');
    expect(KORTIX_JSON_SCHEMA.$id).toBe('https://kortix.com/schema/kortix.schema.json');
  });

  test('every document declares the 2020-12 draft', () => {
    for (const doc of [KORTIX_V1_JSON_SCHEMA, KORTIX_V2_JSON_SCHEMA, KORTIX_JSON_SCHEMA]) {
      expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    }
  });
});

// ─── Known, intentional divergences ────────────────────────────────────────
//
// These are cross-field / dynamic-set rules the imperative validator can
// enforce (it has the whole parsed document to cross-reference) that a
// static JSON Schema document cannot express without non-standard `$data`
// references. Pinned down explicitly, in both directions, so a change that
// narrows OR widens this gap is a deliberate diff here — not a silent one.
describe('Known divergence: cross-field rules only the imperative validator enforces', () => {
  test('default_agent naming an undeclared agent: imperative rejects, schema (structurally) accepts', () => {
    const yaml = 'kortix_version: 2\ndefault_agent: ghost\nagents:\n  w: {}\n';
    expect(validateManifest(yaml, 'yaml').valid).toBe(false);
    expect(validateCombined(parseYaml(yaml))).toBe(true);
  });

  test("a trigger's agent naming an undeclared agent: imperative rejects, schema accepts", () => {
    const yaml =
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\ntriggers:\n  - slug: t\n    type: cron\n    cron: "0 9 * * *"\n    prompt: go\n    agent: ghost\n';
    expect(validateManifest(yaml, 'yaml').valid).toBe(false);
    expect(validateCombined(parseYaml(yaml))).toBe(true);
  });

  test('sandbox.default naming an undeclared template: imperative rejects, schema accepts', () => {
    const yaml =
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nsandbox:\n  default: ghost\n  templates:\n    - slug: py\n      image: python:3.12-slim\n';
    expect(validateManifest(yaml, 'yaml').valid).toBe(false);
    expect(validateCombined(parseYaml(yaml))).toBe(true);
  });

  test('kortix_version 2 in a .toml file: imperative rejects (format-aware), schema accepts (format-blind)', () => {
    const toml = 'kortix_version = 2\ndefault_agent = "w"\n[agents.w]\n';
    expect(validateManifest(toml, 'toml').valid).toBe(false);
    expect(validateCombined(parseToml(toml))).toBe(true);
  });

  test('auth.type oauth1 on a non-openapi/http connector: imperative rejects, schema accepts', () => {
    const toml =
      'kortix_version = 1\n[[connectors]]\nslug = "g"\nprovider = "graphql"\nendpoint = "https://x/graphql"\n[connectors.auth]\ntype = "oauth1"\n';
    expect(validateManifest(toml, 'toml').valid).toBe(false);
    expect(validateCombined(parseToml(toml))).toBe(true);
  });
});
