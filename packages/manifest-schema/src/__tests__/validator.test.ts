import { describe, expect, test } from 'bun:test';
import { validateManifest, formatIssues } from '../index.ts';

function summarize(input: string | Record<string, unknown>) {
  const result = validateManifest(input);
  const errorPaths = result.issues.filter((i) => i.severity === 'error').map((i) => i.path);
  const warningPaths = result.issues.filter((i) => i.severity === 'warning').map((i) => i.path);
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
    const { errorPaths, valid } = summarize(
      `kortix_version = 1\n[env]\nrequired = "ANTHROPIC_API_KEY"`,
    );
    expect(valid).toBe(false);
    expect(errorPaths).toContain('env.required');
  });

  test('accepts lowercase env names (upper-cased by the runtime)', () => {
    const { valid } = summarize(`kortix_version = 1\n[env]\nrequired = ["api_key"]`);
    // The runtime canonicalizes to uppercase; we don't fail the build for casing.
    expect(valid).toBe(true);
  });

  test('rejects names that start with a digit', () => {
    const { errorPaths, valid } = summarize(`kortix_version = 1\n[env]\nrequired = ["1API_KEY"]`);
    expect(valid).toBe(false);
    expect(errorPaths.some((p) => p.startsWith('env.required'))).toBe(true);
  });

  test('rejects names with hyphens or punctuation', () => {
    const { errorPaths, valid } = summarize(`kortix_version = 1\n[env]\nrequired = ["MY-KEY"]`);
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

  test('container_runtime accepts a boolean and rejects anything else', () => {
    const ok = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "dev"
dockerfile = ".kortix/Dockerfile.dev"
container_runtime = true
`);
    expect(ok.valid).toBe(true);
    const bad = summarize(`
kortix_version = 1
[[sandbox.templates]]
slug = "dev"
dockerfile = ".kortix/Dockerfile.dev"
container_runtime = "yes"
`);
    expect(bad.errorPaths).toContain('sandbox.templates[0].container_runtime');
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

// `type: monitor`. A monitor names a repo
// command the platform supervises 24/7; its stdout lines are the events.
describe('validateManifest — [[triggers]] type = "monitor" (removed)', () => {
  test('a monitor entry answers the removal error naming the App replacement', () => {
    const result = validateManifest('kortix_version: 1\ntriggers:\n  - slug: t\n    type: monitor\n    run: ./m.ts\n    mode: stream\n    prompt: go\n', 'yaml');
    expect(result.valid).toBe(false);
    expect(result.issues.find((issue) => issue.path === 'triggers[0].type')?.message).toContain('monitor triggers were removed');
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
});

describe('validateManifest — Kortix Apps', () => {
  // This fixture used to set `NODE_ENV` here. It was never deployable: the API
  // refuses reserved env names when it builds a deployment's environment, and
  // `NODE_ENV` is on that list. The validator simply did not know, so the
  // fixture encoded a manifest that passed `validate` and failed `deploy` —
  // the exact drift `app-env-reserved.test.ts` now prevents. Renamed rather
  // than deleted, because what this test is actually about is the v2 App map.
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
      APP_MODE: production
    secrets:
      DATABASE_URL: DATABASE_URL`,
      'yaml',
    );
    expect(v2.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  test('a v2 App names the Apps it uses, by slug', () => {
    const errors = (yaml: string) =>
      validateManifest(`kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\napps:\n${yaml}`, 'yaml')
        .issues.filter((issue) => issue.severity === 'error');
    expect(errors('  db:\n    path: db\n    resources: { cpu: 2 }\n  crm:\n    path: apps/crm\n    uses: [db, billing-db]')).toEqual([]);
    expect(errors('  crm:\n    uses: [Main, ""]').map((issue) => issue.path)).toEqual(['apps.crm.uses[0]', 'apps.crm.uses[1]']);
    expect(errors('  crm:\n    uses: db').map((issue) => issue.path)).toEqual(['apps.crm.uses']);
    expect(errors('  crm:\n    uses: [crm]').map((issue) => issue.path)).toEqual(['apps.crm.uses[0]']);
  });

  test('the retired `kind` field warns and still validates: an App\'s shape comes from its config', () => {
    for (const kind of ['convex', 'web', 'lambda']) {
      const result = validateManifest(`kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\napps:\n  db:\n    kind: ${kind}\n    type: static`, 'yaml');
      expect(result.issues.filter((entry) => entry.severity === 'error').map((entry) => entry.path)).toEqual([]);
      const issue = result.issues.find((entry) => entry.path === 'apps.db.kind');
      expect(issue?.severity).toBe('warning');
      expect(issue?.message).toContain('retired');
      expect(issue?.message).toContain('kortix-apps skill templates');
    }
  });

  test('the retired `backends` field names its replacement', () => {
    const result = validateManifest('kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\napps:\n  crm:\n    backends: [main]', 'yaml');
    const issue = result.issues.find((entry) => entry.path === 'apps.crm.backends');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('uses');
  });

  test('the retired `monthly_budget_usd` field warns and still validates: Apps have no budget', () => {
    const result = validateManifest('kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\napps:\n  api:\n    always_on: false\n    monthly_budget_usd: 5', 'yaml');
    expect(result.issues.filter((entry) => entry.severity === 'error')).toEqual([]);
    const issue = result.issues.find((entry) => entry.path === 'apps.api.monthly_budget_usd');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('no budget');
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
    const paths = result.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.path);
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
      connectorErrors(
        `[[triggers]]\nslug = "t"\ntype = "cron"\ncron = "0 9 * * *"\nprompt_template = "go"`,
      ),
    ).not.toContain('triggers[0].prompt');
  });

  test('cron trigger accepts the schedule alias', () => {
    expect(
      connectorErrors(
        `[[triggers]]\nslug = "t"\ntype = "cron"\nschedule = "0 9 * * *"\nprompt = "go"`,
      ),
    ).not.toContain('triggers[0].cron');
  });

  test('trigger enabled accepts coercible values', () => {
    expect(
      connectorErrors(
        `[[triggers]]\nslug = "t"\ntype = "cron"\ncron = "0 9 * * *"\nprompt = "go"\nenabled = 1`,
      ),
    ).not.toContain('triggers[0].enabled');
  });

  test('trigger session_mode is case-insensitive', () => {
    expect(
      connectorErrors(
        `[[triggers]]\nslug = "t"\ntype = "cron"\ncron = "0 9 * * *"\nprompt = "go"\nsession_mode = "Reuse"`,
      ),
    ).not.toContain('triggers[0].session_mode');
  });

  test('connector provider is case-insensitive', () => {
    expect(
      connectorErrors(`[[connectors]]\nslug = "m"\nprovider = "MCP"\nurl = "https://e.com"`),
    ).toEqual([]);
  });

  test('http connector accepts the baseUrl alias', () => {
    expect(
      connectorErrors(`[[connectors]]\nslug = "h"\nprovider = "http"\nbaseUrl = "https://e.com"`),
    ).toEqual([]);
  });

  test('an empty-string grant is accepted as deny', () => {
    expect(connectorErrors(`[[agents]]\nname = "a"\nkortix_permissions = ""\nconnectors = ""`)).toEqual([]);
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

describe('validateManifest — [[triggers]] type = "event"', () => {
  const base = `kortix_version = 1\n[[triggers]]\nslug = "pr"\nprompt = "go"\n`;
  const paths = (toml: string) => validateManifest(toml, 'toml').issues.map((i) => i.path);

  test('connector + event (+ config table) passes', () => {
    const toml = `${base}type = "event"\nconnector = "github"\nevent = "GITHUB_PULL_REQUEST_EVENT"\n[triggers.config]\nowner = "acme"\n`;
    expect(validateManifest(toml, 'toml').valid).toBe(true);
  });

  test('missing connector and event are rejected', () => {
    expect(paths(`${base}type = "event"\n`)).toEqual(
      expect.arrayContaining(['triggers[0].connector', 'triggers[0].event']),
    );
  });

  test('config must be an object', () => {
    expect(paths(`${base}type = "event"\nconnector = "g"\nevent = "E"\nconfig = "x"\n`)).toContain(
      'triggers[0].config',
    );
  });

  test('cron wiring is rejected on an event trigger', () => {
    const p = paths(`${base}type = "event"\nconnector = "g"\nevent = "E"\ncron = "0 9 * * *"\n`);
    expect(p).toEqual(expect.arrayContaining(['triggers[0].cron']));
  });

  test('event keys are rejected on a cron trigger', () => {
    const p = paths(`${base}type = "cron"\ncron = "0 9 * * *"\nconnector = "g"\nevent = "E"\n`);
    expect(p).toEqual(expect.arrayContaining(['triggers[0].connector', 'triggers[0].event']));
  });
});

describe('apps: release config (processes, services, mounts, vm, deploy, labels)', () => {
  const issues = (yaml: string) =>
    validateManifest(`kortix_version: 2\ndefault_agent: w\nagents:\n  w: {}\napps:\n${yaml}`, 'yaml')
      .issues.filter((issue) => issue.severity === 'error').map((issue) => `${issue.path}: ${issue.message}`);

  test('a backend block validates: image, a data volume, two public services, always on, labels', () => {
    expect(issues(`  db:
    type: oci_image
    image: ghcr.io/example/backend:1
    command: ["/start.sh"]
    labels: [backend]
    vm: { cpu: 1, memory_gb: 1 }
    mounts:
      - { source: data, destination: /data, initial_size_gb: 10 }
    http_service: { internal_port: 3210, access: public, auto_stop_machines: "off", min_machines_running: 1 }
    services:
      - { name: site, internal_port: 3211, access: public }
    deploy: { strategy: rolling }`)).toEqual([]);
  });

  test('the engine rules surface in kortix validate: bluegreen with a volume, a reserved port, a system mount path, a bad label', () => {
    expect(issues(`  db:
    type: oci_image
    image: x
    command: ["/x"]
    labels: [Backend]
    http_service: { internal_port: 8080 }
    mounts:
      - { source: data, destination: /etc/data }
    deploy: { strategy: bluegreen }`)).toEqual([
      'apps.db.labels: must be at most 10 labels of lowercase letters, digits and "-".',
      'apps.db.http_service.internal_port: 8080 is reserved by the App supervisor.',
      'apps.db.mounts[0].destination: cannot sit under a system directory.',
      'apps.db.deploy.strategy: bluegreen needs two machines on one volume; an App with mounts deploys rolling or immediate.',
    ]);
  });

  test('wrong shapes are named before any rule runs; a static App ignores the machine fields', () => {
    expect(issues('  db:\n    mounts: { source: data }')).toEqual(['apps.db.mounts: must be a list of objects.']);
    expect(issues('  site:\n    type: static\n    mounts: [{ source: data, destination: /etc }]')).toEqual([]);
  });
  test('display: where Kortix shows the App; a parent must be another App of the file', () => {
    expect(issues(`  db:
    type: static
    display: { preview: none }
  db-dashboard:
    type: static
    display: { parent: db }
  worker:
    type: static
    display: { listed: false }`)).toEqual([]);
    expect(issues(`  db:
    type: static
    display: { parent: db, preview: icon, hidden: true }
  dash:
    type: static
    display: { parent: nope }`)).toEqual([
      'apps.db.display.hidden: is not a display field (listed, preview, parent).',
      'apps.db.display.preview: must be live or none.',
      'apps.db.display.parent: an App cannot be its own parent.',
      'apps.dash.display.parent: names no App in this file.',
    ]);
  });
});
