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
import { KORTIX_JSON_SCHEMA, KORTIX_V1_JSON_SCHEMA, KORTIX_V2_JSON_SCHEMA, KORTIX_V3_JSON_SCHEMA } from '../json-schema';
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

import { GOLDEN_V3 } from './fixtures/golden-v3.ts';

function swapV3(from: string, to: string): string {
  if (!GOLDEN_V3.includes(from)) throw new Error(`golden v3 manifest has no "${from}"`);
  return GOLDEN_V3.replace(from, to);
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
    name: 'v1: comprehensive manifest (project/env/opencode/sandbox/triggers/connectors/agents/channels)',
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
kortix_permissions = ["project.read", "project.session.start"]
env = ["STRIPE_KEY"]

[[agents]]
name = "pr-bot"
connectors = "all"
kortix_permissions = ["*"]

[[channels]]
platform = "slack"
enabled = true
events = ["message"]

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
    kortix_permissions: [project.read, project.session.start]
    env: [STRIPE_KEY]
  - name: pr-bot
    connectors: all
    kortix_permissions: ["*"]
channels:
  - platform: slack
    enabled: true
    events: [message]
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
    input:
      'kortix_version = 1\n[[sandbox.templates]]\nslug = "default"\nimage = "python:3.12-slim"\n',
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
    name: 'v1: retired apps section is rejected',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[apps]]\nslug = "site"\n',
  },
  {
    name: 'v1: agent block kortix_permissions non-grantable action',
    format: 'toml',
    valid: false,
    input: 'kortix_version = 1\n[[agents]]\nname = "w"\nkortix_permissions = ["billing.read"]\n',
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
    input: 'kortix_version = 1\n[[sandbox.templates]]\nslug = "py"\ndockerfile = "../Dockerfile"\n',
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
    name: 'connectors.auth supports API key cookie, HMAC, SigV4, and mTLS modes',
    format: 'toml',
    valid: true,
    input:
      'kortix_version = 1\n' +
      '[[connectors]]\nslug = "api-key"\nprovider = "http"\nbase_url = "https://x"\n' +
      '[connectors.auth]\ntype = "api_key"\nin = "cookie"\nname = "session_key"\n' +
      '[[connectors]]\nslug = "signed"\nprovider = "http"\nbase_url = "https://x"\n' +
      '[connectors.auth]\ntype = "hmac"\nname = "X-Signature"\n' +
      '[[connectors]]\nslug = "aws"\nprovider = "http"\nbase_url = "https://x"\n' +
      '[connectors.auth]\ntype = "aws_sigv4"\n' +
      '[[connectors]]\nslug = "mtls"\nprovider = "http"\nbase_url = "https://x"\n' +
      '[connectors.auth]\ntype = "mtls"\n',
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
    name: 'reserved slug "computer" rejects a mismatched (otherwise-valid) provider — regression guard for the computer-slug accept bug',
    format: 'toml',
    valid: false,
    input:
      'kortix_version = 1\n[[connectors]]\nslug = "computer"\nprovider = "pipedream"\napp = "x"\n',
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

  // ─── shared sections: triggers type = "event" ─────────────────────────
  {
    name: 'event: connector + event + config object is valid',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    config: { owner: acme }\n    prompt: go\n',
  },
  {
    name: 'event: config is optional',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    prompt: go\n',
  },
  {
    name: 'event: missing connector is rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: event\n    event: X\n    prompt: go\n',
  },
  {
    name: 'event: missing event is rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: event\n    connector: github\n    prompt: go\n',
  },
  {
    name: 'event: config must be an object',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    config: nope\n    prompt: go\n',
  },
  {
    name: 'event: cron key on event is rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    cron: "0 9 * * *"\n    prompt: go\n',
  },
  {
    name: 'event: secret_env on event is rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    secret_env: HOOK_SECRET\n    prompt: go\n',
  },
  {
    name: 'event: account label is valid',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    account: acme-bot\n    prompt: go\n',
  },
  {
    name: 'event: empty account is rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    account: ""\n    prompt: go\n',
  },
  {
    name: 'event: non-string account is rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    account: 7\n    prompt: go\n',
  },
  {
    name: 'cron: account is rejected (event only)',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: cron\n    cron: "0 9 * * *"\n    account: acme-bot\n    prompt: go\n',
  },
  {
    name: 'webhook: account is rejected (event only)',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: webhook\n    secret_env: S\n    account: acme-bot\n    prompt: go\n',
  },
  {
    name: 'monitor: account is rejected (event only)',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: stream\n    account: acme-bot\n    prompt: go\n',
  },
  {
    name: 'event: source adapter is valid',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    source: composio\n    prompt: go\n',
  },
  {
    name: 'event: empty source is rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    source: ""\n    prompt: go\n',
  },
  {
    name: 'event: non-string source is rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    source: 7\n    prompt: go\n',
  },
  {
    name: 'cron: source is rejected (event only)',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: cron\n    cron: "0 9 * * *"\n    source: composio\n    prompt: go\n',
  },
  {
    name: 'webhook: source is rejected (event only)',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: webhook\n    secret_env: S\n    source: composio\n    prompt: go\n',
  },
  {
    name: 'monitor: source is rejected (event only)',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: stream\n    source: composio\n    prompt: go\n',
  },
  {
    name: 'cron: event keys on cron are rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: cron\n    cron: "0 9 * * *"\n    connector: github\n    prompt: go\n',
  },
  {
    name: 'webhook: config on webhook is rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: webhook\n    secret_env: HOOK_SECRET\n    config: {}\n    prompt: go\n',
  },

  // ─── shared sections: triggers type = "monitor" ───────────────────────
  {
    name: 'monitor: a stream monitor with run + mode is valid',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: monitor\n    run: ./monitors/t.ts\n    mode: stream\n    prompt: go\n',
  },
  {
    name: 'monitor: a poll monitor with an interval is valid',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: monitor\n    run: ./monitors/t.ts\n    mode: poll\n    interval: 60s\n    expect_event_within: 24h\n    prompt: go\n',
  },
  {
    name: 'monitor: missing run + mode is rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 1\ntriggers:\n  - slug: t\n    type: monitor\n    prompt: go\n',
  },
  {
    name: 'monitor: mode = poll without an interval is rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: poll\n    prompt: go\n',
  },
  {
    name: 'monitor: an interval on a stream monitor is rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: stream\n    interval: 60s\n    prompt: go\n',
  },
  {
    name: 'monitor: an unknown mode is rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: tail\n    prompt: go\n',
  },
  {
    name: 'monitor: cron wiring on a monitor is rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: stream\n    cron: "0 9 * * *"\n    prompt: go\n',
  },
  {
    name: 'monitor: secret_env on a monitor is rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: stream\n    secret_env: HOOK_SECRET\n    prompt: go\n',
  },
  {
    name: 'monitor: a malformed duration is rejected by both validators',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: poll\n    interval: soon\n    prompt: go\n',
  },

  // ─── shared sections: sandbox.default reserved sentinel ────────────────
  {
    name: 'sandbox.default = "default" (the reserved platform sentinel) is valid with no matching template',
    format: 'toml',
    valid: true,
    input: 'kortix_version = 1\n[sandbox]\ndefault = "default"\n',
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
    kortix_permissions: [project.session.start, project.cr.open]
    workspace: runtime
  pr-bot:
    connectors: [github]
    kortix_permissions: [project.cr.open, project.cr.merge, project.review.submit]

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
    name: 'v2: `file` names the agent .md',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    file: agents/a.md\n',
  },
  {
    name: 'v2: `file` rejects a traversal segment',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    file: ../a.md\n',
  },
  {
    name: 'v2: `file` rejects a non-.md file',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    file: agents/a.txt\n',
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
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    model: anthropic/claude-sonnet-5\n',
  },
  {
    name: 'v2: flat `description` on agent block rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    description: "Handles support"\n',
  },
  {
    name: 'v2: nested `opencode:` sub-object rejected outright',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    opencode:\n      mode: primary\n',
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
    name: 'v2: canonical required connector subset accepted',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    connectors: [gmail]\n    connectors_required: [gmail]\n',
  },
  {
    name: 'v2: deprecated required connector input alias accepted',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    connectors: [gmail]\n    connectors_personal: [gmail]\n',
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
    name: 'v2: connector project authorization strategy accepted',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nconnectors:\n  - slug: gmail-shared\n    name: Shared Gmail\n    provider: pipedream\n    app: gmail\n    authorization_strategy: project\n',
  },
  {
    name: 'v2: connector user authorization strategy accepted',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nconnectors:\n  - slug: gmail-personal\n    name: Personal Gmail\n    provider: pipedream\n    app: gmail\n    authorization_strategy: user\n',
  },
  {
    name: 'v2: connector both authorization strategy rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nconnectors:\n  - slug: gmail\n    provider: pipedream\n    app: gmail\n    authorization_strategy: both\n',
  },
  {
    name: 'v2: connector blank name rejected',
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nconnectors:\n  - slug: gmail\n    name: ""\n    provider: pipedream\n    app: gmail\n',
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
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nchannels:\n  - platform: slack\n',
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
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  "Not Valid":\n    workspace: runtime\n  w: {}\n',
  },
  {
    name: 'v2: kortix_permissions rejects a non-grantable action',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    kortix_permissions: [billing.read]\n',
  },
  {
    name: 'v2: kortix_permissions accepts the wildcard',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    kortix_permissions: ["*"]\n',
  },
  {
    name: "v2: kortix_permissions rejects a legacy-tolerated action outright (clean break, unlike v1's warn-only tolerance)",
    format: 'yaml',
    valid: false,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    kortix_permissions: [project.schedule.read]\n',
  },
  {
    name: 'v2: deprecated kortix_cli alias is still accepted (warn-only)',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    kortix_cli: [project.read]\n',
  },
  {
    name: 'v1: deprecated kortix_cli alias is still accepted (warn-only)',
    format: 'toml',
    valid: true,
    input: 'kortix_version = 1\n[[agents]]\nname = "w"\nkortix_cli = ["project.read"]\n',
  },
  {
    name: 'v2: deprecated kortix_cli alias still rejects a non-grantable action',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    kortix_cli: [billing.read]\n',
  },
  {
    name: 'v1: kortix_permissions accepts a legacy-tolerated action (warn-only, still valid)',
    format: 'toml',
    valid: true,
    input: 'kortix_version = 1\n[[agents]]\nname = "w"\nkortix_permissions = ["project.schedule.read"]\n',
  },
  { name: "v2: repository access false", format: 'yaml', valid: true, input: "kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    repository_access: false\n" },
  { name: "v2: repository access true", format: 'yaml', valid: true, input: "kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    repository_access: true\n" },
  { name: "v2: repository access \"false\"", format: 'yaml', valid: false, input: "kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    repository_access: \"false\"\n" },
  { name: "v2: repository access null", format: 'yaml', valid: false, input: "kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    repository_access: null\n" },
  { name: "v2: repository access true\n    workspace: runtime", format: 'yaml', valid: false, input: "kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    repository_access: true\n    workspace: runtime\n" },
  { name: "v2: repository access false\n    workspace: runtime", format: 'yaml', valid: true, input: "kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    repository_access: false\n    workspace: runtime\n" },
  { name: 'v2: workspace.project_repository false', format: 'yaml', valid: true, input: 'kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    workspace:\n      project_repository: false\n' },
  { name: 'v2: workspace.project_repository true', format: 'yaml', valid: true, input: 'kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    workspace:\n      project_repository: true\n' },
  { name: 'v2: empty workspace map', format: 'yaml', valid: true, input: 'kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    workspace: {}\n' },
  { name: 'v2: workspace.project_repository "false"', format: 'yaml', valid: false, input: 'kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    workspace:\n      project_repository: "false"\n' },
  { name: 'v2: unknown workspace key', format: 'yaml', valid: false, input: 'kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    workspace:\n      project_repo: false\n' },
  { name: 'v2: workspace list', format: 'yaml', valid: false, input: 'kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    workspace: [project_repository]\n' },
  { name: 'v2: matching repository_access alias', format: 'yaml', valid: true, input: 'kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    repository_access: false\n    workspace:\n      project_repository: false\n' },
  { name: 'v2: conflicting repository_access alias', format: 'yaml', valid: false, input: 'kortix_version: 2\ndefault_agent: a\nagents:\n  a:\n    repository_access: true\n    workspace:\n      project_repository: false\n' },
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
    name: 'v2: declarative agent egress policy accepted (not enforced)',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    network_egress:\n      version: 1\n      default: deny\n      rules: []\n',
  },
  {
    name: 'v2: unknown egress policy version rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    network_egress:\n      version: 2\n      default: deny\n      rules: []\n',
  },
  {
    name: 'v2: skills explicit list accepted',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    skills: [pdf-export, web-research]\n',
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
    name: 'v2: apps explicit slug list accepted',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    apps: [reports-dashboard]\n',
  },
  {
    name: 'v2: apps "none" sentinel accepted',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    apps: none\n',
  },
  {
    name: 'v2: apps non-string entry rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    apps: [42]\n',
  },
  {
    name: 'v2: apps invalid sentinel rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    apps: everything\n',
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
    name: 'v2: OpenCode plugins per agent',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 2\ndefault_agent: w\nharnesses:\n  opencode:\n    plugins: [audit.ts]\nagents:\n  w:\n    harnesses:\n      opencode:\n        exclude: [audit.ts]\n        plugins: [other.js]\n',
  },
  {
    name: 'v2: OpenCode plugin path traversal rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    harnesses:\n      opencode:\n        plugins: [../bad.ts]\n',
  },
  {
    name: 'v2: harnesses.pi.packages with npm pins, a filtered entry and a repo path is accepted',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 2\ndefault_agent: w\nruntime: pi\nagents:\n  w: {}\nharnesses:\n  pi:\n    packages:\n      - npm:pi-web-access@0.30.0\n      - source: npm:@juicesharp/rpiv-todo@1.2.0\n        extensions: ["extensions/*.ts"]\n        skills: []\n      - ./.kortix/pi/audit.ts\n',
  },
  {
    name: 'v2: agent-level harnesses.pi packages and exclude accepted',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 2\ndefault_agent: w\nharnesses:\n  pi:\n    packages: [npm:pi-web-access@0.30.0, ./.kortix/pi/audit.ts]\nagents:\n  w:\n    harnesses:\n      pi:\n        packages: [npm:@juicesharp/rpiv-todo@2.11.0]\n        exclude: [pi-web-access, ./.kortix/pi/audit.ts]\n',
  },
  {
    name: 'v2: agent-level exclude with a version rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    harnesses:\n      pi:\n        exclude: [npm:pi-web-access@0.30.0]\n',
  },
  {
    name: 'v2: exclude at the top level rejected (it removes global packages for one agent)',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nharnesses:\n  pi:\n    exclude: [pi-web-access]\n',
  },
  {
    name: 'v2: harnesses.pi.packages npm source without an exact version rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nharnesses:\n  pi:\n    packages:\n      - npm:pi-web-access@^0.30.0\n',
  },
  {
    name: 'v2: harnesses.pi.packages git source rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nharnesses:\n  pi:\n    packages:\n      - git:github.com/acme/pi-tools@v1\n',
  },
  {
    name: 'v2: harnesses.pi.packages path escaping the repo rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nharnesses:\n  pi:\n    packages:\n      - ../outside.ts\n',
  },
  {
    name: 'v2: harnesses.pi.codemode at the top level and on an agent accepted',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 2\ndefault_agent: w\nharnesses:\n  pi:\n    codemode: only\nagents:\n  w:\n    harnesses:\n      pi:\n        codemode: off\n',
  },
  {
    name: 'v2: harnesses.pi.codemode outside off, on, only rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nharnesses:\n  pi:\n    codemode: yes\n',
  },
  {
    name: 'v2: an unknown harness rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nharnesses:\n  codex:\n    packages: []\n',
  },
  {
    name: 'v2: an unknown key under harnesses.pi rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\nharnesses:\n  pi:\n    extensions: [npm:pi-web-access@0.30.0]\n',
  },
  {
    name: 'v3: inline YAML agent behavior',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 3\ndefault_agent: w\nagents:\n  w:\n    model: test/model\n    prompt: Be brief.\n    permission:\n      bash: deny\n',
  },
  {
    name: 'v2: v3 prompt_file rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    prompt_file: agents/w.md\n',
  },
  {
    name: 'v3: raw OpenCode configuration rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 3\ndefault_agent: w\nagents:\n  w: {}\nopencode:\n  config_dir: .opencode\n',
  },
  {
    name: 'v3: invalid prompt',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 3\ndefault_agent: w\nagents:\n  w:\n    prompt: [bad]\n',
  },
  {
    name: 'v3: the golden manifest',
    format: 'yaml',
    valid: true,
    input: GOLDEN_V3,
  },
  {
    name: 'v3: harnesses rejected',
    format: 'yaml',
    valid: false,
    input: swapV3('default_agent: assistant\n', 'default_agent: assistant\nharnesses:\n  pi:\n    codemode: on\n'),
  },
  {
    name: 'v3: top-level permission rejected',
    format: 'yaml',
    valid: false,
    input: swapV3('default_agent: assistant\n', 'default_agent: assistant\npermission: allow\n'),
  },
  {
    name: 'v3: an unknown top-level key rejected',
    format: 'yaml',
    valid: false,
    input: swapV3('default_agent: assistant\n', 'default_agent: assistant\nagentz: {}\n'),
  },
  {
    name: 'v3: a kortix- project skill rejected',
    format: 'yaml',
    valid: false,
    input: swapV3('pdf: skills/pdf', 'kortix-pdf: skills/kortix-pdf'),
  },
  {
    name: 'v3: kortix:<name> tool value rejected',
    format: 'yaml',
    valid: false,
    input: swapV3('lookup_order: tools/lookup_order.ts', 'lookup_order: kortix:web_search'),
  },
  {
    name: 'v3: a command with prompt and prompt_file rejected',
    format: 'yaml',
    valid: false,
    input: swapV3('    prompt: Summarize', '    prompt_file: x.md\n    prompt: Summarize'),
  },
  {
    name: 'v3: a command agent key rejected',
    format: 'yaml',
    valid: false,
    input: swapV3('    prompt: Summarize', '    agent: assistant\n    prompt: Summarize'),
  },
  {
    name: 'v3: an empty extension rejected',
    format: 'yaml',
    valid: false,
    input: swapV3('  web-access:\n    pi: npm:pi-web-access@0.30.0', '  web-access: {}'),
  },
  {
    name: 'v3: an npm OpenCode plugin rejected',
    format: 'yaml',
    valid: false,
    input: swapV3('opencode: extensions/audit.opencode.ts', 'opencode: npm:audit@1.0.0'),
  },
  {
    name: 'v3: a ranged pi pin rejected',
    format: 'yaml',
    valid: false,
    input: swapV3('pi: npm:pi-web-access@0.30.0', 'pi: npm:pi-web-access@^0.30.0'),
  },
  {
    name: 'v3: agent file rejected',
    format: 'yaml',
    valid: false,
    input: swapV3('    mode: primary\n', '    mode: primary\n    file: agents/a.md\n'),
  },
  {
    name: 'v3: agent harnesses rejected',
    format: 'yaml',
    valid: false,
    input: swapV3('    mode: primary\n', '    mode: primary\n    harnesses: {}\n'),
  },
  {
    name: 'v3: permission.skill rejected',
    format: 'yaml',
    valid: false,
    input: swapV3('      external_directory: deny', '      skill: allow'),
  },
  {
    name: 'v3: tools map form rejected',
    format: 'yaml',
    valid: false,
    input: swapV3('    tools: all\n', '    tools:\n      bash: false\n'),
  },
  {
    name: 'v3: bad codemode rejected',
    format: 'yaml',
    valid: false,
    input: swapV3('codemode: on', 'codemode: maybe'),
  },
  {
    name: 'v2: tools mixes kortix:<name> and module paths',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\ntools:\n  web_search: kortix:web_search\n  memory: tools/memory.ts\n  lookup_order: tools/lookup_order.ts\n',
  },
  {
    name: 'v2: a tools key with every line deleted (null) is accepted',
    format: 'yaml',
    valid: true,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\ntools:\n',
  },
  {
    name: 'v2: kortix:<name> under another Kortix tool name rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\ntools:\n  web_search: kortix:image_search\n',
  },
  {
    name: 'v2: kortix:<name> for a name that is no Kortix tool rejected',
    format: 'yaml',
    valid: false,
    input: 'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\ntools:\n  web_serch: kortix:web_serch\n',
  },
  {
    name: 'v2: Kortix Apps map is accepted',
    format: 'yaml',
    valid: true,
    input:
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\napps:\n  site:\n    path: .\n    type: static\n    readiness_path: /\n',
  },
];

// Blank companions are absent values for sandbox selection, not competing keys.
for (const image of [undefined, '', '   ', 'python:3.12']) {
  for (const dockerfile of [undefined, '', '   ', 'Dockerfile']) {
    FIXTURES.push({
      name: `sandbox nonblank XOR: image=${JSON.stringify(image)}, dockerfile=${JSON.stringify(dockerfile)}`,
      format: 'yaml',
      input: `kortix_version: 1\nsandbox:\n  templates:\n    - ${JSON.stringify({ slug: 'worker', image, dockerfile })}\n`,
      valid: Number(Boolean(image?.trim())) + Number(Boolean(dockerfile?.trim())) === 1,
    });
  }
}
for (const field of ['prompt', 'connector', 'event', 'account', 'source']) {
  for (const blank of ['', '   ', '\t\n', '\u00a0']) {
    FIXTURES.push({
      name: `event nonblank ${field}: ${JSON.stringify(blank)}`,
      format: 'yaml',
      input: `kortix_version: 1\ntriggers:\n  - ${JSON.stringify({ slug: 'events', type: 'event', prompt: 'Handle event', connector: 'github', event: 'push', [field]: blank })}\n`,
      valid: false,
    });
  }
}

// Cover blank rejection across the trim-checked field families.
for (const blank of ['   ', '\t\n', '\u00a0']) {
  const cases: Array<[string, object]> = [
    ['opencode path', { opencode: { config_dir: blank } }],
    ['sandbox default', { sandbox: { templates: [{ slug: 'worker', image: 'python:3.12' }], default: blank } }],
    ['grant item', { agents: [{ name: 'worker', connectors: [blank] }] }],
    ['connector name', { connectors: [{ slug: 'github', provider: 'composio', name: blank }] }],
    ['policy match', { connectors: [{ slug: 'github', provider: 'composio', policies: [{ match: blank, action: 'allow' }] }] }],
    ['channel platform', { channels: [{ platform: blank }] }],
    ['monitor run', { triggers: [{ slug: 'watch', type: 'monitor', prompt: 'Watch', run: blank, mode: 'daemon', expect_event_within: '5m' }] }],
  ];
  for (const [name, fields] of cases) {
    FIXTURES.push({ name: `${name} rejects blank ${JSON.stringify(blank)}`, format: 'yaml', valid: false, input: JSON.stringify({ kortix_version: 1, ...fields }) });
  }
}
for (const [prompt, prompt_template, valid] of [
  ['Handle event', '', true], ['', 'Handle event', false], [undefined, '   ', false],
] as const) {
  FIXTURES.push({ name: `prompt alias precedence ${JSON.stringify([prompt, prompt_template])}`, format: 'yaml', valid, input: JSON.stringify({ kortix_version: 1, triggers: [{ slug: 'events', type: 'event', prompt, prompt_template, connector: 'github', event: 'push' }] }) });
}
for (const blank of ['   ', '\t\n', '\u00a0']) {
  const cases: Array<[string, object]> = [
    ['app env', { apps: { site: { type: 'static', path: '.', env: { KEY: blank } } } }],
    ['app secrets', { apps: { site: { type: 'static', path: '.', secrets: { KEY: blank } } } }],
    ['app path', { apps: { site: { type: 'static', path: blank } } }],
    ['required connector', { agents: { worker: { connectors_required: [blank] } } }],
    ['legacy required connector', { agents: { worker: { connectors_personal: [blank] } } }],
    ['tool name', { agents: { worker: { tools: [blank] } } }],
    ['default agent', { default_agent: blank }],
  ];
  for (const [name, fields] of cases) {
    FIXTURES.push({ name: `${name} rejects blank ${JSON.stringify(blank)}`, format: 'yaml', valid: false, input: JSON.stringify({ kortix_version: 2, default_agent: 'worker', agents: { worker: {} }, ...fields }) });
  }
  for (const field of ['prompt', 'commands']) {
    FIXTURES.push({ name: `v3 ${field} rejects blank ${JSON.stringify(blank)}`, format: 'yaml', valid: false, input: JSON.stringify({ kortix_version: 3, default_agent: 'worker', agents: { worker: field === 'prompt' ? { prompt: blank } : {} }, ...(field === 'commands' ? { commands: { greet: { prompt: blank } } } : {}) }) });
  }
}
for (const image of ['', '   ', '\t\n', '\u00a0', 'python:3.12']) {
  FIXTURES.push({ name: `OCI image nonblank ${JSON.stringify(image)}`, format: 'yaml', valid: image === 'python:3.12', input: JSON.stringify({ kortix_version: 2, default_agent: 'worker', agents: { worker: {} }, apps: { site: { type: 'oci_image', image, command: ['node'], port: 3000 } } }) });
}
// Trigger aliases use canonical-field precedence; pinned IDs alone must be nonblank.
for (const version of [1, 2, 3]) {
  const base = version === 1 ? {} : { default_agent: 'worker', agents: { worker: {} } };
  const cases: Array<[string, object, boolean]> = [
    ['blank agent', { agent: '   ' }, version === 1],
    ['blank legacy agent', { agent_name: '   ' }, true],
    ['blank unpinned ID', { session_id: '   ' }, true],
    ['pinned missing ID', { session_mode: 'pinned' }, false],
    ['pinned blank ID', { session_mode: 'pinned', session_id: '   ' }, false],
    ['pinned blank alias ID', { sessionMode: 'pinned', sessionId: '\t\n' }, false],
    ['canonical blank overrides ID alias', { session_mode: 'pinned', session_id: '   ', sessionId: 'synthetic-session' }, false],
    ['canonical ID overrides blank alias', { session_mode: 'pinned', session_id: 'synthetic-session', sessionId: '   ' }, true],
    ['canonical mode overrides pinned alias', { session_mode: 'fresh', sessionMode: 'pinned', session_id: '   ' }, true],
    // Case variants normalize to "pinned" in the validator (trim+toLowerCase), so
    // the schema guard must fire on them too — without the ID they must be
    // rejected by BOTH sides.
    ['case-variant pinned missing ID', { session_mode: 'PINNED' }, false],
    ['case-variant pinned alias blank ID', { sessionMode: 'Pinned', sessionId: '   ' }, false],
    ['case-variant pinned with ID', { session_mode: 'PINNED', session_id: 'synthetic-session' }, true],
  ];
  for (const [name, fields, valid] of cases) {
    FIXTURES.push({ name: `v${version} trigger ${name}`, format: 'yaml', valid, input: JSON.stringify({ kortix_version: version, ...base, triggers: [{ slug: 'tick', type: 'cron', cron: '0 9 * * *', prompt: 'Go', ...fields }] }) });
  }
}
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

describe('normalized enum conformance (KRTX-2538)', () => {
  const cases = [
    ['provider', 'connectors: [{slug: sample, provider: " MCP ", url: "https://example.test/mcp"}]'],
    ['transport', 'connectors: [{slug: sample, provider: mcp, url: "https://example.test/mcp", transport: " SSE "}]'],
    ['platform', 'connectors: [{slug: sample, provider: channel, platform: " Slack "}]'],
    ['credential', 'connectors: [{slug: sample, provider: mcp, url: "https://example.test/mcp", credential: " Shared "}]'],
    ['authorization_strategy', 'connectors: [{slug: sample, provider: mcp, url: "https://example.test/mcp", authorization_strategy: " User "}]'],
    ['auth.type', 'connectors: [{slug: sample, provider: mcp, url: "https://example.test/mcp", auth: {type: " None "}}]'],
    ['policy action', 'connectors: [{slug: sample, provider: mcp, url: "https://example.test/mcp", policies: [{match: "*", action: " Block "}]}]'],
    ['session_mode', 'triggers: [{slug: nightly, type: cron, cron: "0 9 * * *", prompt: Digest, session_mode: " Reuse "}]'],
    ['sessionMode', 'triggers: [{slug: nightly, type: cron, cron: "0 9 * * *", prompt: Digest, sessionMode: " Reuse "}]'],
    ['grant', 'agents: {assistant: {connectors: ""}}'],
  ];
  for (const [name, section] of cases) {
    test(`${name} accepts normalized values`, () => {
      const input = `kortix_version: 2\ndefault_agent: assistant\n${section.startsWith('agents:') ? section : `agents: {assistant: {}}\n${section}`}\n`;
      expect(validateManifest(input, 'yaml').valid).toBe(true);
      expect(validateCombined(parseYaml(input))).toBe(true);
    });
  }
});

describe('normalized enums retain their boundaries', () => {
  for (const provider of ['computer', 'mcp-extra', '', 'mcp\nextra']) {
    test(`rejects provider ${JSON.stringify(provider)}`, () => {
      const input = { kortix_version: 2, default_agent: 'assistant', agents: { assistant: {} },
        connectors: [{ slug: 'sample', provider, url: 'https://example.test/mcp' }] };
      expect(validateManifest(JSON.stringify(input), 'yaml').valid).toBe(false);
      expect(validateCombined(input)).toBe(false);
    });
  }
  test('normalized provider still requires its endpoint', () => {
    const input = 'kortix_version: 2\ndefault_agent: assistant\nagents: {assistant: {}}\nconnectors: [{slug: sample, provider: " MCP "}]';
    expect(validateManifest(input, 'yaml').valid).toBe(false);
    expect(validateCombined(parseYaml(input))).toBe(false);
  });
  test('reserved channel provider and auth accept normalized values', () => {
    const input = 'kortix_version: 2\ndefault_agent: assistant\nagents: {assistant: {}}\nconnectors: [{slug: kortix_slack, provider: " Channel ", platform: " Slack ", auth: {type: " None "}}]';
    expect(validateManifest(input, 'yaml').valid).toBe(true);
    expect(validateCombined(parseYaml(input))).toBe(true);
  });
});

describe('normalized enums fold Unicode case equivalents (KRTX-2538)', () => {
  // The validator matches with `trim().toLowerCase()` (`./index.ts`), and JS
  // `toLowerCase()` is Unicode-aware: U+212A KELVIN SIGN folds to "k", so the
  // fixture value "\u212Aeyed" (KELVIN SIGN + "eyed" — it looks like Keyed but
  // the K is the Kelvin sign) normalizes to "keyed", and the schema pattern
  // must accept it too. A full scan of Unicode finds no other non-ASCII code
  // point whose `toLowerCase()` is a single ASCII letter — U+017F is already
  // lowercase, fullwidth Ｋ folds to fullwidth ｋ, and İ expands to two code
  // points — so those stay rejected by BOTH sides, pinned below as the
  // boundary.
  const kelvinKeyed = '\u212Aeyed';
  const kelvinSlack = 'SLAC\u212A';
  test('session_mode accepts a KELVIN SIGN k', () => {
    const input = `kortix_version: 2\ndefault_agent: assistant\nagents: {assistant: {}}\ntriggers: [{slug: nightly, type: cron, cron: "0 9 * * *", prompt: Digest, session_mode: "${kelvinKeyed}"}]\n`;
    expect(validateManifest(input, 'yaml').valid).toBe(true);
    expect(validateCombined(parseYaml(input))).toBe(true);
  });
  test('platform accepts a KELVIN SIGN k', () => {
    const input = `kortix_version: 2\ndefault_agent: assistant\nagents: {assistant: {}}\nconnectors: [{slug: sample, provider: channel, platform: "${kelvinSlack}"}]\n`;
    expect(validateManifest(input, 'yaml').valid).toBe(true);
    expect(validateCombined(parseYaml(input))).toBe(true);
  });
  test('a fullwidth K stays rejected by both (folds to fullwidth k, not "k")', () => {
    const input = { kortix_version: 2, default_agent: 'assistant', agents: { assistant: {} },
      triggers: [{ slug: 'nightly', type: 'cron', cron: '0 9 * * *', prompt: 'Digest', session_mode: '\uFF2Beyed' }] };
    expect(validateManifest(JSON.stringify(input), 'yaml').valid).toBe(false);
    expect(validateCombined(input)).toBe(false);
  });
  test('a dotted capital I stays rejected by both (folds to two code points)', () => {
    const input = { kortix_version: 2, default_agent: 'assistant', agents: { assistant: {} },
      connectors: [{ slug: 'sample', provider: 'p\u0130pedream', url: 'https://example.test/mcp' }] };
    expect(validateManifest(JSON.stringify(input), 'yaml').valid).toBe(false);
    expect(validateCombined(input)).toBe(false);
  });
});

describe('JSON Schema documents are themselves valid JSON Schema (ajv compiles them)', () => {
  test('kortix.v1.schema.json compiles', () => {
    expect(() =>
      new Ajv2020({ strict: false }).compile(KORTIX_V1_JSON_SCHEMA as Record<string, unknown>),
    ).not.toThrow();
  });

  test('kortix.v2.schema.json compiles', () => {
    expect(() =>
      new Ajv2020({ strict: false }).compile(KORTIX_V2_JSON_SCHEMA as Record<string, unknown>),
    ).not.toThrow();
  });

  test('kortix.v3.schema.json compiles', () => {
    expect(() => new Ajv2020({ strict: false }).compile(KORTIX_V3_JSON_SCHEMA as Record<string, unknown>)).not.toThrow();
  });

  test('kortix.schema.json (combined) compiles', () => {
    expect(() =>
      new Ajv2020({ strict: false }).compile(KORTIX_JSON_SCHEMA as Record<string, unknown>),
    ).not.toThrow();
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

  test('connector fields are discoverable in the versioned schema', () => {
    const connectorProperties = (
      KORTIX_V2_JSON_SCHEMA as {
        properties: {
          connectors: { items: { properties: Record<string, unknown> } };
        };
      }
    ).properties.connectors.items.properties;
    expect(connectorProperties.name).toEqual({ type: 'string', pattern: '\\S' });
    expect(connectorProperties.authorization_strategy).toEqual({
      type: 'string',
      anyOf: [
        { enum: ['project', 'user'] },
        { pattern: expect.any(String) },
      ],
      default: 'project',
    });
  });

  test('required connector fields publish canonical and deprecated annotations', () => {
    const agentProperties = (
      KORTIX_V2_JSON_SCHEMA as {
        properties: {
          agents: {
            additionalProperties: { properties: Record<string, Record<string, unknown>> };
          };
        };
      }
    ).properties.agents.additionalProperties.properties;
    expect(agentProperties.connectors_required?.description).toContain('must resolve');
    expect(agentProperties.connectors_personal).toMatchObject({
      deprecated: true,
      description: 'Deprecated input alias for connectors_required.',
    });
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

  // A monitor's duration FLOORS (interval ≥ 30s, expect_event_within ≥ 5m)
  // are value ranges over a formatted string. JSON Schema can pin the shape
  // (`DURATION_RE`) but not the magnitude, so the floors stay imperative-only.
  test('monitor interval below the 30s floor: imperative rejects, schema accepts the shape', () => {
    const yaml =
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: poll\n    interval: 5s\n    prompt: go\n';
    expect(validateManifest(yaml, 'yaml').valid).toBe(false);
    expect(validateCombined(parseYaml(yaml))).toBe(true);
  });

  test('monitor expect_event_within below the 5m floor: imperative rejects, schema accepts the shape', () => {
    const yaml =
      'kortix_version: 1\ntriggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: stream\n    expect_event_within: 60s\n    prompt: go\n';
    expect(validateManifest(yaml, 'yaml').valid).toBe(false);
    expect(validateCombined(parseYaml(yaml))).toBe(true);
  });

  test('kortix_permissions and its kortix_cli alias disagreeing: imperative rejects, schema accepts', () => {
    const yaml =
      'kortix_version: 2\ndefault_agent: w\nagents:\n  w:\n    kortix_permissions: [project.read]\n    kortix_cli: [project.write]\n';
    expect(validateManifest(yaml, 'yaml').valid).toBe(false);
    expect(validateCombined(parseYaml(yaml))).toBe(true);
  });

  test('auth.type oauth1 on a non-openapi/http connector: imperative rejects, schema accepts', () => {
    const toml =
      'kortix_version = 1\n[[connectors]]\nslug = "g"\nprovider = "graphql"\nendpoint = "https://x/graphql"\n[connectors.auth]\ntype = "oauth1"\n';
    expect(validateManifest(toml, 'toml').valid).toBe(false);
    expect(validateCombined(parseToml(toml))).toBe(true);
  });
});
