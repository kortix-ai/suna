import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

import {
  kortixRuntimeAssets,
  officialSupabaseDockerAssets,
  renderFullDockerCompose,
  SUPABASE_IMAGE_DIGESTS,
  SUPABASE_UPSTREAM_COMMIT,
  supabaseUpstreamDockerAssets,
  supabaseVendorAssets,
  writeKortixRuntimeAssets,
  writeOfficialSupabaseDockerAssets,
  writeSupabaseVendorAssets,
} from '../compose-assets.ts';

describe('full self-host Docker distribution', () => {
  test('renders the complete pinned Supabase and Kortix service set', () => {
    const document = parse(renderFullDockerCompose('kortix-enterprise')) as {
      services: Record<string, {
        image?: string;
        container_name?: string;
        ports?: string[];
        depends_on?: Record<string, unknown>;
        healthcheck?: { test?: string[] };
      }>;
    };

    expect(Object.keys(document.services).sort()).toEqual([
      'frontend',
      'kortix-api',
      'kortix-migrate',
      'kortix-updater',
      'llm-gateway',
      'supabase-analytics',
      'supabase-auth',
      'supabase-db',
      'supabase-functions',
      'supabase-imgproxy',
      'supabase-kong',
      'supabase-meta',
      'supabase-realtime',
      'supabase-rest',
      'supabase-storage',
      'supabase-studio',
      'supabase-supavisor',
      'supabase-vector',
    ]);
    expect(document.services['supabase-db']?.image).toBe(`supabase/postgres:17.6.1.136@${SUPABASE_IMAGE_DIGESTS['supabase/postgres:17.6.1.136']}`);
    expect(document.services['supabase-studio']?.image).toBe(`supabase/studio:2026.07.07-sha-a6a04f2@${SUPABASE_IMAGE_DIGESTS['supabase/studio:2026.07.07-sha-a6a04f2']}`);
    expect(document.services['supabase-analytics']?.image).toBe(`supabase/logflare:1.43.1@${SUPABASE_IMAGE_DIGESTS['supabase/logflare:1.43.1']}`);
    expect(document.services['supabase-db']?.healthcheck?.test).toEqual([
      'CMD-SHELL',
      'tr \'\\0\' \' \' </proc/1/cmdline | grep -q \'/postgres \' && PGPASSWORD="$${POSTGRES_PASSWORD}" psql -h supabase-db -U supabase_auth_admin -d "$${POSTGRES_DB}" -tAc \'select 1\' >/dev/null',
    ]);

    for (const [name, service] of Object.entries(document.services)) {
      expect(service.container_name, `${name} must support multiple Kortix instances`).toBeUndefined();
      if (service.image && !service.image.startsWith('${')) {
        if (name.startsWith('supabase-')) {
          expect(service.image, `${name} image must be immutable`).toMatch(/@sha256:[a-f0-9]{64}$/);
        } else {
          expect(service.image, `${name} image must not use latest`).not.toEndWith(':latest');
        }
      }
      for (const port of service.ports ?? []) {
        expect(port, `${name} must bind only on loopback`).toStartWith('127.0.0.1:');
      }
      for (const dependency of Object.keys(service.depends_on ?? {})) {
        expect(document.services[dependency], `${name} depends on missing ${dependency}`).toBeDefined();
      }
    }
  });

  test('supavisor carries an explicit nofile ulimits override (100000/100000)', () => {
    // supavisor's entrypoint (limits.sh) unconditionally runs `ulimit -n
    // 100000` before starting. Without an explicit `ulimits:` override, the
    // container inherits the HOST's default open-files limit, which is well
    // under 100000 on plenty of real VPS/EC2 images — `ulimit -n 100000` then
    // fails with EPERM and the container restart-loops forever (confirmed
    // live on a demo EC2 box). This mirrors the old enterprise appliance's
    // docker-compose.enterprise.yml override, restored here for the generic
    // compose file.
    const document = parse(renderFullDockerCompose('kortix-default')) as {
      services: Record<string, { ulimits?: { nofile?: { soft?: number; hard?: number } } }>;
    };
    expect(document.services['supabase-supavisor']?.ulimits).toEqual({
      nofile: { soft: 100000, hard: 100000 },
    });
  });

  test('omits the caddy reverse-proxy service when no domain is configured', () => {
    const document = parse(renderFullDockerCompose('kortix-default')) as {
      services: Record<string, unknown>;
    };
    expect(document.services).not.toHaveProperty('caddy');
  });

  test('includes the caddy reverse-proxy service only when a domain is configured', () => {
    const document = parse(renderFullDockerCompose('kortix-default', { domainConfigured: true })) as {
      services: Record<string, {
        image?: string;
        ports?: string[];
        environment?: Record<string, string>;
        healthcheck?: { test?: string[] };
      }>;
    };
    const caddy = document.services.caddy;
    expect(caddy).toBeDefined();
    expect(caddy?.ports).toEqual(['80:80', '443:443']);
    expect(caddy?.environment).toMatchObject({
      KORTIX_DOMAIN: '${KORTIX_DOMAIN}',
      KORTIX_API_DOMAIN: '${KORTIX_API_DOMAIN}',
    });
  });

  test('never mounts the Docker socket into kortix-api unless local-docker is selected', () => {
    const document = parse(renderFullDockerCompose('kortix-default')) as {
      services: Record<string, { volumes?: string[]; environment?: Record<string, string> }>;
    };
    const api = document.services['kortix-api'];
    expect(api?.volumes ?? []).not.toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(api?.environment?.LOCAL_DOCKER_NETWORK).toBeUndefined();
  });

  test('mounts the Docker socket + points LOCAL_DOCKER_NETWORK at this Compose project\'s own network when local-docker is selected', () => {
    const document = parse(renderFullDockerCompose('kortix-default', { localDockerConfigured: true })) as {
      services: Record<string, { volumes?: string[]; environment?: Record<string, string> }>;
    };
    const api = document.services['kortix-api'];
    expect(api?.volumes).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(api?.environment?.LOCAL_DOCKER_NETWORK).toBe('kortix-default_default');
    // Existing env (ALLOWED_SANDBOX_PROVIDERS etc.) must survive the merge.
    expect(api?.environment?.ALLOWED_SANDBOX_PROVIDERS).toBe('${ALLOWED_SANDBOX_PROVIDERS}');
  });

  test('omits the cloudflared tunnel service when tunnel mode is not selected', () => {
    const document = parse(renderFullDockerCompose('kortix-default')) as {
      services: Record<string, unknown>;
    };
    expect(document.services).not.toHaveProperty('cloudflared');

    // Also absent in domain mode alone — the two are independent toggles.
    const domainOnly = parse(renderFullDockerCompose('kortix-default', { domainConfigured: true })) as {
      services: Record<string, unknown>;
    };
    expect(domainOnly.services).not.toHaveProperty('cloudflared');
  });

  test('includes the cloudflared tunnel service only when tunnel mode is configured (quick-tunnel default)', () => {
    const document = parse(renderFullDockerCompose('kortix-default', { tunnelConfigured: true })) as {
      services: Record<string, {
        image?: string;
        environment?: Record<string, string> | null;
        depends_on?: Record<string, unknown>;
        command?: string[];
      }>;
    };
    const cloudflared = document.services.cloudflared;
    expect(cloudflared).toBeDefined();
    // Pinned to a specific version, not :latest — same immutability policy as
    // every other non-Supabase service image in this stack.
    expect(cloudflared?.image).toMatch(/^cloudflare\/cloudflared:\d+\.\d+\.\d+$/);
    expect(cloudflared?.depends_on).toHaveProperty('kortix-api');
    // No shell/entrypoint override: the official cloudflared image ships no
    // shell at all, so branching must happen at compose-render time (see
    // renderFullDockerCompose) — a runtime `/bin/sh -c` entrypoint can never
    // start against this image.
    expect(cloudflared).not.toHaveProperty('entrypoint');
    // Tunnels straight to kortix-api — Caddy is never present alongside it
    // (tunnel mode has no domain), and kortix-api already answers every
    // /v1* route the sandbox and other external callers need.
    const command = cloudflared?.command?.join(' ') ?? '';
    expect(command).toContain('http://kortix-api:8008');
  });

  test('named tunnel (CLOUDFLARE_TUNNEL_TOKEN + hostname): cloudflared runs `tunnel run` with TUNNEL_TOKEN, not the quick-tunnel URL', () => {
    const document = parse(
      renderFullDockerCompose('kortix-default', { tunnelConfigured: true, namedTunnelConfigured: true }),
    ) as {
      services: Record<string, { command?: string[]; environment?: Record<string, string> }>;
    };
    const cloudflared = document.services.cloudflared;
    expect(cloudflared).toBeDefined();
    expect(cloudflared?.command).toEqual(['tunnel', '--no-autoupdate', 'run']);
    expect(cloudflared?.environment).toMatchObject({ TUNNEL_TOKEN: '${CLOUDFLARE_TUNNEL_TOKEN}' });
  });

  test('cloudflared and caddy are independent — both, either, or neither can be present', () => {
    const neither = parse(renderFullDockerCompose('kortix-default')) as { services: Record<string, unknown> };
    expect(neither.services).not.toHaveProperty('caddy');
    expect(neither.services).not.toHaveProperty('cloudflared');

    const both = parse(renderFullDockerCompose('kortix-default', { domainConfigured: true, tunnelConfigured: true })) as {
      services: Record<string, unknown>;
    };
    expect(both.services).toHaveProperty('caddy');
    expect(both.services).toHaveProperty('cloudflared');
  });

  test('prod (domain-configured) mode: 2 replicas + no host ports for api/gateway/frontend, Caddy present', () => {
    const document = parse(renderFullDockerCompose('kortix-default', { domainConfigured: true })) as {
      services: Record<string, { ports?: string[]; deploy?: { replicas?: number } }>;
    };
    for (const name of ['kortix-api', 'llm-gateway', 'frontend'] as const) {
      const service = document.services[name];
      expect(service, name).toBeDefined();
      expect(service?.deploy?.replicas, `${name} replicas`).toBe(2);
      expect(service?.ports, `${name} must publish no host port in prod mode`).toBeUndefined();
    }
    expect(document.services.caddy).toBeDefined();
  });

  test('laptop (no domain) mode: single replica + loopback host ports for api/gateway/frontend, no Caddy', () => {
    const document = parse(renderFullDockerCompose('kortix-default')) as {
      services: Record<string, { ports?: string[]; deploy?: { replicas?: number } }>;
    };
    const api = document.services['kortix-api'];
    const frontend = document.services.frontend;
    const gateway = document.services['llm-gateway'];
    expect(api?.deploy?.replicas).toBe(1);
    expect(frontend?.deploy?.replicas).toBe(1);
    expect(gateway?.deploy?.replicas).toBe(1);
    expect(api?.ports?.[0]).toStartWith('127.0.0.1:');
    expect(frontend?.ports?.[0]).toStartWith('127.0.0.1:');
    // llm-gateway is never reached directly by a client in either mode.
    expect(gateway?.ports).toBeUndefined();
    expect(document.services).not.toHaveProperty('caddy');
  });

  test('the kortix-updater service is always present and mounts the docker socket', () => {
    const document = parse(renderFullDockerCompose('kortix-default')) as {
      services: Record<string, { volumes?: string[]; environment?: Record<string, string> }>;
    };
    const updater = document.services['kortix-updater'];
    expect(updater).toBeDefined();
    expect(updater?.volumes).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(updater?.environment).toHaveProperty('KORTIX_AUTO_UPDATE');
    expect(updater?.environment).toHaveProperty('KORTIX_UPDATE_TIME');
    expect(updater?.environment).toHaveProperty('KORTIX_UPDATE_TZ');
    expect(updater?.environment).toHaveProperty('KORTIX_ALLOW_DOWNTIME');
    expect(updater?.environment).toHaveProperty('KORTIX_APP_REPLICAS');
  });

  test('the kortix-updater service mounts the instance dir at its own host path (DinD self-referential mount), not a fixed /workspace', () => {
    // The regression this guards: `docker compose` runs INSIDE the
    // kortix-updater container, against the HOST daemon over the mounted
    // socket. Any relative bind mount elsewhere in this compose file (kong's
    // ./volumes/api/kong.yml, supabase-db's ./volumes/db/*, ...) is resolved
    // by that in-container `docker compose` CLI relative to its own
    // working_dir — and the resulting absolute path has to be one the HOST
    // daemon can actually satisfy. A fixed in-container-only `/workspace`
    // (the old shape) produces a host-side `/workspace/...` path that never
    // exists on the real host ("mounts denied: ... is not shared from the
    // host"). Mounting the instance directory at the SAME absolute path
    // inside the container as it has on the host — source == target,
    // `${KORTIX_INSTANCE_DIR}` — and pointing working_dir at that same path
    // is the fix: see the KORTIX_INSTANCE_DIR field doc comment on
    // SelfHostEnv in commands/self-host.ts.
    const document = parse(renderFullDockerCompose('kortix-default')) as {
      services: Record<string, {
        volumes?: string[];
        working_dir?: string;
        entrypoint?: string[];
        environment?: Record<string, string>;
      }>;
    };
    const updater = document.services['kortix-updater'];
    expect(updater).toBeDefined();
    expect(updater?.volumes).toContain('${KORTIX_INSTANCE_DIR}:${KORTIX_INSTANCE_DIR}');
    expect(updater?.working_dir).toBe('${KORTIX_INSTANCE_DIR}');
    expect(updater?.environment).toMatchObject({ KORTIX_INSTANCE_DIR: '${KORTIX_INSTANCE_DIR}' });
    // No leftover fixed-path mount/workdir from the pre-fix shape.
    for (const volume of updater?.volumes ?? []) {
      expect(volume, volume).not.toContain('/workspace');
    }
    expect(updater?.entrypoint?.join(' ') ?? '').not.toContain('/workspace');
  });

  test('app service healthchecks probe the correct path with a runtime present in the image', () => {
    const document = parse(renderFullDockerCompose('kortix-default')) as {
      services: Record<string, { healthcheck?: { test?: string[] } }>;
    };
    const apiTest = document.services['kortix-api']?.healthcheck?.test?.join(' ') ?? '';
    expect(apiTest).toContain('bun');
    expect(apiTest).toContain('/v1/health');

    const gatewayTest = document.services['llm-gateway']?.healthcheck?.test?.join(' ') ?? '';
    expect(gatewayTest).toContain('bun');
    expect(gatewayTest).toContain('localhost:8090/health');

    const frontendTest = document.services.frontend?.healthcheck?.test?.join(' ') ?? '';
    expect(frontendTest).toContain('node');
    expect(frontendTest).not.toContain('bun');
  });

  test('embeds the Caddyfile and updater script as runtime assets', () => {
    expect(Object.keys(kortixRuntimeAssets).sort()).toEqual(['Caddyfile', 'updater.sh']);
    expect(kortixRuntimeAssets.Caddyfile).toContain('{$KORTIX_DOMAIN}');
    expect(kortixRuntimeAssets.Caddyfile).toContain('{$KORTIX_API_DOMAIN}');
    expect(kortixRuntimeAssets['updater.sh']).toContain('docker compose');
    expect(kortixRuntimeAssets['updater.sh']).toContain('flock');
  });

  test('Caddyfile load-balances every replicated service with dynamic a + active health checks', () => {
    const caddyfile = kortixRuntimeAssets.Caddyfile;
    for (const [name, port, healthPath] of [
      ['kortix-api', '8008', '/v1/health'],
      ['llm-gateway', '8090', '/health'],
      ['frontend', '3000', '/'],
    ] as const) {
      expect(caddyfile, name).toContain(`name ${name}`);
      expect(caddyfile, name).toContain(`port ${port}`);
      expect(caddyfile, name).toContain(`health_uri ${healthPath}`);
    }
    expect(caddyfile).toContain('dynamic a');
    expect(caddyfile).toContain('fail_duration');
  });

  test('Caddyfile sends a conservative HSTS header (no preload) on both site blocks', () => {
    const caddyfile = kortixRuntimeAssets.Caddyfile;
    const matches = [...caddyfile.matchAll(/Strict-Transport-Security "([^"]+)"/g)];
    expect(matches.length).toBe(2);
    for (const [, value] of matches) {
      expect(value).toMatch(/^max-age=\d+$/);
      expect(value).not.toContain('preload');
      const maxAge = Number(value!.replace('max-age=', ''));
      // Conservative: at most 90 days. Caddy's automatic-HTTPS redirect
      // (verified separately below/at render time) already covers the
      // http->https requirement without needing an aggressive HSTS value.
      expect(maxAge).toBeLessThanOrEqual(60 * 60 * 24 * 90);
      expect(maxAge).toBeGreaterThan(0);
    }
  });

  test('every service in the rendered stack has bounded, rotated logging', () => {
    const document = parse(renderFullDockerCompose('kortix-default', { domainConfigured: true, tunnelConfigured: true })) as {
      services: Record<string, { logging?: { driver?: string; options?: Record<string, string> } }>;
    };
    const names = Object.keys(document.services);
    expect(names.length).toBeGreaterThan(15);
    for (const [name, service] of Object.entries(document.services)) {
      expect(service.logging?.driver, name).toBe('json-file');
      expect(service.logging?.options?.['max-size'], name).toBe('10m');
      expect(service.logging?.options?.['max-file'], name).toBe('3');
    }
  });

  test('every service has a memory ceiling; Postgres is protected, analytics/vector are the tightest-capped', () => {
    const document = parse(renderFullDockerCompose('kortix-default', { domainConfigured: true, tunnelConfigured: true })) as {
      services: Record<string, { mem_limit?: string; mem_reservation?: string; oom_score_adj?: number }>;
    };
    const toMb = (value: string) => Number(value.replace(/m$/, ''));
    for (const [name, service] of Object.entries(document.services)) {
      expect(service.mem_limit, name).toBeDefined();
      expect(service.mem_reservation, name).toBeDefined();
    }
    const db = document.services['supabase-db'];
    expect(db?.oom_score_adj).toBeLessThan(0);
    const analytics = document.services['supabase-analytics'];
    const vector = document.services['supabase-vector'];
    expect(analytics?.oom_score_adj).toBeGreaterThan(0);
    expect(vector?.oom_score_adj).toBeGreaterThan(0);
    // The full worst-case (every STEADY-STATE service simultaneously at its
    // own ceiling) must still fit comfortably on an 8GB box — these are
    // circuit-breaker ceilings, not a steady-state budget, but they must not
    // be so generous that the documented floor is fiction. kortix-migrate is
    // excluded: it's a one-shot job that runs to completion and exits before
    // the app tier is ever rolled, never concurrent with the rest at steady
    // state (see kortix-compose.yml: `restart: "no"`).
    const totalCeilingMb = Object.entries(document.services)
      .filter(([name]) => name !== 'kortix-migrate')
      .map(([, service]) => (service.mem_limit ? toMb(service.mem_limit) : 0))
      .reduce((a, b) => a + b, 0);
    expect(totalCeilingMb).toBeLessThan(8 * 1024);
  });

  test('kortix-updater image is pinned by digest, never :latest or a bare floating :cli tag', () => {
    const document = parse(renderFullDockerCompose('kortix-default')) as {
      services: Record<string, { image?: string }>;
    };
    const image = document.services['kortix-updater']?.image ?? '';
    expect(image).toMatch(/^docker:\d+\.\d+\.\d+-cli@sha256:[a-f0-9]{64}$/);
  });

  test('supabase-kong no longer gates on supabase-studio (Studio/Logflare must never block kortix-api cold boot)', () => {
    const document = parse(renderFullDockerCompose('kortix-default')) as {
      services: Record<string, { depends_on?: Record<string, unknown> }>;
    };
    const kong = document.services['supabase-kong'];
    expect(kong?.depends_on ?? {}).not.toHaveProperty('supabase-studio');
    // kortix-api still (correctly) depends on Kong itself — only the
    // unnecessary Kong -> Studio -> Analytics tail behind it is cut.
    const api = document.services['kortix-api'];
    expect(api?.depends_on).toHaveProperty('supabase-kong');
  });

  test('GoTrue rate limiting is actually active (GOTRUE_RATE_LIMIT_HEADER set)', () => {
    // GoTrue no-ops every per-IP rate limit whenever this header is unset,
    // regardless of the numeric limit values — see performRateLimitingWithHeader
    // in supabase/auth. Upstream's own compose file never sets it.
    const document = parse(renderFullDockerCompose('kortix-default')) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    const auth = document.services['supabase-auth'];
    expect(auth?.environment?.GOTRUE_RATE_LIMIT_HEADER).toBeTruthy();
    expect(auth?.environment?.GOTRUE_RATE_LIMIT_EMAIL_SENT).toBeTruthy();
    expect(auth?.environment?.GOTRUE_RATE_LIMIT_OTP).toBeTruthy();
  });

  test('updater.sh: a failed per-service swap does not abort the remaining services (no silent mixed-version state)', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    const perform = script.slice(script.indexOf('\nperform_update() {'), script.indexOf('next_run_epoch()'));
    expect(perform).toContain('for svc in $ROLL_SERVICES; do');
    // The old early-return-on-first-failure shape must be gone...
    expect(perform).not.toContain('leaving remaining services untouched');
    // ...replaced by a loop that keeps going and stamps a degraded outcome.
    expect(perform).toContain('degraded, not mixed-and-silent');
    expect(script).toContain('write_status "degraded"');
  });

  test('updater.sh: the scheduler loop never lets a failed run exit/crash the standing container', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    const loop = script.slice(script.lastIndexOf('while true; do'));
    expect(loop).toContain('run_locked nightly ||');
    expect(loop).not.toMatch(/\n\s*run_locked nightly\s*\n/);
  });

  test('updater.sh: every run stamps a machine-readable outcome, and `status`/`report` subcommands surface it', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    expect(script).toContain('STATUS_FILE="$STATE_DIR/update-status.json"');
    expect(script).toContain('write_status()');
    expect(script).toContain('"${1:-}" = "status"');
    expect(script).toContain('"${1:-}" = "report"');
  });

  test('updater.sh: drift between declared and running images is detected explicitly', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    expect(script).toContain('check_drift()');
    expect(script).toContain('drift_report_json()');
    expect(script).toContain('DRIFT:');
  });

  test('updater.sh: disk-space preflight runs before any pull, and image GC runs only after a fully successful run', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    const perform = script.slice(script.indexOf('\nperform_update() {'), script.indexOf('next_run_epoch()'));
    const preflightIdx = perform.indexOf('disk_preflight');
    const pullIdx = perform.indexOf('$COMPOSE pull');
    expect(preflightIdx).toBeGreaterThan(-1);
    expect(pullIdx).toBeGreaterThan(preflightIdx);
    // Restrict to the "some service actually changed" branch (after the
    // pending_version() read below the early-return "nothing to roll" path,
    // which has its own separate degraded stamp for a stateful-service
    // health-gate failure and isn't what this assertion is about).
    const swapBranch = perform.slice(perform.indexOf('to_version=$(pending_version)'));
    const gcIdx = swapBranch.indexOf('gc_images');
    const degradedIdx = swapBranch.indexOf('write_status "degraded"');
    expect(gcIdx).toBeGreaterThan(-1);
    expect(degradedIdx).toBeGreaterThan(-1);
    expect(gcIdx).toBeLessThan(degradedIdx);
  });

  test('updater.sh: a lock-contention loser reports who currently holds the lock instead of silently no-op\'ing', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    expect(script).toContain('HOLDER_FILE=');
    expect(script).toContain('another update run is already in progress');
    expect(script).toContain('exit 75');
  });

  test('updater.sh: a stateful service recreate is health-gated with an explicit go/no-go', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    const fn = script.slice(script.indexOf('reconcile_stateful_services()'), script.indexOf('check_drift()'));
    expect(fn).toContain('wait_healthy');
    expect(fn).toContain('(go)');
    expect(fn).toContain('(no-go)');
  });

  test('updater.sh: a post-swap crash-loop is watched for and stamped, with a one-line rollback hint', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    expect(script).toContain('watch_for_crash_loop()');
    expect(script).toContain('RestartCount');
    expect(script).toContain('rollback with: kortix self-host update');
  });

  test('updater.sh: the scheduler re-execs itself when the on-disk script changes (CLI-shipped fixes take effect without a manual recreate)', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    expect(script).toContain('maybe_reexec_self');
    expect(script).toContain('exec /bin/sh "$SCRIPT_FILE"');
  });

  test('updater.sh implements the start-first rollout: scale up new before stopping old', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    const rollFn = script.slice(script.indexOf('roll_service()'), script.indexOf('recreate_service()'));
    expect(rollFn).toContain('--no-recreate');
    expect(rollFn).toContain('--scale');

    const scaleUpIdx = rollFn.indexOf('$COMPOSE up -d --no-deps --no-recreate --scale');
    const waitHealthyIdx = rollFn.indexOf('wait_healthy');
    const removeOldIdx = rollFn.indexOf('remove_containers $old_ids');
    expect(scaleUpIdx).toBeGreaterThan(-1);
    expect(waitHealthyIdx).toBeGreaterThan(scaleUpIdx);
    expect(removeOldIdx).toBeGreaterThan(waitHealthyIdx);
  });

  test('updater.sh runs migrations before any service is rolled (migrate-before-swap)', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    const perform = script.slice(script.indexOf('perform_update()'), script.indexOf('next_run_epoch()'));
    const migrateIdx = perform.indexOf('run_migrate');
    const rollIdx = perform.indexOf('roll_or_recreate');
    expect(migrateIdx).toBeGreaterThan(-1);
    expect(rollIdx).toBeGreaterThan(migrateIdx);
    // A failed migration aborts before anything is swapped — and stamps a
    // "failed" outcome (not just a bare return) so `kortix self-host status`
    // shows exactly why nothing rolled.
    expect(perform).toContain('if ! run_migrate; then');
    const migrateGuardIdx = perform.indexOf('if ! run_migrate; then');
    const migrateFailureBlock = perform.slice(migrateGuardIdx, perform.indexOf('fi', migrateGuardIdx));
    expect(migrateFailureBlock).toContain('write_status "failed"');
    expect(migrateFailureBlock).toContain('return 1');
  });

  test('updater.sh leaves the old version serving when the new replicas never become healthy', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    expect(script).toContain('never became healthy; removing them and keeping the previous version serving');
    const rollFn = script.slice(script.indexOf('roll_service()'), script.indexOf('recreate_service()'));
    // The failure branch removes the NEW containers, never the old ones.
    expect(rollFn).toContain('remove_containers $new_ids');
    const failureBranch = rollFn.slice(rollFn.indexOf('else'));
    expect(failureBranch).not.toContain('remove_containers $old_ids');
  });

  test('updater.sh has a KORTIX_ALLOW_DOWNTIME escape hatch: stop-old then migrate then start-new', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    expect(script).toContain('KORTIX_ALLOW_DOWNTIME');
    const downtimeFn = script.slice(script.indexOf('downtime_swap()'), script.indexOf('reconcile_stateful_services()'));
    const stopIdx = downtimeFn.indexOf('rm --stop --force');
    const migrateIdx = downtimeFn.indexOf('run_migrate');
    const startIdx = downtimeFn.indexOf("up -d --no-deps --scale");
    expect(stopIdx).toBeGreaterThan(-1);
    expect(migrateIdx).toBeGreaterThan(stopIdx);
    expect(startIdx).toBeGreaterThan(migrateIdx);
  });

  test('updater.sh supports a one-shot "once" mode for a manual on-demand update', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    expect(script).toContain('"${1:-}" = "once"');
  });

  test('updater.sh falls back to an in-place recreate for a service publishing a host port (laptop mode)', () => {
    const script = kortixRuntimeAssets['updater.sh'];
    expect(script).toContain('publishes_host_port');
    expect(script).toContain('recreate_service');
  });

  test('updater.sh reads the compose file/.env from KORTIX_INSTANCE_DIR, not a hardcoded /workspace path', () => {
    // Regression test for the DinD "mounts denied" bug: updater.sh used to
    // hardcode /workspace/docker-compose.yml and /workspace/.env, which only
    // ever worked for bind-mount-free services (api/gateway/frontend) — any
    // updater-driven recreate of a bind-mounted service (kong, supabase-db,
    // ...) failed because /workspace/... doesn't exist on the real host. The
    // script must derive both paths from $WORKDIR (seeded from the
    // KORTIX_INSTANCE_DIR env var the compose service now sets — see
    // kortix-compose.yml), with /workspace only a defensive fallback default,
    // never a literal path baked into a command.
    const script = kortixRuntimeAssets['updater.sh'];
    expect(script).toContain('WORKDIR="${KORTIX_INSTANCE_DIR:-/workspace}"');
    expect(script).toContain('COMPOSE_FILE="$WORKDIR/docker-compose.yml"');
    expect(script).toContain('--env-file $WORKDIR/.env');
    expect(script).not.toContain('/workspace/.env');
    expect(script).not.toContain('/workspace/docker-compose.yml');
    // The two other reads of the env file (image_pull_mode, write_breadcrumb)
    // must also go through $WORKDIR, not a re-hardcoded /workspace.
    expect(script).toContain('grep \'^KORTIX_IMAGE_PULL=\' "$WORKDIR/.env"');
    expect(script).toContain('grep \'^KORTIX_VERSION=\' "$WORKDIR/.env"');
  });

  test('writes the Caddyfile and updater script to the instance directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-runtime-assets-'));
    try {
      writeKortixRuntimeAssets(root);
      expect(readFileSync(join(root, 'Caddyfile'), 'utf8')).toBe(kortixRuntimeAssets.Caddyfile);
      expect(readFileSync(join(root, 'updater.sh'), 'utf8')).toBe(kortixRuntimeAssets['updater.sh']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('embeds every upstream runtime asset required by the Compose mounts', () => {
    expect(Object.keys(supabaseVendorAssets).sort()).toEqual([
      'volumes/api/kong-entrypoint.sh',
      'volumes/api/kong.yml',
      'volumes/db/_supabase.sql',
      'volumes/db/jwt.sql',
      'volumes/db/logs.sql',
      'volumes/db/pooler.sql',
      'volumes/db/realtime.sql',
      'volumes/db/roles.sql',
      'volumes/db/webhooks.sql',
      'volumes/functions/hello/index.ts',
      'volumes/functions/main/index.ts',
      'volumes/logs/vector.yml',
      'volumes/pooler/pooler.exs',
    ]);
    for (const [path, content] of Object.entries(supabaseVendorAssets)) {
      expect(content.length, `${path} must not be empty`).toBeGreaterThan(10);
    }
  });

  test('writes bind-mounted assets with container-readable modes', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-supabase-assets-'));
    try {
      writeSupabaseVendorAssets(root);

      for (const relativePath of Object.keys(supabaseVendorAssets)) {
        const mode = statSync(join(root, relativePath)).mode & 0o777;
        expect(mode, relativePath).toBe(relativePath.endsWith('.sh') ? 0o755 : 0o644);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exports a Supabase-only official Docker distribution for AWS hosts', () => {
    expect(Object.keys(officialSupabaseDockerAssets).sort()).toEqual([
      'docker-compose.logs.yml',
      'docker-compose.yml',
      ...Object.keys(supabaseVendorAssets),
    ].sort());

    const document = parse(officialSupabaseDockerAssets['docker-compose.yml']!) as {
      services: Record<string, unknown>;
    };
    expect(Object.keys(document.services).sort()).toEqual([
      'auth',
      'db',
      'functions',
      'imgproxy',
      'kong',
      'meta',
      'realtime',
      'rest',
      'storage',
      'studio',
      'supavisor',
    ]);
    const logs = parse(officialSupabaseDockerAssets['docker-compose.logs.yml']!) as {
      services: Record<string, unknown>;
    };
    expect(Object.keys(logs.services).sort()).toEqual(['analytics', 'studio', 'vector']);
    expect(document.services).not.toHaveProperty('kortix-api');
    expect(document.services).not.toHaveProperty('frontend');
    expect(document.services).not.toHaveProperty('llm-gateway');
  });

  test('writes the complete Supabase-only Docker distribution', () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-official-supabase-assets-'));
    try {
      writeOfficialSupabaseDockerAssets(root);

      for (const [relativePath, content] of Object.entries(officialSupabaseDockerAssets)) {
        expect(readFileSync(join(root, relativePath), 'utf8'), relativePath).toBe(content);
        const mode = statSync(join(root, relativePath)).mode & 0o777;
        expect(mode, relativePath).toBe(relativePath.endsWith('.sh') ? 0o755 : 0o644);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('matches the reviewed upstream commit and content lock', () => {
    const lock = JSON.parse(
      readFileSync(new URL('../assets/supabase/upstream-lock.json', import.meta.url), 'utf8'),
    ) as { commit: string; files: Record<string, string> };
    expect(lock.commit).toBe(SUPABASE_UPSTREAM_COMMIT);

    const embeddedFiles: Record<string, string> = {
      'docker-compose.yml': readFileSync(new URL('../assets/supabase/docker-compose.yml', import.meta.url), 'utf8'),
      'docker-compose.logs.yml': readFileSync(new URL('../assets/supabase/docker-compose.logs.yml', import.meta.url), 'utf8'),
      ...Object.fromEntries(
        Object.entries(supabaseVendorAssets).map(([path, content]) => [
          path.endsWith('/index.ts') ? `${path}.txt` : path,
          content,
        ]),
      ),
    };
    expect(Object.keys(embeddedFiles).sort()).toEqual(Object.keys(lock.files).sort());
    for (const [path, content] of Object.entries(embeddedFiles)) {
      expect(createHash('sha256').update(content).digest('hex'), path).toBe(lock.files[path]);
    }
  });

  test('locks every official Supabase image tag to a reviewed OCI digest', () => {
    const upstreamReferences = Object.values(supabaseUpstreamDockerAssets).flatMap((compose) => {
      const document = parse(compose) as { services: Record<string, { image?: string }> };
      return Object.values(document.services).flatMap((service) => service.image ? [service.image] : []);
    }).sort();
    expect(Object.keys(SUPABASE_IMAGE_DIGESTS).sort()).toEqual(upstreamReferences);

    for (const compose of [
      officialSupabaseDockerAssets['docker-compose.yml']!,
      officialSupabaseDockerAssets['docker-compose.logs.yml']!,
    ]) {
      const document = parse(compose) as { services: Record<string, { image?: string }> };
      for (const [name, service] of Object.entries(document.services)) {
        if (!service.image) continue;
        const [reference, digest] = service.image.split('@');
        expect(digest, name).toBe(SUPABASE_IMAGE_DIGESTS[reference!]);
      }
    }
  });
});
