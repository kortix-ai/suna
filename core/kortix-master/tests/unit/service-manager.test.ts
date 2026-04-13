import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer } from "net";
import {
  ServiceManager,
  detectFramework,
  getFrameworkCommands,
  type RegisteredServiceSpec,
} from "../../src/services/service-manager";

const tempDirs: string[] = [];
const managers: ServiceManager[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createManager(storageDir: string) {
  const manager = new ServiceManager({
    registryFile: join(storageDir, "registry.json"),
    logsDir: join(storageDir, "logs"),
    builtins: [] as RegisteredServiceSpec[],
  });
  managers.push(manager);
  return manager;
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate test port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number = 10000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await Bun.sleep(200);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

afterAll(async () => {
  for (const manager of managers) {
    try {
      await manager.stop();
    } catch {}
  }
  await Bun.sleep(300);
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("ServiceManager — Framework Detection", () => {
  it("detects nextjs from package.json", () => {
    const dir = makeTempDir("service-manager-fw-");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
    );
    expect(detectFramework(dir)).toBe("nextjs");
  });

  it("detects vite from scoped vite plugin", () => {
    const dir = makeTempDir("service-manager-fw-");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ devDependencies: { "@vitejs/plugin-react": "4.0.0" } }),
    );
    expect(detectFramework(dir)).toBe("vite");
  });

  it("detects python from pyproject", () => {
    const dir = makeTempDir("service-manager-fw-");
    writeFileSync(join(dir, "pyproject.toml"), '[project]\nname="demo"\n');
    expect(detectFramework(dir)).toBe("python");
  });

  it("detects static from index.html", () => {
    const dir = makeTempDir("service-manager-fw-");
    writeFileSync(join(dir, "index.html"), "<html></html>");
    expect(detectFramework(dir)).toBe("static");
  });

  it("returns expected framework commands", () => {
    const dir = makeTempDir("service-manager-cmds-");
    mkdirSync(dir, { recursive: true });
    const vite = getFrameworkCommands("vite", dir);
    expect(vite.install).toBe("npm install");
    expect(vite.build).toBe("npm run build");
    expect(vite.start).toContain("vite preview");
  });
});

describe("ServiceManager — Managed project services", () => {
  it("deploys, lists, logs, and stops a simple Bun service", async () => {
    const storageDir = makeTempDir("service-manager-store-");
    const appDir = makeTempDir("service-manager-app-");
    writeFileSync(
      join(appDir, "server.js"),
      `
      Bun.serve({
        port: Number(process.env.PORT),
        fetch() {
          return new Response('service-manager-ok')
        },
      })
      console.log('ready:' + process.env.PORT)
    `,
    );

    const manager = createManager(storageDir);
    const deployId = `svc-${Date.now()}`;
    const result = await manager.deployLegacyService({
      deploymentId: deployId,
      sourceType: "files",
      sourcePath: appDir,
      framework: "node",
      entrypoint: "bun server.js",
    });

    expect(result.success).toBe(true);
    expect(result.port).toBeDefined();
    expect(result.pid).toBeDefined();

    const response = await fetch(`http://127.0.0.1:${result.port}`);
    expect(await response.text()).toBe("service-manager-ok");

    const services = await manager.listServices({
      includeSystem: true,
      includeStopped: true,
    });
    const service = services.find((entry) => entry.id === deployId);
    expect(service).toBeDefined();
    expect(service?.status).toBe("running");

    await Bun.sleep(200);
    const logs = await manager.getLogs(deployId);
    expect(logs.error).toBeUndefined();
    expect(logs.logs.length).toBeGreaterThan(0);

    const stopped = await manager.stopService(deployId);
    expect(stopped.ok).toBe(true);

    const status = await manager.getService(deployId);
    expect(status?.status).toBe("stopped");
  }, 30000);

  it("rehydrates persisted running services across manager restart", async () => {
    const storageDir = makeTempDir("service-manager-store-");
    const appDir = makeTempDir("service-manager-app-");
    writeFileSync(
      join(appDir, "server.js"),
      `
      Bun.serve({
        port: Number(process.env.PORT),
        fetch() {
          return new Response('persistent-ok')
        },
      })
      console.log('persistent:' + process.env.PORT)
    `,
    );

    const firstManager = createManager(storageDir);
    const serviceId = `persist-${Date.now()}`;
    const deployed = await firstManager.deployLegacyService({
      deploymentId: serviceId,
      sourceType: "files",
      sourcePath: appDir,
      framework: "node",
      entrypoint: "bun server.js",
    });

    expect(deployed.success).toBe(true);
    expect(deployed.port).toBeDefined();

    const secondManager = createManager(storageDir);
    await secondManager.start();

    const adopted = await secondManager.getService(serviceId);
    expect(adopted).toBeDefined();
    expect(adopted?.status).toBe("running");
    expect(adopted?.port).toBe(deployed.port);

    const response = await fetch(`http://127.0.0.1:${deployed.port}`);
    expect(await response.text()).toBe("persistent-ok");

    const stopped = await secondManager.stopService(serviceId);
    expect(stopped.ok).toBe(true);

    await Bun.sleep(400);
    let stoppedFetchFailed = false;
    try {
      await fetch(`http://127.0.0.1:${deployed.port}`, {
        signal: AbortSignal.timeout(1000),
      });
    } catch {
      stoppedFetchFailed = true;
    }
    expect(stoppedFetchFailed).toBe(true);
  }, 30000);

  it("reclaims the configured port and auto-heals the managed process", async () => {
    const storageDir = makeTempDir("service-manager-store-");
    const appDir = makeTempDir("service-manager-app-");
    const port = await findFreePort();

    writeFileSync(
      join(appDir, "server.js"),
      `
      Bun.serve({
        port: Number(process.env.PORT),
        fetch() {
          return new Response('autoheal-ok')
        },
      })
      console.log('autoheal:' + process.env.PORT)
    `,
    );

    const manager = createManager(storageDir);
    const serviceId = `autoheal-${Date.now()}`;
    await manager.registerService({
      id: serviceId,
      sourcePath: appDir,
      framework: "node",
      startCommand: "bun server.js",
      port,
      desiredState: "running",
      healthCheck: { type: "tcp", timeoutMs: 500 },
    });

    const externalProc = Bun.spawn(["/bin/sh", "-c", "bun server.js"], {
      cwd: appDir,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "0.0.0.0",
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}`, {
          signal: AbortSignal.timeout(500),
        });
        return (await res.text()) === "autoheal-ok";
      } catch {
        return false;
      }
    });

    await manager.start();

    await waitFor(async () => {
      const service = await manager.getService(serviceId);
      return (
        !!service?.pid &&
        service.pid !== externalProc.pid &&
        service.status === "running"
      );
    }, 15000);

    const owned = await manager.getService(serviceId);
    expect(owned?.status).toBe("running");
    expect(owned?.pid).toBeDefined();
    expect(owned?.pid).not.toBe(externalProc.pid);

    const stopped = await manager.stopService(serviceId, {
      persistDesiredState: false,
    });
    expect(stopped.ok).toBe(true);

    const recoveryTriggered = await manager.requestRecovery(
      serviceId,
      "unit-test",
    );
    expect(recoveryTriggered?.ok).toBe(true);

    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}`, {
          signal: AbortSignal.timeout(500),
        });
        return (await res.text()) === "autoheal-ok";
      } catch {
        return false;
      }
    }, 15000);

    const logs = await manager.getLogs(serviceId);
    expect(
      logs.logs.some(
        (line) =>
          line.includes("auto-heal triggered") ||
          line.includes("starting bun server.js"),
      ),
    ).toBe(true);
  }, 30000);

  it("does not watchdog-restart a spawn service while it is still booting", async () => {
    const storageDir = makeTempDir("service-manager-store-");
    const appDir = makeTempDir("service-manager-app-");
    const port = await findFreePort();

    writeFileSync(
      join(appDir, "server.js"),
      `
      Bun.serve({
        port: Number(process.env.PORT),
        fetch() {
          return new Response('startup-grace-ok')
        },
      })
      console.log('startup-grace:' + process.env.PORT)
    `,
    );

    const manager = createManager(storageDir);
    const serviceId = `startup-grace-${Date.now()}`;
    await manager.registerService({
      id: serviceId,
      sourcePath: appDir,
      framework: "node",
      startCommand: "bun server.js",
      port,
      desiredState: "running",
      healthCheck: { type: "tcp", timeoutMs: 500 },
    });

    await manager.start();

    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}`, {
          signal: AbortSignal.timeout(500),
        });
        return (await res.text()) === "startup-grace-ok";
      } catch {
        return false;
      }
    });

    const first = await manager.getService(serviceId);
    expect(first?.pid).toBeDefined();

    writeFileSync(
      join(appDir, "server.js"),
      `
      setTimeout(() => {
        Bun.serve({
          port: Number(process.env.PORT),
          fetch() {
            return new Response('startup-grace-restarted-ok')
          },
        })
        console.log('startup-grace-restarted:' + process.env.PORT)
      }, 8000)
    `,
    );

    process.kill(first!.pid!, "SIGKILL");

    await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}`, {
          signal: AbortSignal.timeout(500),
        });
        return (await res.text()) === "startup-grace-restarted-ok";
      } catch {
        return false;
      }
    }, 25000);

    const restarted = await manager.getService(serviceId);
    expect(restarted?.status).toBe("running");
    expect(restarted?.pid).toBeDefined();
    expect(restarted?.pid).not.toBe(first?.pid);

    const logs = await manager.getLogs(serviceId);
    const startCount = logs.logs.filter((line) =>
      line.includes("[manager] starting bun server.js"),
    ).length;
    expect(startCount).toBe(2);
    expect(
      logs.logs.some((line) => line.includes("auto-heal triggered (watchdog:")),
    ).toBe(false);
  }, 40000);

  it("does not auto-heal restart a spawn service while startupPromise is still pending after grace", async () => {
    const storageDir = makeTempDir("service-manager-store-");
    const appDir = makeTempDir("service-manager-app-");

    writeFileSync(join(appDir, "server.js"), "setInterval(() => {}, 1000)");

    const manager = createManager(storageDir);
    const serviceId = `late-startup-${Date.now()}`;
    await manager.registerService({
      id: serviceId,
      sourcePath: appDir,
      framework: "node",
      startCommand: "bun server.js",
      desiredState: "running",
      healthCheck: { type: "none", timeoutMs: 500 },
    });

    await manager.start();

    const item = (manager as any).services.get(serviceId);
    expect(item).toBeTruthy();
    const pending = new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 100));
    item.startupPromise = pending;
    item.state.status = "failed";
    item.state.startedAt = new Date(Date.now() - 31_000).toISOString();

    const result = await manager.requestRecovery(serviceId, "unit-test-late-start");
    expect(result).toBe(await pending);

    const logs = await manager.getLogs(serviceId);
    const startCount = logs.logs.filter((line) =>
      line.includes("[manager] starting bun server.js"),
    ).length;
    expect(startCount).toBe(1);
    expect(
      logs.logs.some((line) => line.includes("recovery joined active startup (unit-test-late-start)")),
    ).toBe(true);
  }, 15000);

  it("uses raw TCP probes for tcp health checks without sending HTTP to the port", async () => {
    const storageDir = makeTempDir("service-manager-store-");
    const port = await findFreePort();
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;

    const tcpServer = createServer((socket) => {
      socket.end();
    });

    await new Promise<void>((resolve, reject) => {
      tcpServer.listen(port, "127.0.0.1", () => resolve());
      tcpServer.once("error", reject);
    });

    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      return originalFetch(...args);
    }) as typeof fetch;

    const manager = createManager(storageDir);
    const serviceId = `tcp-probe-${Date.now()}`;

    await manager.registerService({
      id: serviceId,
      name: "TCP probe test",
      adapter: "s6",
      sourcePath: storageDir,
      startCommand: "true",
      s6ServiceName: "svc-tcp-probe-test",
      port,
      desiredState: "running",
      healthCheck: { type: "tcp", timeoutMs: 500 },
      processPatterns: [],
    });

    try {
      await manager.start();

      const service = await manager.getService(serviceId);
      expect(service?.status).toBe("running");
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
    }
  });

  it("does not open TCP probe connections when a port-bound s6 health check is disabled", async () => {
    const storageDir = makeTempDir("service-manager-store-");
    const port = await findFreePort();
    const netModule = require("net") as typeof import("net");
    const originalCreateConnection = netModule.createConnection.bind(
      netModule,
    ) as typeof netModule.createConnection;
    let connectionAttempts = 0;

    netModule.createConnection = ((
      ...args: Parameters<typeof netModule.createConnection>
    ) => {
      connectionAttempts += 1;
      return originalCreateConnection(...args);
    }) as typeof netModule.createConnection;

    const manager = new ServiceManager({
      registryFile: join(storageDir, "registry.json"),
      logsDir: join(storageDir, "logs"),
      builtins: [
        {
          id: "sshd-no-probe-test",
          name: "SSH no-probe test",
          adapter: "s6",
          scope: "bootstrap",
          description: "",
          builtin: true,
          userVisible: false,
          projectId: null,
          template: "sshd-no-probe-test",
          framework: null,
          sourcePath: null,
          sourceType: "files",
          sourceRef: null,
          startCommand: null,
          installCommand: null,
          buildCommand: null,
          envVarKeys: [],
          deps: [],
          port,
          desiredState: "running",
          autoStart: true,
          restartPolicy: "always",
          restartDelayMs: 2000,
          s6ServiceName: "svc-sshd-no-probe-test",
          processPatterns: [],
          healthCheck: { type: "none" },
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
    managers.push(manager);

    try {
      await manager.start();
      const service = await manager.getService("sshd-no-probe-test");
      expect(service?.status).toBe("stopped");
      expect(connectionAttempts).toBe(0);
    } finally {
      netModule.createConnection = originalCreateConnection;
    }
  });
});
