import { describe, expect, test } from 'bun:test';
import { validateManifest, formatIssues } from '../index.ts';

function summarize(input: string | Record<string, unknown>) {
  const result = validateManifest(input);
  const errorPaths = result.issues
    .filter((i) => i.severity === 'error')
    .map((i) => i.path);
  const warningPaths = result.issues
    .filter((i) => i.severity === 'warning')
    .map((i) => i.path);
  return { ...result, errorPaths, warningPaths };
}

describe('validateManifest — syntax', () => {
  test('catches a TOML syntax error and surfaces line info', () => {
    const result = validateManifest('this is not valid = toml [\n');
    expect(result.valid).toBe(false);
    expect(result.parsed).toBeNull();
    expect(result.issues[0].severity).toBe('error');
    expect(result.issues[0].path).toBe('<toml>');
    expect(result.issues[0].message).toContain('Syntax error');
  });

  test('empty TOML is invalid without kortix_version', () => {
    const result = validateManifest('');
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBe(1);
    expect(result.issues[0].severity).toBe('error');
    expect(result.issues[0].path).toBe('kortix_version');
  });
});

describe('validateManifest — kortix_version', () => {
  test('rejects non-integer kortix_version', () => {
    const { errorPaths } = summarize(`kortix_version = "one"`);
    expect(errorPaths).toContain('kortix_version');
  });

  test('rejects string kortix_version', () => {
    const { errorPaths } = summarize(`kortix_version = "1"`);
    expect(errorPaths).toContain('kortix_version');
  });

  test('rejects decimal kortix_version', () => {
    const { errorPaths } = summarize('kortix_version = 1.5');
    expect(errorPaths).toContain('kortix_version');
  });

  test('rejects a version higher than known', () => {
    const { errorPaths } = summarize('kortix_version = 2');
    expect(errorPaths).toContain('kortix_version');
  });

  test('rejects when kortix_version is missing', () => {
    const { errorPaths } = summarize(`[project]\nname = "x"`);
    expect(errorPaths).toContain('kortix_version');
  });
});

describe('validateManifest — [env]', () => {
  test('rejects non-array env.required', () => {
    const { errorPaths, valid } = summarize(`kortix_version = 1\n[env]\nrequired = "ANTHROPIC_API_KEY"`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('env.required');
  });

  test('accepts lowercase env names (upper-cased by the runtime)', () => {
    const { valid } = summarize(
      `kortix_version = 1\n[env]\nrequired = ["api_key"]`,
    );
    // The runtime canonicalizes to uppercase; we don't fail the build for casing.
    expect(valid).toBe(true);
  });

  test('rejects names that start with a digit', () => {
    const { errorPaths, valid } = summarize(
      `kortix_version = 1\n[env]\nrequired = ["1API_KEY"]`,
    );
    expect(valid).toBe(false);
    expect(errorPaths.some((p) => p.startsWith('env.required'))).toBe(true);
  });

  test('rejects names with hyphens or punctuation', () => {
    const { errorPaths, valid } = summarize(
      `kortix_version = 1\n[env]\nrequired = ["MY-KEY"]`,
    );
    expect(valid).toBe(false);
    expect(errorPaths.some((p) => p.startsWith('env.required'))).toBe(true);
  });

  test('warns on unknown [env] keys', () => {
    const { warningPaths, valid } = summarize(
      `kortix_version = 1\n[env]\nrequired = ["ANTHROPIC_API_KEY"]\noptional = ["X"]\nmystery = "?"`,
    );
    expect(valid).toBe(true);
    expect(warningPaths).toContain('env.mystery');
  });
});

describe('validateManifest — [[sandbox.templates]]', () => {
  test('valid image-based template passes', () => {
    const { valid, issues } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "py"
name = "Python"
image = "python:3.12-slim"
cpu = 2
memory = 4
disk = 20
`);
    expect(valid).toBe(true);
    expect(issues.every((i) => i.severity !== 'error')).toBe(true);
  });

  test('rejects entries with both image AND dockerfile', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "bad"
image = "python:3.12-slim"
dockerfile = ".kortix/Dockerfile.x"
`);
    expect(errorPaths).toContain('sandbox.templates[0]');
  });

  test('rejects entries with neither image nor dockerfile', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "empty"
`);
    expect(errorPaths).toContain('sandbox.templates[0]');
  });

  test('rejects "default" as a reserved slug', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "default"
image = "ubuntu:22.04"
`);
    expect(errorPaths).toContain('sandbox.templates[0].slug');
  });

  test('rejects "latest" image tag with a warning (does not block)', () => {
    const { valid, warningPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "ml"
image = "python:latest"
`);
    expect(valid).toBe(true);
    expect(warningPaths).toContain('sandbox.templates[0].image');
  });

  test('rejects image without a tag or digest', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "x"
image = "ubuntu"
`);
    expect(errorPaths).toContain('sandbox.templates[0].image');
  });

  test('rejects bad slug format', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "Bad Slug!"
image = "ubuntu:22.04"
`);
    expect(errorPaths).toContain('sandbox.templates[0].slug');
  });

  test('rejects duplicate slugs', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "ml"
image = "python:3.12-slim"

[[sandbox.templates]]
slug = "ml"
image = "python:3.11-slim"
`);
    expect(errorPaths).toContain('sandbox.templates[1].slug');
  });

  test('rejects out-of-bounds cpu', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "tiny"
image = "alpine:3.20"
cpu = 0
`);
    expect(errorPaths).toContain('sandbox.templates[0].cpu');
  });

  test('rejects relative-path-escape Dockerfiles', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "esc"
dockerfile = "../etc/Dockerfile"
`);
    expect(errorPaths).toContain('sandbox.templates[0].dockerfile');
  });

  test('rejects legacy singular [sandbox] table', () => {
    const { errorPaths } = summarize(`
kortix_version = 1

[sandbox]
dockerfile = ".kortix/Dockerfile"
`);
    expect(errorPaths).toContain('sandbox');
  });

  test('accepts [sandbox] default pointing at a defined template', () => {
    const { valid } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "dev"
image = "ubuntu:24.04"
[sandbox]
default = "dev"
`);
    expect(valid).toBe(true);
  });

  test('accepts [sandbox] default = "default" (the platform image)', () => {
    const { valid } = summarize(`
kortix_version = 1
[sandbox]
default = "default"
`);
    expect(valid).toBe(true);
  });

  test('rejects [sandbox] default that names no defined template', () => {
    const { valid, errorPaths } = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "dev"
image = "ubuntu:24.04"
[sandbox]
default = "ghost"
`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('sandbox.default');
  });

  test('rejects the renamed legacy [[sandboxes]] form with a migration error', () => {
    const { valid, errorPaths } = summarize(`
kortix_version = 1
[[sandboxes]]
slug = "ml"
image = "python:3.12-slim"
`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('sandboxes');
  });

  test('warns on gpu key (not supported)', () => {
    const { warningPaths, valid } = summarize(`
kortix_version = 1

[[sandbox.templates]]
slug = "gpu"
image = "nvidia/cuda:12.2.0-base-ubuntu22.04"
gpu = 1
`);
    expect(valid).toBe(true);
    expect(warningPaths).toContain('sandbox.templates[0].gpu');
  });
});

describe('validateManifest — [[triggers]]', () => {
  test('cron trigger requires cron expression and prompt', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[triggers]]
slug = "no-cron"
type = "cron"
`);
    expect(errorPaths).toContain('triggers[0].cron');
    expect(errorPaths).toContain('triggers[0].prompt');
  });

  test('webhook trigger requires secret_env', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[triggers]]
slug = "hook"
type = "webhook"
prompt = "hi"
`);
    expect(errorPaths).toContain('triggers[0].secret_env');
  });

  test('valid cron trigger passes', () => {
    const { valid } = summarize(`
kortix_version = 1
[[triggers]]
slug = "daily"
type = "cron"
cron = "0 0 9 * * 1-5"
prompt = "Daily digest"
`);
    expect(valid).toBe(true);
  });

  test('session_mode = "reuse" is accepted', () => {
    const { valid } = summarize(`
kortix_version = 1
[[triggers]]
slug = "sweep"
type = "cron"
cron = "0 0 */6 * * *"
session_mode = "reuse"
prompt = "Error sweep"
`);
    expect(valid).toBe(true);
  });

  test('an invalid session_mode is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[triggers]]
slug = "sweep"
type = "cron"
cron = "0 0 */6 * * *"
session_mode = "sticky"
prompt = "Error sweep"
`);
    expect(errorPaths).toContain('triggers[0].session_mode');
  });
});

// `type: monitor` — docs/specs/2026-08-12-monitors.md. A monitor names a repo
// command the platform supervises 24/7; its stdout lines are the events.
describe('validateManifest — [[triggers]] type = "monitor"', () => {
  test('a stream monitor with run + mode passes', () => {
    const { valid } = summarize(`
kortix_version = 1
[[triggers]]
slug = "checkout-errors"
type = "monitor"
run = "./monitors/checkout-errors.ts"
mode = "stream"
prompt = "Checkout monitor emitted: {{ line }}"
`);
    expect(valid).toBe(true);
  });

  test('a poll monitor with an interval passes', () => {
    const { valid } = summarize(`
kortix_version = 1
[[triggers]]
slug = "queue-depth"
type = "monitor"
run = "./monitors/queue-depth.ts"
mode = "poll"
interval = "60s"
expect_event_within = "24h"
prompt = "Queue: {{ line }}"
`);
    expect(valid).toBe(true);
  });

  test('monitor requires run and mode', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[triggers]]
slug = "bare"
type = "monitor"
prompt = "go"
`);
    expect(errorPaths).toContain('triggers[0].run');
    expect(errorPaths).toContain('triggers[0].mode');
  });

  test('mode = "poll" requires an interval', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[triggers]]
slug = "poller"
type = "monitor"
run = "./m.ts"
mode = "poll"
prompt = "go"
`);
    expect(errorPaths).toContain('triggers[0].interval');
  });

  test('an interval below the 30s floor is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[triggers]]
slug = "poller"
type = "monitor"
run = "./m.ts"
mode = "poll"
interval = "5s"
prompt = "go"
`);
    expect(errorPaths).toContain('triggers[0].interval');
  });

  test('an expect_event_within below the 5m floor is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[triggers]]
slug = "streamer"
type = "monitor"
run = "./m.ts"
mode = "stream"
expect_event_within = "60s"
prompt = "go"
`);
    expect(errorPaths).toContain('triggers[0].expect_event_within');
  });

  test('a bare number is not a duration', () => {
    const { errorPaths } = summarize({
      kortix_version: 1,
      triggers: [
        { slug: 'poller', type: 'monitor', run: './m.ts', mode: 'poll', interval: 60, prompt: 'go' },
      ],
    });
    expect(errorPaths).toContain('triggers[0].interval');
  });

  test('interval on a stream monitor is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[triggers]]
slug = "streamer"
type = "monitor"
run = "./m.ts"
mode = "stream"
interval = "60s"
prompt = "go"
`);
    expect(errorPaths).toContain('triggers[0].interval');
  });

  test('an unknown mode is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[triggers]]
slug = "streamer"
type = "monitor"
run = "./m.ts"
mode = "tail"
prompt = "go"
`);
    expect(errorPaths).toContain('triggers[0].mode');
  });

  // cron/webhook wiring on a monitor is a hard error: silently ignoring it
  // would let a manifest claim a schedule the monitor runner never reads.
  test('cron, run_at, timezone, and secret_env are rejected on a monitor', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[triggers]]
slug = "mixed"
type = "monitor"
run = "./m.ts"
mode = "stream"
cron = "0 0 9 * * 1-5"
run_at = "2026-06-01T09:00:00Z"
timezone = "UTC"
secret_env = "WEBHOOK_SECRET"
prompt = "go"
`);
    expect(errorPaths).toContain('triggers[0].cron');
    expect(errorPaths).toContain('triggers[0].run_at');
    expect(errorPaths).toContain('triggers[0].timezone');
    expect(errorPaths).toContain('triggers[0].secret_env');
  });

  test('a monitor still requires a prompt and a valid session_mode', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[triggers]]
slug = "streamer"
type = "monitor"
run = "./m.ts"
mode = "stream"
session_mode = "sticky"
`);
    expect(errorPaths).toContain('triggers[0].prompt');
    expect(errorPaths).toContain('triggers[0].session_mode');
  });
});

describe('validateManifest — [[connectors]]', () => {
  test('provider must be one of the known values', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[connectors]]
slug = "wat"
provider = "made-up"
`);
    expect(errorPaths).toContain('connectors[0].provider');
  });

  test('mcp connector requires url', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[connectors]]
slug = "mcp1"
provider = "mcp"
`);
    expect(errorPaths).toContain('connectors[0].url');
  });

  test('postman connector accepts a repository source and requires spec', () => {
    const accepted = summarize(`
kortix_version = 1
[[connectors]]
slug = "hubspot"
provider = "postman"
spec = "https://github.com/HubSpot/HubSpot-public-api-spec-collection"
`);
    expect(accepted.errorPaths).toEqual([]);
    expect(accepted.valid).toBe(true);

    const missing = summarize(`
kortix_version = 1
[[connectors]]
slug = "hubspot"
provider = "postman"
`);
    expect(missing.warningPaths).toContain('connectors[0].spec');
  });

  test('auth.secret is rejected', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[connectors]]
slug = "stripe"
provider = "openapi"
spec = "https://example.com/openapi.json"
  [connectors.auth]
  type = "bearer"
  secret = "STRIPE_API_KEY"
`);
    expect(errorPaths).toContain('connectors[0].auth.secret');
  });

  test('a valid `headers` table is accepted', () => {
    const { valid, errorPaths } = summarize(`
kortix_version = 1
[[connectors]]
slug = "acme"
provider = "http"
base_url = "https://api.acme.com"
  [connectors.headers]
  Accept = "application/json"
  "X-Tenant-Id" = "acme"
`);
    expect(errorPaths).toEqual([]);
    expect(valid).toBe(true);
  });

  test('an illegal header name is an error', () => {
    const { errorPaths, issues } = summarize(`
kortix_version = 1
[[connectors]]
slug = "acme"
provider = "http"
base_url = "https://api.acme.com"
  [connectors.headers]
  "X Tenant Id" = "acme"
`);
    expect(errorPaths).toContain('connectors[0].headers');
    expect(issues.some((i) => i.message.includes('invalid header name'))).toBe(true);
  });

  test('CR/LF in a header value is an error (header injection)', () => {
    const { errorPaths, issues } = summarize(`
kortix_version = 1
[[connectors]]
slug = "acme"
provider = "http"
base_url = "https://api.acme.com"
  [connectors.headers]
  "X-Tenant-Id" = "acme\\r\\nX-Admin: true"
`);
    expect(errorPaths).toContain('connectors[0].headers');
    expect(issues.some((i) => i.message.includes('CR or LF'))).toBe(true);
  });

  test('headers on a platform-called provider are a warning (inert at runtime)', () => {
    const { valid, warningPaths } = summarize(`
kortix_version = 1
[[connectors]]
slug = "gmail"
provider = "pipedream"
app = "gmail"
  [connectors.headers]
  Accept = "application/json"
`);
    expect(warningPaths).toContain('connectors[0].headers');
    expect(valid).toBe(true);
  });

  test('policy action must be one of the known values', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[connectors]]
slug = "stripe"
provider = "openapi"
spec = "https://example.com/openapi.json"
  [connectors.auth]
  type = "none"
  [[connectors.policies]]
  match = "*"
  action = "ALLOW"
`);
    expect(errorPaths).toContain('connectors[0].policies[0].action');
  });

  // The platform itself writes an equivalent entry into kortix.yaml when a Slack
  // channel is connected (connector/channel-manifest.ts); this exercises the same
  // shape against the legacy v1 (kortix.toml) validator. The gate must accept it,
  // or it blocks merging a manifest the backend produced.
  test('a platform-written channel connector is valid', () => {
    const { valid, errorPaths } = summarize(`
kortix_version = 1
[[connectors]]
slug = "kortix_slack"
provider = "channel"
platform = "slack"
`);
    expect(errorPaths).toEqual([]);
    expect(valid).toBe(true);
  });

  test('channel connector requires a known platform', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[connectors]]
slug = "kortix_slack"
provider = "channel"
`);
    expect(errorPaths).toContain('connectors[0].platform');
  });

  test('channel connector must not declare [connectors.auth]', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[connectors]]
slug = "kortix_slack"
provider = "channel"
platform = "slack"
  [connectors.auth]
  type = "bearer"
`);
    expect(errorPaths).toContain('connectors[0].auth');
  });

  test('a reserved slug rejects the wrong provider', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[connectors]]
slug = "kortix_slack"
provider = "http"
base_url = "https://example.com"
`);
    expect(errorPaths).toContain('connectors[0].provider');
  });

  test('computer cannot be declared by hand', () => {
    const result = summarize(`
kortix_version = 1
[[connectors]]
slug = "computer"
provider = "computer"
`);
    expect(result.errorPaths).toContain('connectors[0].provider');
    expect(result.issues.some((i) => i.message.includes('managed automatically'))).toBe(true);
  });

  // The platform now also writes a `meet` channel connector — mirrors
  // connectors.ts's CHANNEL_PLATFORMS (which already included it) and
  // RESERVED_SLUG_PROVIDERS (`kortix_voice`). Was previously rejected by the
  // schema gate even though the runtime accepted it.
  test('a platform-written "voice" channel connector is valid', () => {
    const { valid, errorPaths } = summarize(`
kortix_version = 1
[[connectors]]
slug = "kortix_voice"
provider = "channel"
platform = "voice"
`);
    expect(errorPaths).toEqual([]);
    expect(valid).toBe(true);
  });

  test('reserved slug "kortix_voice" rejects a mismatched provider', () => {
    const { errorPaths } = summarize(`
kortix_version = 1
[[connectors]]
slug = "kortix_voice"
provider = "http"
base_url = "https://example.com"
`);
    expect(errorPaths).toContain('connectors[0].provider');
  });
});

describe('validateManifest — Kortix Apps', () => {
  test('rejects the retired v1 section and accepts the provider-neutral v2 map', () => {
    expect(summarize('kortix_version = 1\n[[apps]]\nslug = "site"').errorPaths).toContain('apps');
    const v2 = validateManifest(
      `kortix_version: 2
default_agent: w
agents:
  w: {}
apps:
  web:
    path: .
    type: dockerfile
    dockerfile: Dockerfile
    command: [bun, run, start]
    port: 3000
    readiness_path: /health
    idle_timeout_seconds: 300
    resources:
      cpu: 1
      memory_gb: 2
      disk_gb: 10
    env:
      NODE_ENV: production
    secrets:
      DATABASE_URL: DATABASE_URL`,
      'yaml',
    );
    expect(v2.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  test('rejects invalid v2 App ports, commands, resources, and secret mappings', () => {
    const result = validateManifest(
      `kortix_version: 2
default_agent: w
agents:
  w: {}
apps:
  bad:
    type: dockerfile
    command: []
    port: 8080
    resources:
      cpu: 0
    secrets:
      DATABASE_URL: ""`,
      'yaml',
    );
    const paths = result.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.path);
    expect(paths).toContain('apps.bad.command');
    expect(paths).toContain('apps.bad.port');
    expect(paths).toContain('apps.bad.resources.cpu');
    expect(paths).toContain('apps.bad.secrets.DATABASE_URL');
  });
});

// The gate must accept every form the runtime parser accepts, or it falsely
// blocks a manifest that materializes fine — the same bug class as the missing
// `channel` provider. These lock the gate to the runtime's input tolerance.
describe('validateManifest — input tolerance (mirrors runtime parser)', () => {
  function connectorErrors(body: string): string[] {
    return validateManifest(`kortix_version = 1\n${body}`)
      .issues.filter((i) => i.severity === 'error')
      .map((i) => i.path);
  }

  test('trigger accepts the prompt_template alias', () => {
    expect(
      connectorErrors(`[[triggers]]\nslug = "t"\ntype = "cron"\ncron = "0 9 * * *"\nprompt_template = "go"`),
    ).not.toContain('triggers[0].prompt');
  });

  test('cron trigger accepts the schedule alias', () => {
    expect(
      connectorErrors(`[[triggers]]\nslug = "t"\ntype = "cron"\nschedule = "0 9 * * *"\nprompt = "go"`),
    ).not.toContain('triggers[0].cron');
  });

  test('trigger enabled accepts coercible values', () => {
    expect(
      connectorErrors(`[[triggers]]\nslug = "t"\ntype = "cron"\ncron = "0 9 * * *"\nprompt = "go"\nenabled = 1`),
    ).not.toContain('triggers[0].enabled');
  });

  test('trigger session_mode is case-insensitive', () => {
    expect(
      connectorErrors(`[[triggers]]\nslug = "t"\ntype = "cron"\ncron = "0 9 * * *"\nprompt = "go"\nsession_mode = "Reuse"`),
    ).not.toContain('triggers[0].session_mode');
  });

  test('connector provider is case-insensitive', () => {
    expect(connectorErrors(`[[connectors]]\nslug = "m"\nprovider = "MCP"\nurl = "https://e.com"`)).toEqual([]);
  });

  test('http connector accepts the baseUrl alias', () => {
    expect(connectorErrors(`[[connectors]]\nslug = "h"\nprovider = "http"\nbaseUrl = "https://e.com"`)).toEqual([]);
  });

  test('an empty-string grant is accepted as deny', () => {
    expect(
      connectorErrors(`[[agents]]\nname = "a"\nkortix_cli = ""\nconnectors = ""`),
    ).toEqual([]);
  });

});

describe('formatIssues', () => {
  test('renders both errors and warnings in a stable shape', () => {
    const { issues } = validateManifest(`
[[sandbox.templates]]
slug = "default"
image = "ubuntu:22.04"
`);
    const text = formatIssues(issues, { color: false });
    expect(text).toContain('error sandbox.templates[0].slug');
    expect(text).toContain('kortix_version');
  });
});
