import { describe, expect, test } from 'bun:test';
import { extractTriggers, parseManifestString } from './triggers';

// A minimal, valid kortix_version 3 manifest: one runtime profile, two
// logical agents (`kortix` enabled, `release-bot` disabled), no triggers yet
// — each test appends its own `triggers:` block.
const V3_BASE = `kortix_version: 3
default_agent: kortix
project:
  name: v3-project
runtimes:
  opencode:
    harness: opencode
agents:
  kortix:
    runtime: opencode
  release-bot:
    runtime: opencode
    enabled: false
`;

function v3ManifestWith(triggersBlock: string): string {
  return `${V3_BASE}${triggersBlock}`;
}

// ─── Regression sentinels ───────────────────────────────────────────────
//
// v1/v2 trigger reading must stay byte-identical before and after triggers.ts
// learns to read v3 natively. Neither version has ever cross-validated a
// trigger's `agent` string against a declared-agents list at READ time (only
// the write-time CR-merge gate, via `validateManifest`, does that) — these
// sentinels pin that today-behavior down so v3-only additions can't leak
// into v1/v2's read path.

describe('extractTriggers — v1/v2 regression sentinels (must stay byte-identical)', () => {
  test('v1 (TOML) trigger referencing a nonexistent agent still parses clean — v1 never cross-validates agent refs at read time', () => {
    const parsed = parseManifestString(`
kortix_version = 1

[project]
name = "sentinel-v1"

[[triggers]]
slug = "daily-digest"
name = "Daily digest"
type = "cron"
agent = "ghost-agent-does-not-exist"
enabled = true
cron = "0 0 9 * * 1-5"
timezone = "UTC"
prompt = "Summarize the latest deploy."
`);
    expect(parsed.schemaVersion).toBe(1);
    const { specs, errors } = extractTriggers(parsed);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      slug: 'daily-digest',
      agent: 'ghost-agent-does-not-exist',
      type: 'cron',
      enabled: true,
      cron: '0 0 9 * * 1-5',
      timezone: 'UTC',
    });
  });

  test('v2 (YAML) trigger referencing a nonexistent agent still parses clean — cross-ref checking is a write-time (CR-merge) concern, not this reader\'s', () => {
    const parsed = parseManifestString(
      `kortix_version: 2
default_agent: support
project:
  name: sentinel-v2
agents:
  support:
    description: x
triggers:
  - slug: slack
    type: webhook
    agent: ghost-agent-does-not-exist
    secret_env: WEBHOOK_SLACK_SECRET
    prompt: "New {{ message.text }}"
`,
      'yaml',
      'kortix.yaml',
    );
    expect(parsed.schemaVersion).toBe(2);
    const { specs, errors } = extractTriggers(parsed);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      slug: 'slack',
      agent: 'ghost-agent-does-not-exist',
      type: 'webhook',
      secretEnv: 'WEBHOOK_SLACK_SECRET',
    });
  });
});

// ─── kortix_version 3 native reading ────────────────────────────────────
//
// v3's `agents:` block is a name→block map (same shape v2 introduced), keyed
// by logical agent name — see `ManifestV3`/`AgentBlockV3` in
// @kortix/manifest-schema. A trigger's explicit `agent` must resolve against
// that map exactly the way `validateTriggerAgentRefsV2` already enforces it
// at write time (the CR-merge gate): unknown agent → rejected; omitted →
// skipped (falls back to `default_agent` at fire time); DISABLED-but-declared
// → not checked at all (only `default_agent` itself is checked for disabled
// status — see index.v2.ts's `validateDefaultAgentV2`).

describe('extractTriggers — kortix_version 3 native agent-ref resolution', () => {
  test('a trigger referencing a declared v3 agent resolves cleanly (cron + webhook)', () => {
    const parsed = parseManifestString(
      v3ManifestWith(`triggers:
  - slug: daily-digest
    name: Daily digest
    type: cron
    agent: kortix
    enabled: true
    cron: "0 0 9 * * 1-5"
    timezone: UTC
    prompt: Summarize the latest deploy.
  - slug: slack
    type: webhook
    agent: kortix
    secret_env: WEBHOOK_SLACK_SECRET
    prompt: "New {{ message.text }}"
`),
      'yaml',
      'kortix.yaml',
    );
    expect(parsed.schemaVersion).toBe(3);
    const { specs, errors } = extractTriggers(parsed);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(2);
    expect(specs.map((s) => s.slug)).toEqual(['daily-digest', 'slack']);
    expect(specs.every((s) => s.agent === 'kortix')).toBe(true);
  });

  test('a trigger referencing an UNKNOWN v3 agent is rejected with the same message validateTriggerAgentRefsV2 produces, and excluded from specs', () => {
    const parsed = parseManifestString(
      v3ManifestWith(`triggers:
  - slug: daily-digest
    type: cron
    agent: ghost-agent
    cron: "0 0 9 * * 1-5"
    prompt: Summarize the latest deploy.
`),
      'yaml',
      'kortix.yaml',
    );
    const { specs, errors } = extractTriggers(parsed);
    expect(specs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      slug: 'daily-digest',
      error:
        'agent "ghost-agent" does not match any declared agent in `agents`; omit it to fall back to `default_agent`.',
    });
  });

  test('a trigger referencing a DISABLED (but declared) v3 agent still parses clean — mirrors v2, which never checks enabled state for trigger agent refs', () => {
    const parsed = parseManifestString(
      v3ManifestWith(`triggers:
  - slug: daily-digest
    type: cron
    agent: release-bot
    cron: "0 0 9 * * 1-5"
    prompt: Summarize the latest deploy.
`),
      'yaml',
      'kortix.yaml',
    );
    const { specs, errors } = extractTriggers(parsed);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ slug: 'daily-digest', agent: 'release-bot' });
  });

  test('a v3 trigger with no explicit `agent` defaults to the "default" sentinel and is not flagged, even though "default" is not a declared agent — matches v2 (omitted agent is skipped by validateTriggerAgentRefsV2, resolves via default_agent at fire time)', () => {
    const parsed = parseManifestString(
      v3ManifestWith(`triggers:
  - slug: daily-digest
    type: cron
    cron: "0 0 9 * * 1-5"
    prompt: Summarize the latest deploy.
`),
      'yaml',
      'kortix.yaml',
    );
    const { specs, errors } = extractTriggers(parsed);
    expect(errors).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ slug: 'daily-digest', agent: 'default' });
  });

  test('multiple unknown-agent triggers each get their own error, valid ones still parse', () => {
    const parsed = parseManifestString(
      v3ManifestWith(`triggers:
  - slug: ok-one
    type: cron
    agent: kortix
    cron: "0 0 9 * * 1-5"
    prompt: Fine.
  - slug: bad-one
    type: cron
    agent: nope
    cron: "0 0 10 * * 1-5"
    prompt: Also fine, wrong agent.
  - slug: bad-two
    type: webhook
    agent: also-nope
    secret_env: WEBHOOK_SECRET
    prompt: Webhook, wrong agent.
`),
      'yaml',
      'kortix.yaml',
    );
    const { specs, errors } = extractTriggers(parsed);
    expect(specs.map((s) => s.slug)).toEqual(['ok-one']);
    expect(errors.map((e) => e.slug).sort()).toEqual(['bad-one', 'bad-two']);
  });
});
