import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CI_DOCKER_COMPOSE_AMD64_SHA256,
  CI_DOCKER_COMPOSE_VERSION,
  PLATINUM_CI_BUN_VERSION,
  PLATINUM_CI_NODE_IMAGE,
  PLATINUM_CI_PNPM_VERSION,
  PLATINUM_CI_TEMPLATE_VERSION,
  PLATINUM_CI_WARM_TIMEOUT_MS,
  PlatinumHttpError,
  buildPlatinumTemplateSpec,
  buildPlatinumWorkerRequest,
  buildPlatinumWarmTemplateRequest,
  buildWorkerScript,
  cleanupPlatinumCiSandboxes,
  dockerComposeInstallCommand,
  selectOutstandingPlatinumSandboxIds,
  isRetryablePlatinumError,
  observePlatinumSandboxStart,
  observePlatinumWorker,
  platinumBaseTemplateName,
  platinumWorkerLaunchCommand,
  retryPlatinumOperation,
  selectReusablePlatinumTemplate,
  platinumTemplateName,
  platinumWarmReadinessTimeoutMs,
  validatePlatinumCiInput,
} from "../src/core/platinum-ci";

const sha = "a".repeat(40);
const lockHash = "b".repeat(64);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Platinum CI worker plan", () => {
  test("bounds warm restore readiness so auto mode can fail over quickly", () => {
    expect(PLATINUM_CI_WARM_TIMEOUT_MS).toBe(120_000);
    expect(platinumWarmReadinessTimeoutMs("restore")).toBe(120_000);
    expect(platinumWarmReadinessTimeoutMs("cold-boot")).toBe(2_700_000);
    expect(platinumWarmReadinessTimeoutMs(undefined)).toBe(120_000);
  });

  test("uses one content-addressed template for one lockfile", () => {
    expect(PLATINUM_CI_TEMPLATE_VERSION).toBe("v14");
    expect(platinumTemplateName(lockHash)).toBe(
      "kortix-ci-v14-bbbbbbbbbbbbbbbb",
    );
    expect(platinumBaseTemplateName(lockHash)).toBe(
      "kortix-ci-v11-bbbbbbbbbbbbbbbb-base",
    );
    const spec = buildPlatinumTemplateSpec({
      lockHash,
      repository: "kortix-ai/suna",
      cacheSha: sha,
    });

    expect(spec.name).toBe(platinumBaseTemplateName(lockHash));
    expect(spec.base_image).toBe(PLATINUM_CI_NODE_IMAGE);
    expect(spec.default_cpu).toBe(8);
    expect(spec.default_ram_mb).toBe(16_384);
    expect(spec.default_disk_gb).toBe(50);
    expect(spec.steps[0]).toEqual({
      op: "kernel_modules",
      profile: "container",
    });
    expect(JSON.stringify(spec.steps)).toContain(
      `bun@${PLATINUM_CI_BUN_VERSION}`,
    );
    expect(JSON.stringify(spec.steps)).toContain(
      `pnpm@${PLATINUM_CI_PNPM_VERSION}`,
    );
    expect(JSON.stringify(spec.steps)).toContain("docker-compose-linux-x86_64");
    expect(JSON.stringify(spec.steps)).toContain(
      CI_DOCKER_COMPOSE_AMD64_SHA256,
    );
    expect(JSON.stringify(spec.steps)).not.toContain("postgresql-client");
    expect(JSON.stringify(spec.steps)).toContain(
      `fetch --depth=1 origin ${sha}`,
    );
    expect(JSON.stringify(spec.steps)).toContain(
      "playwright install --with-deps chromium",
    );
    expect(JSON.stringify(spec.steps)).toContain("git init /workspace/suna");
    expect(spec.entrypoint).toContain(
      "timeout 2400 sh -c 'until pnpm exec supabase start --ignore-health-check; do sleep 30; done'",
    );
    expect(spec.entrypoint).not.toContain("docker pull postgres:16-alpine");
    expect(spec.entrypoint).toContain("supabase stop --no-backup");
    expect(spec.entrypoint).toContain(".kortix-ci-warm-ready");
    expect(spec.entrypoint).not.toMatch(/\$[A-Za-z_({!]/);
    expect(spec.entrypoint).toContain("modprobe overlay");
    expect(spec.entrypoint).toContain(
      "dockerd --host=unix:///var/run/docker.sock >/workspace/kortix-template-dockerd.log 2>&1 &",
    );
    expect(buildPlatinumWarmTemplateRequest(lockHash)).toEqual({
      name: platinumTemplateName(lockHash),
      capture_condition: {
        cmd: "test -s /workspace/.kortix-ci-warm-ready && ! pgrep -x dockerd >/dev/null && test ! -S /var/run/docker.sock",
        timeoutSec: 2_700,
      },
      default_cpu: 8,
      default_ram_mb: 16_384,
      default_disk_gb: 50,
    });
    for (const step of spec.steps) {
      if (step.op === "run") expect(step.cmd).not.toContain("\n");
    }
  });

  test("installs a pinned Docker Compose plugin in every base template", () => {
    const command = dockerComposeInstallCommand();
    expect(CI_DOCKER_COMPOSE_VERSION).toBe("v2.40.3");
    expect(CI_DOCKER_COMPOSE_AMD64_SHA256).toHaveLength(64);
    expect(command).toContain(
      `/download/${CI_DOCKER_COMPOSE_VERSION}/docker-compose-linux-x86_64`,
    );
    expect(command).toContain(CI_DOCKER_COMPOSE_AMD64_SHA256);
    expect(command).toContain("sha256sum -c -");
    expect(command).toContain("docker compose version");
  });

  test("post cleanup selects only the exact CI run sandbox", () => {
    expect(
      selectOutstandingPlatinumSandboxIds(
        [
          {
            id: "exact",
            name: "kortix-ci-31289428402-1",
            metadata: { owner: "kortix-ci", run_id: "31289428402" },
          },
          {
            id: "other-attempt",
            name: "kortix-ci-31289428402-2",
            metadata: { owner: "kortix-ci", run_id: "31289428402" },
          },
          {
            id: "not-ci-owned",
            name: "kortix-ci-31289428402-1",
            metadata: { owner: "customer", run_id: "31289428402" },
          },
        ],
        "31289428402",
        "1",
      ),
    ).toEqual(["exact"]);
  });

  test("uses Platinum persistent restore but still treats every worker as disposable", () => {
    expect(
      buildPlatinumWorkerRequest({
        templateId: "tpl_warm",
        repository: "kortix-ai/suna",
        sha,
        runId: "31295265205",
        runAttempt: "4",
      }),
    ).toEqual({
      name: "kortix-ci-31295265205-4",
      template: "tpl_warm",
      type: "persistent",
      auto_stop_minutes: 15,
      auto_archive_days: 1,
      auto_delete_days: 1,
      cpu: 8,
      ram_mb: 16_384,
      disk_gb: 50,
      metadata: {
        owner: "kortix-ci",
        repository: "kortix-ai/suna",
        git_sha: sha,
        run_id: "31295265205",
      },
    });
  });

  test("post cleanup reads paginated sandbox rows before deleting the exact worker", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/v1/sandboxes?paginated=true&limit=100&offset=0")) {
          return Response.json({
            rows: [{ id: "other", name: "customer", metadata: {} }],
            total: 2,
            has_more: true,
          });
        }
        if (url.endsWith("/v1/sandboxes?paginated=true&limit=100&offset=100")) {
          return Response.json({
            rows: [
              {
                id: "exact",
                name: "kortix-ci-31289428402-1",
                metadata: { owner: "kortix-ci", run_id: "31289428402" },
              },
            ],
            total: 2,
            has_more: false,
          });
        }
        if (url.endsWith("/v1/sandboxes/exact") && init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        return Response.json({ error: "unexpected request" }, { status: 500 });
      },
    );

    await expect(
      cleanupPlatinumCiSandboxes({
        apiUrl: "https://api.platinum.dev",
        apiKey: "test",
        runId: "31289428402",
        runAttempt: "1",
      }),
    ).resolves.toBe(1);
    expect(requests).toEqual([
      "GET https://api.platinum.dev/v1/sandboxes?paginated=true&limit=100&offset=0",
      "GET https://api.platinum.dev/v1/sandboxes?paginated=true&limit=100&offset=100",
      "DELETE https://api.platinum.dev/v1/sandboxes/exact",
    ]);
  });

  test("checks out the requested ref and rejects any SHA mismatch", () => {
    const script = buildWorkerScript({
      repository: "kortix-ai/suna",
      ref: "refs/pull/6260/head",
      sha,
      testArgs: ["--full"],
    });

    expect(script).toContain("'pnpm' 'test' '--' '--full'");
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("fetch --depth=1 origin 'refs/pull/6260/head'");
    expect(script).toContain("pnpm install --offline --frozen-lockfile");
    expect(script).toContain("export HOME=/root");
    expect(script).toContain("export CI=1");
    expect(script.indexOf("export HOME=/root")).toBeLessThan(
      script.indexOf("pnpm install --offline --frozen-lockfile"),
    );
    expect(script).not.toContain('rm -rf "$ROOT"');
    expect(script).toContain(`if [[ "$actual_sha" != '${sha}' ]]`);
    expect(script).not.toContain("nohup pnpm dev");
    expect(script).toContain('if ! modprobe "$module"; then');
    expect(script).toContain(
      "module_unavailable=$module; docker readiness will decide",
    );
    expect(script).toContain("container_modules_checked=1");
    expect(script).toContain("docker_pid=$!");
    expect(script).toContain('kill -0 "$docker_pid" >/dev/null 2>&1 || break');
    expect(script).toContain("exit 73");
    expect(script).toContain("seq 1 180");
    expect(script).toContain("docker_bridge_ready=1");
    expect(script).not.toContain("supabase_bridge_ready=1");
    expect(script).toContain(
      'tar -C "$ROOT" -czf "$ARTIFACT" tests/test-results',
    );
    expect(script).toContain("tests/test-results/platinum");
    expect(script).not.toContain("--storage-driver=fuse-overlayfs");
  });

  test("uses the captured overlay store with a vfs fallback on Daytona workers", () => {
    const script = buildWorkerScript({
      repository: "kortix-ai/suna",
      ref: sha,
      sha,
      testArgs: [],
      provider: "daytona",
    });

    expect(script).toContain("start_daytona_docker warm-overlay");
    expect(script).toContain(
      "--data-root=/workspace/daytona-vfs --storage-driver=vfs",
    );
    expect(script).toContain("start_daytona_docker vfs-fallback");
    expect(script).not.toContain("--storage-driver=fuse-overlayfs");
  });

  test("prestarts only the disposable browser database and leaves product processes to the root runner", () => {
    const script = buildWorkerScript({
      repository: "kortix-ai/suna",
      ref: sha,
      sha,
      testArgs: ["--browser-only"],
    });

    expect(script).toContain("pnpm exec supabase start --ignore-health-check");
    expect(script).toContain("supabase_prestarted=1");
    expect(script).toContain("'pnpm' 'test' '--' '--browser-only'");
    expect(script).not.toContain("nohup pnpm dev");

    const coreScript = buildWorkerScript({
      repository: "kortix-ai/suna",
      ref: sha,
      sha,
      testArgs: [],
    });
    expect(coreScript).not.toContain("supabase_prestarted=1");
  });

  test("propagates the full-run SDK de-duplication flag into the package worker", () => {
    const fullPackageScript = buildWorkerScript({
      repository: "kortix-ai/suna",
      ref: sha,
      sha,
      testArgs: ["--packages-only"],
      skipSdkPackageTests: true,
    });
    expect(fullPackageScript).toContain(
      "export KORTIX_PACKAGE_SKIP_SDK_TESTS=1",
    );

    const standalonePackageScript = buildWorkerScript({
      repository: "kortix-ai/suna",
      ref: sha,
      sha,
      testArgs: ["--packages-only"],
    });
    expect(standalonePackageScript).not.toContain(
      "export KORTIX_PACKAGE_SKIP_SDK_TESTS=1",
    );
  });

  test("detaches the worker with the Platinum-supported setsid contract", () => {
    const command = platinumWorkerLaunchCommand();
    expect(command).toContain("setsid -f /workspace/run-kortix-tests.sh");
    expect(command).toContain("</dev/null");
    expect(command).not.toContain("nohup");
    expect(command).not.toMatch(/&\s*$/);
  });

  test("reuses the exact ready or building content-addressed template", () => {
    expect(
      selectReusablePlatinumTemplate(
        [
          { id: "failed", name: "kortix-ci-v2-other", state: "failed" },
          { id: "ready", name: "kortix-ci-v2-target", state: "ready" },
        ],
        "kortix-ci-v2-target",
      )?.id,
    ).toBe("ready");
    expect(
      selectReusablePlatinumTemplate(
        [{ id: "failed", name: "kortix-ci-v2-target", state: "failed" }],
        "kortix-ci-v2-target",
      ),
    ).toBeNull();
  });

  test("retries only transient provider failures with bounded attempts", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await retryPlatinumOperation({
      label: "test",
      attempts: 4,
      sleep: async (delay) => {
        delays.push(delay);
      },
      operation: async () => {
        calls += 1;
        if (calls < 3) throw new PlatinumHttpError("gateway timeout", 504);
        return "ok";
      },
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([1_000, 2_000]);
    expect(
      isRetryablePlatinumError(new PlatinumHttpError("bad request", 400)),
    ).toBe(false);
    expect(
      isRetryablePlatinumError(new PlatinumHttpError("gateway timeout", 504)),
    ).toBe(true);
    expect(
      isRetryablePlatinumError(new SyntaxError("truncated JSON response")),
    ).toBe(true);
    expect(
      isRetryablePlatinumError(
        new PlatinumHttpError(
          '500: {"error":"The operation was aborted."}',
          500,
        ),
      ),
    ).toBe(true);
    expect(
      isRetryablePlatinumError(new PlatinumHttpError("internal bug", 500)),
    ).toBe(false);
  });

  test("polls worker completion independently from optional log streaming", async () => {
    let now = 0;
    let statusChecks = 0;
    let logChecks = 0;
    const output: string[] = [];
    const warnings: string[] = [];
    const result = await observePlatinumWorker({
      startedAt: 0,
      timeoutMs: 100,
      pollMs: 1,
      now: () => now,
      sleep: async (delay) => {
        now += delay;
      },
      checkExitCode: async () => {
        statusChecks += 1;
        return statusChecks === 3 ? 0 : null;
      },
      statLog: async () => {
        logChecks += 1;
        if (logChecks < 3) {
          throw new PlatinumHttpError(
            '500: {"error":"The operation was aborted."}',
            500,
          );
        }
        return { size: 4 };
      },
      readLog: async () => new TextEncoder().encode("done"),
      write: (chunk) => {
        output.push(chunk);
      },
      warn: (message) => {
        warnings.push(message);
      },
    });

    expect(result).toBe(0);
    expect(statusChecks).toBe(3);
    expect(logChecks).toBe(3);
    expect(output.join("")).toBe("done");
    expect(warnings).toContainEqual(
      expect.stringContaining("incremental log unavailable"),
    );
    expect(warnings).toContainEqual(
      expect.stringContaining("incremental log streaming recovered"),
    );
  });

  test("polls a provisioned worker until Platinum reports it running", async () => {
    let now = 0;
    let checks = 0;
    const states: string[] = [];
    const sandbox = await observePlatinumSandboxStart({
      sandbox: { id: "worker", state: "provisioning" },
      startedAt: 0,
      timeoutMs: 100,
      pollMs: 10,
      now: () => now,
      sleep: async (delay) => {
        now += delay;
      },
      readSandbox: async () => {
        checks += 1;
        return checks === 1
          ? { id: "worker", state: "starting" }
          : { id: "worker", state: "running", via: "restore" };
      },
      write: (state) => {
        states.push(state);
      },
    });

    expect(sandbox).toMatchObject({
      id: "worker",
      state: "running",
      via: "restore",
    });
    expect(checks).toBe(2);
    expect(states).toEqual(["provisioning", "starting", "running"]);
  });

  test("allows 45 minutes for a capacity-blocked Platinum worker to start", async () => {
    await expect(
      observePlatinumSandboxStart({
        sandbox: { id: "worker", state: "provisioning" },
        startedAt: 0,
        now: () => 2_700_001,
        sleep: async () => {},
        readSandbox: async () => ({ id: "worker", state: "running" }),
      }),
    ).rejects.toThrow("within 2700000ms");
  });

  test("fails immediately when Platinum deletes a provisioning worker", async () => {
    let now = 0;
    await expect(
      observePlatinumSandboxStart({
        sandbox: { id: "worker", state: "provisioning" },
        startedAt: 0,
        timeoutMs: 100,
        pollMs: 10,
        now: () => now,
        sleep: async (delay) => {
          now += delay;
        },
        readSandbox: async () => {
          throw new PlatinumHttpError("sandbox not found", 404);
        },
      }),
    ).rejects.toThrow("sandbox not found");
    expect(now).toBe(10);
  });

  test("rejects values that could alter the Git fetch command", () => {
    expect(() =>
      validatePlatinumCiInput({
        apiUrl: "https://api.platinum.dev",
        apiKey: "test",
        repository: "kortix-ai/suna",
        sha,
        ref: "main; curl attacker",
        runId: "1",
        runAttempt: "1",
        testArgs: [],
        root: "/tmp/suna",
      }),
    ).toThrow(/invalid Git ref/);
  });
});
