/**
 * Anti-drift conformance suite: the published JSON Schema
 * (`../json-schema.ts`) and the imperative validator (`../index.ts`) are two
 * independent implementations of "is this manifest valid" and MUST agree on
 * every fixture below, or this test fails CI. That is what makes the schema
 * safe to publish as the canonical validator reference.
 *
 * A separate, labeled block at the bottom documents the KNOWN, INTENTIONAL
 * divergences: cross-field / dynamic-set rules (`default_agent` must name a
 * declared agent, a trigger's `agent` must too, `sandbox.default` must name a
 * declared template) that only the imperative validator can express (see
 * `../json-schema.ts` module doc). Those assertions pin the EXPECTED
 * asymmetry so a future change that closes or widens the gap is a deliberate,
 * reviewed diff.
 */
import { describe, expect, test } from 'bun:test';
import Ajv2020 from 'ajv/dist/2020';
import { parse as parseYaml } from 'yaml';
import { KORTIX_JSON_SCHEMA } from '../json-schema';
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

import { GOLDEN_V3 } from './fixtures/golden-v3.ts';

function swapV3(from: string, to: string): string {
  if (!GOLDEN_V3.includes(from)) throw new Error(`golden v3 manifest has no "${from}"`);
  return GOLDEN_V3.replace(from, to);
}

interface Fixture {
  name: string;
  input: string;
  /** What BOTH validators must agree on. */
  valid: boolean;
}

const FIXTURES: Fixture[] = [
  {
    name: 'deprecated top-level sandboxes list reads as sandbox.templates',
    valid: true,
    input: 'sandboxes:\n  - slug: py\n    image: python:3.12-slim\n',
  },
  {
    name: 'connector missing required slug',
    valid: false,
    input: 'connectors:\n  - provider: pipedream\n    app: github\n',
  },
  {
    name: 'connector unknown provider',
    valid: false,
    input: 'connectors:\n  - slug: x\n    provider: made-up\n',
  },
  {
    name: 'pipedream connector missing app',
    valid: false,
    input: 'connectors:\n  - slug: gh\n    provider: pipedream\n',
  },
  {
    name: 'sandbox template with neither image nor dockerfile (the platform base image)',
    valid: true,
    input: 'sandbox:\n  templates:\n    - slug: py\n',
  },
  {
    name: 'sandbox template with residential_proxy and a country',
    valid: true,
    input: 'sandbox:\n  templates:\n    - slug: web\n      residential_proxy: { country: us }\n',
  },
  {
    name: 'sandbox template with residential_proxy: true',
    valid: true,
    input: 'sandbox:\n  templates:\n    - slug: web\n      residential_proxy: true\n',
  },
  {
    name: 'sandbox template residential_proxy country is not alpha-2',
    valid: false,
    input: 'sandbox:\n  templates:\n    - slug: web\n      residential_proxy: { country: usa }\n',
  },
  {
    name: 'sandbox template residential_proxy is a string',
    valid: false,
    input: 'sandbox:\n  templates:\n    - slug: web\n      residential_proxy: "yes"\n',
  },
  {
    name: 'sandbox template with both image and dockerfile',
    valid: false,
    input:
      'sandbox:\n  templates:\n    - slug: py\n      image: python:3.12-slim\n      dockerfile: .kortix/Dockerfile\n',
  },
  {
    name: 'sandbox template slug reserved ("default")',
    valid: false,
    input:
      'sandbox:\n  templates:\n    - slug: default\n      image: python:3.12-slim\n',
  },
  {
    name: 'cron trigger missing cron/run_at',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: cron\n    prompt: go\n',
  },
  {
    name: 'webhook trigger missing secret_env',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: webhook\n    prompt: go\n',
  },
  {
    name: 'trigger missing prompt',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: cron\n    cron: 0 9 * * *\n',
  },
  {
    name: 'retired apps section is rejected',
    valid: false,
    input: 'apps:\n  - slug: site\n',
  },
  {
    name: 'agent block kortix_permissions non-grantable action',
    valid: false,
    input: 'agents:\n  w:\n    kortix_permissions:\n      - billing.read\n',
  },

  // ─── shared sections: path traversal ───────────────────────────────────
  {
    name: 'sandbox.templates[].dockerfile rejects a ".." traversal segment',
    valid: false,
    input: 'sandbox:\n  templates:\n    - slug: py\n      dockerfile: ../Dockerfile\n',
  },

  // ─── shared sections: connectors.auth ──────────────────────────────────
  {
    name: 'connectors.auth.secret is forbidden outright (credentials live in the platform)',
    valid: false,
    input:
      'connectors:\n  - slug: x\n    provider: openapi\n    spec: https://x/y.json\n    auth:\n      type: bearer\n      secret: TOK\n',
  },
  {
    name: 'connectors.auth.type must be one of the known enum values',
    valid: false,
    input:
      'connectors:\n  - slug: x\n    provider: openapi\n    spec: https://x/y.json\n    auth:\n      type: oauth2\n',
  },
  {
    name: 'connectors.auth.type oauth1 is a known enum value (openapi connector)',
    valid: true,
    input:
      'connectors:\n  - slug: x\n    provider: openapi\n    spec: https://x/y.json\n    auth:\n      type: oauth1\n',
  },
  {
    name: 'connectors.auth supports API key cookie, HMAC, SigV4, and mTLS modes',
    valid: true,
    input:
      'connectors:\n' +
      '  - { slug: api-key, provider: http, base_url: "https://x", auth: { type: api_key, in: cookie, name: session_key } }\n' +
      '  - { slug: signed, provider: http, base_url: "https://x", auth: { type: hmac, name: X-Signature } }\n' +
      '  - { slug: aws, provider: http, base_url: "https://x", auth: { type: aws_sigv4 } }\n' +
      '  - { slug: mtls, provider: http, base_url: "https://x", auth: { type: mtls } }\n',
  },
  {
    name: 'channel connectors must not declare a non-"none" auth.type',
    valid: false,
    input:
      'connectors:\n  - slug: kortix_slack\n    provider: channel\n    platform: slack\n    auth:\n      type: bearer\n',
  },

  // ─── shared sections: connectors.policies ──────────────────────────────
  {
    name: 'connectors.policies entry missing `match`',
    valid: false,
    input:
      'connectors:\n  - slug: x\n    provider: openapi\n    spec: https://x/y.json\n    policies:\n      - action: block\n',
  },
  {
    name: 'connectors.policies entry with an invalid `action`',
    valid: false,
    input:
      'connectors:\n  - slug: x\n    provider: openapi\n    spec: https://x/y.json\n    policies:\n      - match: "*"\n        action: yolo\n',
  },

  // ─── shared sections: reserved connector slugs ─────────────────────────
  {
    name: 'reserved slug "computer" rejects a mismatched (otherwise-valid) provider — regression guard for the computer-slug accept bug',
    valid: false,
    input:
      'connectors:\n  - slug: computer\n    provider: pipedream\n    app: x\n',
  },
  {
    name: 'provider="computer" is always rejected (synth-only, never hand-authored)',
    valid: false,
    input: 'connectors:\n  - slug: computer\n    provider: computer\n',
  },

  // ─── shared sections: triggers.enabled / timezone / session_mode ──────
  {
    name: 'trigger enabled accepts a case-insensitive string sentinel ("yes")',
    valid: true,
    input:
      'triggers:\n  - slug: t\n    type: cron\n    cron: 0 9 * * *\n    prompt: go\n    enabled: yes\n',
  },
  {
    name: 'trigger enabled rejects a non-sentinel garbage string',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: cron\n    cron: 0 9 * * *\n    prompt: go\n    enabled: maybe\n',
  },
  {
    name: 'trigger session_mode accepts "reuse" (and its sessionMode alias)',
    valid: true,
    input:
      'triggers:\n  - slug: t\n    type: cron\n    cron: 0 9 * * *\n    prompt: go\n    session_mode: reuse\n',
  },
  {
    name: 'trigger session_mode rejects an unknown value',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: cron\n    cron: 0 9 * * *\n    prompt: go\n    session_mode: sometimes\n',
  },

  // ─── shared sections: trigger `overlap` (KRTX-1721) ─────────────────────
  {
    name: 'overlap: skip is valid',
    valid: true,
    input: 'triggers:\n  - slug: t\n    type: cron\n    cron: "0 0 9 * * *"\n    prompt: go\n    overlap: skip\n',
  },
  {
    name: 'overlap: queue is invalid',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: cron\n    cron: "0 0 9 * * *"\n    prompt: go\n    overlap: queue\n',
  },

  // ─── shared sections: trigger `filter` operators (KRTX-1721) ───────────
  {
    name: 'filter: a value and every operator is valid',
    valid: true,
    input:
      'triggers:\n  - slug: t\n    type: webhook\n    secret_env: HOOK_SECRET\n    prompt: go\n    filter:\n      body.type: push\n      body.count: 3\n      body.sender.login: { not: kortix-bot }\n      body.action: { in: [opened, reopened] }\n      body.pull_request: { exists: true }\n      body.base: { prefix: release/ }\n      body.ref: { not_prefix: [refs/heads/kortix/, refs/heads/bot/] }\n',
  },
  {
    name: 'filter: an unknown operator is invalid',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: webhook\n    secret_env: HOOK_SECRET\n    prompt: go\n    filter:\n      body.ref: { nott: x }\n',
  },
  {
    name: 'filter: two operators on one path are invalid',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: webhook\n    secret_env: HOOK_SECRET\n    prompt: go\n    filter:\n      body.ref: { in: [a], not: b }\n',
  },
  {
    name: 'filter: an empty in list is invalid',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: webhook\n    secret_env: HOOK_SECRET\n    prompt: go\n    filter:\n      body.action: { in: [] }\n',
  },
  {
    name: 'filter: a non-boolean exists is invalid',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: webhook\n    secret_env: HOOK_SECRET\n    prompt: go\n    filter:\n      body.pr: { exists: yes please }\n',
  },

  // ─── shared sections: triggers type = "app" ───────────────────────────
  {
    name: 'app: an App slug is valid',
    valid: true,
    input: 'triggers:\n  - slug: t\n    type: app\n    app: bank-replies\n    filter: { event.name: reply.received }\n    prompt: go\n',
  },
  {
    name: 'app: missing app is rejected',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: app\n    prompt: go\n',
  },
  {
    name: 'app: an invalid App slug is rejected',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: app\n    app: Bank_Replies\n    prompt: go\n',
  },
  {
    name: 'app: cron key on app is rejected',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: app\n    app: bank-replies\n    cron: \"0 9 * * *\"\n    prompt: go\n',
  },
  {
    name: 'app: event key on app is rejected',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: app\n    app: bank-replies\n    event: X\n    prompt: go\n',
  },
  {
    name: 'app: app key on a cron trigger is rejected',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: cron\n    cron: \"0 0 9 * * *\"\n    app: bank-replies\n    prompt: go\n',
  },

  // ─── triggers: target (call an App) ───────────────────────────────────
  {
    name: 'target: a cron trigger may call an App with no prompt',
    valid: true,
    input: 'triggers:\n  - slug: t\n    type: cron\n    cron: \"0 0 9 * * *\"\n    target: { app: bank-watcher, path: /tick }\n',
  },
  {
    name: 'target: a webhook trigger may call an App',
    valid: true,
    input: 'triggers:\n  - slug: t\n    type: webhook\n    secret_env: HOOK_SECRET\n    target: { app: bank-watcher, method: POST }\n',
  },
  {
    name: 'target: needs app',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: cron\n    cron: \"0 0 9 * * *\"\n    target: { path: /tick }\n',
  },
  {
    name: 'target: unknown key rejected',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: cron\n    cron: \"0 0 9 * * *\"\n    target: { app: w, url: x }\n',
  },
  {
    name: 'target: not on a monitor',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: stream\n    target: { app: w }\n    prompt: go\n',
  },
  {
    name: 'target: a cron trigger without target still needs a prompt',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: cron\n    cron: \"0 0 9 * * *\"\n',
  },

  // ─── triggers: every ─────────────────────────────────────────────────
  {
    name: 'every: a cron trigger may run on a fixed period',
    valid: true,
    input: 'triggers:\n  - slug: t\n    type: cron\n    every: 5m\n    prompt: go\n',
  },
  {
    name: 'every: with target payload',
    valid: true,
    input: 'triggers:\n  - slug: t\n    type: cron\n    every: 1h\n    target: { app: w, path: /tick, payload: { a: 1 } }\n',
  },
  {
    name: 'every: not on a webhook',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: webhook\n    secret_env: HOOK_SECRET\n    every: 5m\n    prompt: go\n',
  },
  {
    name: 'every: target payload must be an object',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: cron\n    every: 1h\n    target: { app: w, payload: nope }\n',
  },

  // ─── triggers: the on/run shape ───────────────────────────────────────
  {
    name: 'on/run: a cron schedule that runs an agent',
    valid: true,
    input: 'triggers:\n  - slug: t\n    on: { cron: \"0 0 9 * * *\", timezone: Europe/Berlin }\n    run: { agent: default, prompt: go, session: reuse }\n',
  },
  {
    name: 'on/run: every that calls an App',
    valid: true,
    input: 'triggers:\n  - slug: t\n    on: { every: 5m }\n    run: { app: watcher, path: /tick, payload: { a: 1 } }\n',
  },
  {
    name: 'on/run: a one-off at',
    valid: true,
    input: 'triggers:\n  - slug: t\n    on: { at: \"2026-11-01T09:00:00Z\" }\n    run: { prompt: go }\n',
  },
  {
    name: 'on/run: a webhook',
    valid: true,
    input: 'triggers:\n  - slug: t\n    on: { webhook: { secret: HOOK_SECRET } }\n    run: { prompt: \"{{ body.x }}\" }\n',
  },
  {
    name: 'on/run: a connector event',
    valid: true,
    input: 'triggers:\n  - slug: t\n    on: { event: PR, connector: github }\n    run: { prompt: go }\n',
  },
  {
    name: 'on/run: an App event',
    valid: true,
    input: 'triggers:\n  - slug: t\n    on: { event: reply.received, app: watcher }\n    run: { prompt: go }\n',
  },
  {
    name: 'on/run: an unknown on key is rejected',
    valid: false,
    input: 'triggers:\n  - slug: t\n    on: { crn: x }\n    run: { prompt: go }\n',
  },
  {
    name: 'on/run: an unknown run key is rejected',
    valid: false,
    input: 'triggers:\n  - slug: t\n    on: { every: 5m }\n    run: { promt: go }\n',
  },
  {
    name: 'on/run: run is required',
    valid: false,
    input: 'triggers:\n  - slug: t\n    on: { every: 5m }\n',
  },
  {
    name: 'on/run: type with on is rejected',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: cron\n    on: { every: 5m }\n    run: { prompt: go }\n',
  },
  {
    name: 'on/run: run needs a prompt or an app',
    valid: false,
    input: 'triggers:\n  - slug: t\n    on: { every: 5m }\n    run: { agent: default }\n',
  },
  {
    name: 'on/run: a webhook needs its secret',
    valid: false,
    input: 'triggers:\n  - slug: t\n    on: { webhook: {} }\n    run: { prompt: go }\n',
  },

  // ─── shared sections: triggers type = "event" ─────────────────────────
  {
    name: 'event: connector + event + config object is valid',
    valid: true,
    input:
      'triggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    config: { owner: acme }\n    prompt: go\n',
  },
  {
    name: 'event: config is optional',
    valid: true,
    input:
      'triggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    prompt: go\n',
  },
  {
    name: 'event: missing connector is rejected',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: event\n    event: X\n    prompt: go\n',
  },
  {
    name: 'event: missing event is rejected',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: event\n    connector: github\n    prompt: go\n',
  },
  {
    name: 'event: config must be an object',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    config: nope\n    prompt: go\n',
  },
  {
    name: 'event: cron key on event is rejected',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    cron: "0 9 * * *"\n    prompt: go\n',
  },
  {
    name: 'event: secret_env on event is rejected',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    secret_env: HOOK_SECRET\n    prompt: go\n',
  },
  {
    name: 'event: account label is valid',
    valid: true,
    input:
      'triggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    account: acme-bot\n    prompt: go\n',
  },
  {
    name: 'event: empty account is rejected',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    account: ""\n    prompt: go\n',
  },
  {
    name: 'event: non-string account is rejected',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    account: 7\n    prompt: go\n',
  },
  {
    name: 'cron: account is rejected (event only)',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: cron\n    cron: "0 9 * * *"\n    account: acme-bot\n    prompt: go\n',
  },
  {
    name: 'webhook: account is rejected (event only)',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: webhook\n    secret_env: S\n    account: acme-bot\n    prompt: go\n',
  },
  {
    name: 'monitor: account is rejected (event only)',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: stream\n    account: acme-bot\n    prompt: go\n',
  },
  {
    name: 'event: source adapter is valid',
    valid: true,
    input:
      'triggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    source: composio\n    prompt: go\n',
  },
  {
    name: 'event: empty source is rejected',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    source: ""\n    prompt: go\n',
  },
  {
    name: 'event: non-string source is rejected',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: event\n    connector: github\n    event: GITHUB_PULL_REQUEST_EVENT\n    source: 7\n    prompt: go\n',
  },
  {
    name: 'cron: source is rejected (event only)',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: cron\n    cron: "0 9 * * *"\n    source: composio\n    prompt: go\n',
  },
  {
    name: 'webhook: source is rejected (event only)',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: webhook\n    secret_env: S\n    source: composio\n    prompt: go\n',
  },
  {
    name: 'monitor: source is rejected (event only)',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: stream\n    source: composio\n    prompt: go\n',
  },
  {
    name: 'cron: event keys on cron are rejected',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: cron\n    cron: "0 9 * * *"\n    connector: github\n    prompt: go\n',
  },
  {
    name: 'webhook: config on webhook is rejected',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: webhook\n    secret_env: HOOK_SECRET\n    config: {}\n    prompt: go\n',
  },

  // ─── shared sections: triggers type = "monitor" ───────────────────────
  {
    name: 'monitor: type monitor is rejected (the monitor box was removed)',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: monitor\n    run: ./monitors/t.ts\n    mode: stream\n    prompt: go\n',
  },
  {
    name: 'monitor: a poll monitor is rejected too',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: monitor\n    run: ./monitors/t.ts\n    mode: poll\n    interval: 60s\n    expect_event_within: 24h\n    prompt: go\n',
  },
  {
    name: 'monitor: missing run + mode is rejected',
    valid: false,
    input: 'triggers:\n  - slug: t\n    type: monitor\n    prompt: go\n',
  },
  {
    name: 'monitor: mode = poll without an interval is rejected',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: poll\n    prompt: go\n',
  },
  {
    name: 'monitor: an interval on a stream monitor is rejected',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: stream\n    interval: 60s\n    prompt: go\n',
  },
  {
    name: 'monitor: an unknown mode is rejected',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: tail\n    prompt: go\n',
  },
  {
    name: 'monitor: cron wiring on a monitor is rejected',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: stream\n    cron: "0 9 * * *"\n    prompt: go\n',
  },
  {
    name: 'monitor: secret_env on a monitor is rejected',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: stream\n    secret_env: HOOK_SECRET\n    prompt: go\n',
  },
  {
    name: 'monitor: a malformed duration is rejected by both validators',
    valid: false,
    input:
      'triggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: poll\n    interval: soon\n    prompt: go\n',
  },

  // ─── shared sections: sandbox.default reserved sentinel ────────────────
  {
    name: 'sandbox.default = "default" (the reserved platform sentinel) is valid with no matching template',
    valid: true,
    input: 'sandbox:\n  default: default\n',
  },

  {
    name: '`file` rejects a traversal segment',
    valid: false,
    input: 'default_agent: a\nagents:\n  a:\n    file: ../a.md\n',
  },
  {
    name: '`file` rejects a non-.md file',
    valid: false,
    input: 'default_agent: a\nagents:\n  a:\n    file: agents/a.txt\n',
  },
  {
    name: 'nested `opencode:` sub-object rejected outright',
    valid: false,
    input:
      'default_agent: w\nagents:\n  w:\n    opencode:\n      mode: primary\n',
  },
  {
    name: 'deprecated `disable` reads as `enabled`',
    valid: true,
    input: 'default_agent: w\nagents:\n  w:\n    prompt: x\n    disable: false\n',
  },
  {
    name: '`permission` flat on agent block rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w:\n    permission: x\n',
  },
  {
    name: 'deprecated `env` on an agent reads as `secrets`',
    valid: true,
    input: 'default_agent: w\nagents:\n  w:\n    env: [STRIPE_KEY]\n',
  },
  {
    name: '`secrets` on agent block accepted',
    valid: true,
    input: 'default_agent: w\nagents:\n  w:\n    secrets: [STRIPE_KEY]\n',
  },
  {
    name: 'canonical required connector subset accepted',
    valid: true,
    input:
      'default_agent: w\nagents:\n  w:\n    connectors: [gmail]\n    connectors_required: [gmail]\n',
  },
  {
    name: 'top-level [env] section unaffected',
    valid: true,
    input:
      'default_agent: w\nenv:\n  required: [ANTHROPIC_API_KEY]\nagents:\n  w: {}\n',
  },
  {
    name: 'connector credential per_user rejected outright',
    valid: false,
    input:
      'default_agent: w\nagents:\n  w: {}\nconnectors:\n  - slug: gmail\n    provider: pipedream\n    app: gmail\n    credential: per_user\n',
  },
  {
    name: 'connector credential shared accepted',
    valid: true,
    input:
      'default_agent: w\nagents:\n  w: {}\nconnectors:\n  - slug: gmail\n    provider: pipedream\n    app: gmail\n    credential: shared\n',
  },
  {
    name: 'connector project authorization strategy accepted',
    valid: true,
    input:
      'default_agent: w\nagents:\n  w: {}\nconnectors:\n  - slug: gmail-shared\n    name: Shared Gmail\n    provider: pipedream\n    app: gmail\n    authorization_strategy: project\n',
  },
  {
    name: 'connector user authorization strategy accepted',
    valid: true,
    input:
      'default_agent: w\nagents:\n  w: {}\nconnectors:\n  - slug: gmail-personal\n    name: Personal Gmail\n    provider: pipedream\n    app: gmail\n    authorization_strategy: user\n',
  },
  {
    name: 'connector both authorization strategy rejected',
    valid: false,
    input:
      'default_agent: w\nagents:\n  w: {}\nconnectors:\n  - slug: gmail\n    provider: pipedream\n    app: gmail\n    authorization_strategy: both\n',
  },
  {
    name: 'connector blank name rejected',
    valid: false,
    input:
      'default_agent: w\nagents:\n  w: {}\nconnectors:\n  - slug: gmail\n    name: ""\n    provider: pipedream\n    app: gmail\n',
  },
  {
    name: 'connector agent_scope rejected outright',
    valid: false,
    input:
      'default_agent: w\nagents:\n  w: {}\nconnectors:\n  - slug: gmail\n    provider: pipedream\n    app: gmail\n    agent_scope: [support]\n',
  },
  {
    name: '[[channels]] rejected outright',
    valid: false,
    input:
      'default_agent: w\nagents:\n  w: {}\nchannels:\n  - platform: slack\n',
  },
  {
    name: 'no agents map is valid: built-in agents only',
    valid: true,
    input: 'project: { name: x }\n',
  },
  {
    name: 'an empty agents map is valid',
    valid: true,
    input: 'agents: {}\n',
  },
  {
    name: 'agents as a v1-style array is rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  - name: w\n',
  },
  {
    name: 'invalid agent name key',
    valid: false,
    input:
      'default_agent: w\nagents:\n  "Not Valid":\n    workspace: runtime\n  w: {}\n',
  },
  {
    name: 'kortix_permissions rejects a non-grantable action',
    valid: false,
    input: 'default_agent: w\nagents:\n  w:\n    kortix_permissions: [billing.read]\n',
  },
  {
    name: 'kortix_permissions accepts the wildcard',
    valid: true,
    input: 'default_agent: w\nagents:\n  w:\n    kortix_permissions: ["*"]\n',
  },
  {
    name: "kortix_permissions rejects a legacy-tolerated action outright (clean break, unlike v1's warn-only tolerance)",
    valid: false,
    input:
      'default_agent: w\nagents:\n  w:\n    kortix_permissions: [project.schedule.read]\n',
  },
  {
    name: 'deprecated kortix_cli alias still rejects a non-grantable action',
    valid: false,
    input: 'default_agent: w\nagents:\n  w:\n    kortix_cli: [billing.read]\n',
  },
  { name: 'workspace.project_repository false', valid: true, input: 'default_agent: a\nagents:\n  a:\n    workspace:\n      project_repository: false\n' },
  { name: 'workspace.project_repository true', valid: true, input: 'default_agent: a\nagents:\n  a:\n    workspace:\n      project_repository: true\n' },
  { name: 'empty workspace map', valid: true, input: 'default_agent: a\nagents:\n  a:\n    workspace: {}\n' },
  { name: 'workspace.project_repository "false"', valid: false, input: 'default_agent: a\nagents:\n  a:\n    workspace:\n      project_repository: "false"\n' },
  { name: 'unknown workspace key', valid: false, input: 'default_agent: a\nagents:\n  a:\n    workspace:\n      project_repo: false\n' },
  { name: 'workspace list', valid: false, input: 'default_agent: a\nagents:\n  a:\n    workspace: [project_repository]\n' },
  {
    name: 'unknown workspace value rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w:\n    workspace: everywhere\n',
  },
  {
    name: 'declarative agent egress policy accepted (not enforced)',
    valid: true,
    input: 'default_agent: w\nagents:\n  w:\n    network_egress:\n      version: 1\n      default: deny\n      rules: []\n',
  },
  {
    name: 'unknown egress policy version rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w:\n    network_egress:\n      version: 2\n      default: deny\n      rules: []\n',
  },
  {
    name: 'skills "all" sentinel accepted',
    valid: true,
    input: 'default_agent: w\nagents:\n  w:\n    skills: all\n',
  },
  {
    name: 'skills non-string entry rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w:\n    skills: [42]\n',
  },
  {
    name: 'skills invalid sentinel string rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w:\n    skills: everything\n',
  },
  {
    name: 'apps explicit slug list accepted',
    valid: true,
    input: 'default_agent: w\nagents:\n  w:\n    apps: [reports-dashboard]\n',
  },
  {
    name: 'apps "none" sentinel accepted',
    valid: true,
    input: 'default_agent: w\nagents:\n  w:\n    apps: none\n',
  },
  {
    name: 'apps non-string entry rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w:\n    apps: [42]\n',
  },
  {
    name: 'apps invalid sentinel rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w:\n    apps: everything\n',
  },
  {
    name: 'unknown runtime rejected',
    valid: false,
    input: 'default_agent: w\nruntime: codex\nagents:\n  w: {}\n',
  },
  {
    name: 'runtime opencode accepted',
    valid: true,
    input: 'default_agent: w\nruntime: opencode\nagents:\n  w: {}\n',
  },
  {
    name: 'non-boolean enabled rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w:\n    enabled: "yes"\n',
  },
  {
    name: 'bare governance-only block is valid',
    valid: true,
    input: 'default_agent: w\nagents:\n  w: {}\n',
  },
  {
    name: 'sandbox.templates carries over unchanged',
    valid: true,
    input:
      'default_agent: w\nagents:\n  w: {}\nsandbox:\n  templates:\n    - slug: py\n      image: python:3.12-slim\n',
  },
  {
    name: 'connectors unknown provider still rejected',
    valid: false,
    input:
      'default_agent: w\nagents:\n  w: {}\nconnectors:\n  - slug: wat\n    provider: made-up\n',
  },
  {
    name: 'OpenCode plugin path traversal rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w:\n    harnesses:\n      opencode:\n        plugins: [../bad.ts]\n',
  },
  {
    name: 'agent-level exclude with a version rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w:\n    harnesses:\n      pi:\n        exclude: [npm:pi-web-access@0.30.0]\n',
  },
  {
    name: 'exclude at the top level rejected (it removes global packages for one agent)',
    valid: false,
    input: 'default_agent: w\nagents:\n  w: {}\nharnesses:\n  pi:\n    exclude: [pi-web-access]\n',
  },
  {
    name: 'harnesses.pi.packages npm source without an exact version rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w: {}\nharnesses:\n  pi:\n    packages:\n      - npm:pi-web-access@^0.30.0\n',
  },
  {
    name: 'harnesses.pi.packages git source rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w: {}\nharnesses:\n  pi:\n    packages:\n      - git:github.com/acme/pi-tools@v1\n',
  },
  {
    name: 'harnesses.pi.packages path escaping the repo rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w: {}\nharnesses:\n  pi:\n    packages:\n      - ../outside.ts\n',
  },
  {
    name: 'harnesses.pi.codemode outside off, on, only rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w: {}\nharnesses:\n  pi:\n    codemode: yes\n',
  },
  {
    name: 'an unknown harness rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w: {}\nharnesses:\n  codex:\n    packages: []\n',
  },
  {
    name: 'an unknown key under harnesses.pi rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w: {}\nharnesses:\n  pi:\n    extensions: [npm:pi-web-access@0.30.0]\n',
  },
  {
    name: 'inline YAML agent behavior',
    valid: true,
    input: 'default_agent: w\nagents:\n  w:\n    model: test/model\n    prompt: Be brief.\n    permission:\n      bash: deny\n',
  },
  {
    name: 'raw OpenCode configuration rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w: {}\nopencode:\n  config_dir: .opencode\n',
  },
  {
    name: 'invalid prompt',
    valid: false,
    input: 'default_agent: w\nagents:\n  w:\n    prompt: [bad]\n',
  },
  {
    name: 'the golden manifest',
    valid: true,
    input: GOLDEN_V3,
  },
  {
    name: 'harnesses rejected',
    valid: false,
    input: swapV3('default_agent: assistant\n', 'default_agent: assistant\nharnesses:\n  pi:\n    codemode: on\n'),
  },
  {
    name: 'top-level permission rejected',
    valid: false,
    input: swapV3('default_agent: assistant\n', 'default_agent: assistant\npermission: allow\n'),
  },
  {
    name: 'an unknown top-level key rejected',
    valid: false,
    input: swapV3('default_agent: assistant\n', 'default_agent: assistant\nagentz: {}\n'),
  },
  {
    name: 'a kortix- project skill rejected',
    valid: false,
    input: swapV3('pdf: skills/pdf', 'kortix-pdf: skills/kortix-pdf'),
  },
  {
    name: 'kortix:<name> tool value rejected',
    valid: false,
    input: swapV3('lookup_order: tools/lookup_order.ts', 'lookup_order: kortix:web_search'),
  },
  {
    name: 'a command with prompt and prompt_file rejected',
    valid: false,
    input: swapV3('    prompt: Summarize', '    prompt_file: x.md\n    prompt: Summarize'),
  },
  {
    name: 'a command agent key rejected',
    valid: false,
    input: swapV3('    prompt: Summarize', '    agent: assistant\n    prompt: Summarize'),
  },
  {
    name: 'an empty extension rejected',
    valid: false,
    input: swapV3('  web-access:\n    pi: npm:pi-web-access@0.30.0', '  web-access: {}'),
  },
  {
    name: 'an npm OpenCode plugin rejected',
    valid: false,
    input: swapV3('pi: extensions/audit.pi.ts', 'pi: extensions/audit.pi.ts\n    opencode: npm:audit@1.0.0'),
  },
  {
    name: 'a ranged pi pin rejected',
    valid: false,
    input: swapV3('pi: npm:pi-web-access@0.30.0', 'pi: npm:pi-web-access@^0.30.0'),
  },
  {
    name: 'agent file rejected',
    valid: false,
    input: swapV3('    mode: primary\n', '    mode: primary\n    file: agents/a.md\n'),
  },
  {
    name: 'agent harnesses rejected',
    valid: false,
    input: swapV3('    mode: primary\n', '    mode: primary\n    harnesses: {}\n'),
  },
  {
    name: 'permission.skill rejected',
    valid: false,
    input: swapV3('      external_directory: deny', '      skill: allow'),
  },
  {
    name: 'tools map form rejected',
    valid: false,
    input: swapV3('    tools: all\n', '    tools:\n      bash: false\n'),
  },
  {
    name: 'bad codemode rejected',
    valid: false,
    input: swapV3('codemode: on', 'codemode: maybe'),
  },
  {
    name: 'a tools key with every line deleted (null) is accepted',
    valid: true,
    input: 'default_agent: w\nagents:\n  w: {}\ntools:\n',
  },
  {
    name: 'kortix:<name> under another Kortix tool name rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w: {}\ntools:\n  web_search: kortix:image_search\n',
  },
  {
    name: 'kortix:<name> for a name that is no Kortix tool rejected',
    valid: false,
    input: 'default_agent: w\nagents:\n  w: {}\ntools:\n  web_serch: kortix:web_serch\n',
  },
  {
    name: 'Kortix Apps map is accepted',
    valid: true,
    input:
      'default_agent: w\nagents:\n  w: {}\napps:\n  site:\n    path: .\n    type: static\n    readiness_path: /\n',
  },
];

// Blank companions are absent values for sandbox selection, not competing keys.
// At most one may be set; neither is the platform base image.
for (const image of [undefined, '', '   ', 'python:3.12']) {
  for (const dockerfile of [undefined, '', '   ', 'Dockerfile']) {
    FIXTURES.push({
      name: `sandbox nonblank XOR: image=${JSON.stringify(image)}, dockerfile=${JSON.stringify(dockerfile)}`,
      input: `sandbox:\n  templates:\n    - ${JSON.stringify({ slug: 'worker', image, dockerfile })}\n`,
      valid: Number(Boolean(image?.trim())) + Number(Boolean(dockerfile?.trim())) <= 1,
    });
  }
}
for (const field of ['prompt', 'connector', 'event', 'account', 'source']) {
  for (const blank of ['', '   ', '\t\n', '\u00a0']) {
    FIXTURES.push({
      name: `event nonblank ${field}: ${JSON.stringify(blank)}`,
      input: `triggers:\n  - ${JSON.stringify({ slug: 'events', type: 'event', prompt: 'Handle event', connector: 'github', event: 'push', [field]: blank })}\n`,
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
    FIXTURES.push({ name: `${name} rejects blank ${JSON.stringify(blank)}`, valid: false, input: JSON.stringify({ ...fields }) });
  }
}
for (const [prompt, prompt_template, valid] of [
  ['Handle event', '', true], ['', 'Handle event', false], [undefined, '   ', false],
] as const) {
  FIXTURES.push({ name: `prompt alias precedence ${JSON.stringify([prompt, prompt_template])}`, valid, input: JSON.stringify({ triggers: [{ slug: 'events', type: 'event', prompt, prompt_template, connector: 'github', event: 'push' }] }) });
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
    FIXTURES.push({ name: `${name} rejects blank ${JSON.stringify(blank)}`, valid: false, input: JSON.stringify({ default_agent: 'worker', agents: { worker: {} }, ...fields }) });
  }
  for (const field of ['prompt', 'commands']) {
    FIXTURES.push({ name: `v3 ${field} rejects blank ${JSON.stringify(blank)}`, valid: false, input: JSON.stringify({ default_agent: 'worker', agents: { worker: field === 'prompt' ? { prompt: blank } : {} }, ...(field === 'commands' ? { commands: { greet: { prompt: blank } } } : {}) }) });
  }
}
for (const image of ['', '   ', '\t\n', '\u00a0', 'python:3.12']) {
  FIXTURES.push({ name: `OCI image nonblank ${JSON.stringify(image)}`, valid: image === 'python:3.12', input: JSON.stringify({ default_agent: 'worker', agents: { worker: {} }, apps: { site: { type: 'oci_image', image, command: ['node'], port: 3000 } } }) });
}
// Trigger aliases use canonical-field precedence; pinned IDs alone must be nonblank.
{
  const base = { default_agent: 'worker', agents: { worker: {} } };
  const cases: Array<[string, object, boolean]> = [
    ['blank agent', { agent: '   ' }, false],
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
    FIXTURES.push({ name: `trigger ${name}`, valid, input: JSON.stringify({ ...base, triggers: [{ slug: 'tick', type: 'cron', cron: '0 9 * * *', prompt: 'Go', ...fields }] }) });
  }
}
describe('JSON Schema vs. imperative validator — accept/reject conformance', () => {
  for (const fixture of FIXTURES) {
    test(fixture.name, () => {
      const imperative = validateManifest(fixture.input);
      const parsed = parseYaml(fixture.input);
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
      const input = `default_agent: assistant\n${section.startsWith('agents:') ? section : `agents: {assistant: {}}\n${section}`}\n`;
      expect(validateManifest(input).valid).toBe(true);
      expect(validateCombined(parseYaml(input))).toBe(true);
    });
  }
});

describe('normalized enums retain their boundaries', () => {
  for (const provider of ['computer', 'mcp-extra', '', 'mcp\nextra']) {
    test(`rejects provider ${JSON.stringify(provider)}`, () => {
      const input = { default_agent: 'assistant', agents: { assistant: {} },
        connectors: [{ slug: 'sample', provider, url: 'https://example.test/mcp' }] };
      expect(validateManifest(JSON.stringify(input)).valid).toBe(false);
      expect(validateCombined(input)).toBe(false);
    });
  }
  test('normalized provider still requires its endpoint', () => {
    const input = 'default_agent: assistant\nagents: {assistant: {}}\nconnectors: [{slug: sample, provider: " MCP "}]';
    expect(validateManifest(input).valid).toBe(false);
    expect(validateCombined(parseYaml(input))).toBe(false);
  });
  test('reserved channel provider and auth accept normalized values', () => {
    const input = 'default_agent: assistant\nagents: {assistant: {}}\nconnectors: [{slug: kortix_slack, provider: " Channel ", platform: " Slack ", auth: {type: " None "}}]';
    expect(validateManifest(input).valid).toBe(true);
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
    const input = `default_agent: assistant\nagents: {assistant: {}}\ntriggers: [{slug: nightly, type: cron, cron: "0 9 * * *", prompt: Digest, session_mode: "${kelvinKeyed}"}]\n`;
    expect(validateManifest(input).valid).toBe(true);
    expect(validateCombined(parseYaml(input))).toBe(true);
  });
  test('platform accepts a KELVIN SIGN k', () => {
    const input = `default_agent: assistant\nagents: {assistant: {}}\nconnectors: [{slug: sample, provider: channel, platform: "${kelvinSlack}"}]\n`;
    expect(validateManifest(input).valid).toBe(true);
    expect(validateCombined(parseYaml(input))).toBe(true);
  });
  test('a fullwidth K stays rejected by both (folds to fullwidth k, not "k")', () => {
    const input = { default_agent: 'assistant', agents: { assistant: {} },
      triggers: [{ slug: 'nightly', type: 'cron', cron: '0 9 * * *', prompt: 'Digest', session_mode: '\uFF2Beyed' }] };
    expect(validateManifest(JSON.stringify(input)).valid).toBe(false);
    expect(validateCombined(input)).toBe(false);
  });
  test('a dotted capital I stays rejected by both (folds to two code points)', () => {
    const input = { default_agent: 'assistant', agents: { assistant: {} },
      connectors: [{ slug: 'sample', provider: 'p\u0130pedream', url: 'https://example.test/mcp' }] };
    expect(validateManifest(JSON.stringify(input)).valid).toBe(false);
    expect(validateCombined(input)).toBe(false);
  });
});

describe('generated patterns are ReDoS-safe and keep the blank grant sentinel (G9 item [B])', () => {
  // An empty string inside the case-insensitive alternation becomes `(?:…|)`
  // sitting between the leading `^\s*` and trailing `\s*`: matching a long
  // whitespace-only grant then walks every split of the run across the two
  // quantifiers — quadratic (8.2 s for 100 KB, measured by the reviewer).
  // The empty-string enum member gets its own `^\s*$` arm instead, which is
  // linear. These tests pin the mechanism and the acceptance it must keep.
  const collectPatterns = (node: unknown, into: string[] = []): string[] => {
    if (Array.isArray(node)) {
      for (const item of node) collectPatterns(item, into);
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'pattern' && typeof value === 'string') into.push(value);
        else collectPatterns(value, into);
      }
    }
    return into;
  };
  const allPatterns = [
    ...collectPatterns(KORTIX_JSON_SCHEMA),
  ];
  test('no generated pattern contains an empty alternation', () => {
    const offenders = allPatterns.filter((p) => p.includes('|)') || p.includes('(|') || p.includes('||'));
    expect(offenders).toEqual([]);
  });
  test('every pattern evaluates a 100 KB whitespace-only string in linear time', () => {
    // Both shapes: pure whitespace matches fast even with the empty
    // alternative (it succeeds on the first greedy pass); the quadratic
    // blow-up needs a trailing character that forces the engine to walk
    // every `\\s*` split — 16 s on 100 KB with the old pattern (measured).
    // `padStart` builds the killer input without a string concatenation
    // (biome lint/style/useTemplate).
    for (const input of [' '.repeat(100_000), 'x'.padStart(100_001)]) {
      for (const pattern of allPatterns) {
        const started = performance.now();
        new RegExp(pattern).test(input);
        const elapsed = performance.now() - started;
        // Headroom: the fixed patterns run < 100 ms; the quadratic
        // predecessor took seconds on this input. 2 s fails only the
        // regression.
        expect(elapsed).toBeLessThan(2000);
      }
    }
  }, 30_000);
  test('a whitespace-only grant sentinel stays accepted by both sides', () => {
    const input = { default_agent: 'worker', agents: { worker: { connectors: '   ' } } };
    expect(validateManifest(JSON.stringify(input)).valid).toBe(true);
    expect(validateCombined(input)).toBe(true);
  });
});

describe('the JSON Schema document is itself valid JSON Schema (ajv compiles it)', () => {
  test('kortix.schema.json compiles', () => {
    expect(() => new Ajv2020({ strict: false }).compile(KORTIX_JSON_SCHEMA as Record<string, unknown>)).not.toThrow();
  });

  test('the document declares its stable $id and the 2020-12 draft', () => {
    expect(KORTIX_JSON_SCHEMA.$id).toBe('https://kortix.com/schema/kortix.schema.json');
    expect(KORTIX_JSON_SCHEMA.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  test('connector fields are discoverable in the schema', () => {
    const connectorProperties = (
      KORTIX_JSON_SCHEMA as {
        properties: {
          connectors: { items: { properties: Record<string, unknown> } };
        };
      }
    ).properties.connectors.items.properties;
    expect(connectorProperties.name).toMatchObject({ type: 'string', pattern: '\\S' });
    // A copy: Bun's toMatchObject writes `expect.any(String)` into the object it
    // checks, and json-schema.sync.test.ts renders the same shared schema later
    // in this process. The pattern then rendered as `{}` (v0.14.9, v0.14.10 lanes).
    expect(structuredClone(connectorProperties.authorization_strategy)).toMatchObject({
      type: 'string',
      anyOf: [
        { enum: ['project', 'user'] },
        { pattern: expect.any(String) },
      ],
      default: 'project',
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
    const yaml = 'default_agent: ghost\nagents:\n  w: {}\n';
    expect(validateManifest(yaml).valid).toBe(false);
    expect(validateCombined(parseYaml(yaml))).toBe(true);
  });

  test("a trigger's agent naming an undeclared agent: imperative rejects, schema accepts", () => {
    const yaml =
      'default_agent: w\nagents:\n  w: {}\ntriggers:\n  - slug: t\n    type: cron\n    cron: "0 9 * * *"\n    prompt: go\n    agent: ghost\n';
    expect(validateManifest(yaml).valid).toBe(false);
    expect(validateCombined(parseYaml(yaml))).toBe(true);
  });

  test('sandbox.default naming an undeclared template: imperative rejects, schema accepts', () => {
    const yaml =
      'default_agent: w\nagents:\n  w: {}\nsandbox:\n  default: ghost\n  templates:\n    - slug: py\n      image: python:3.12-slim\n';
    expect(validateManifest(yaml).valid).toBe(false);
    expect(validateCombined(parseYaml(yaml))).toBe(true);
  });

  // A schedule's `every` FLOOR (≥ 1m) is a value range over a formatted
  // string. JSON Schema can pin the shape (`DURATION_RE`) but not the
  // magnitude, so the floor stays imperative-only.
  test('every below the 1m floor: imperative rejects, schema accepts the shape', () => {
    const yaml = 'triggers:\n  - slug: t\n    type: cron\n    every: 30s\n    prompt: go\n';
    expect(validateManifest(yaml).valid).toBe(false);
    expect(validateCombined(parseYaml(yaml))).toBe(true);
  });
});
