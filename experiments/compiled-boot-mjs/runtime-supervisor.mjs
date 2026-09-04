import { spawn } from "node:child_process";
import { createServer, request as createRequest } from "node:http";
import { performance } from "node:perf_hooks";

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const elapsed = (startedAt) =>
  Math.round((performance.now() - startedAt) * 100) / 100;

async function stopProcess(child, timeoutMs = 1000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    closed.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await closed;
  }
}

async function waitForReadyMessage(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      finish(
        undefined,
        new Error(
          `candidate did not announce readiness in ${timeoutMs} ms: ${stderr}`,
        ),
      );
    }, timeoutMs);

    const finish = (value, error) => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve(value);
    };
    const onStdout = (chunk) => {
      stdout += chunk.toString("utf8");
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.event === "ready" && Number.isInteger(message.port)) {
            finish(message);
            return;
          }
        } catch {}
      }
    };
    const onStderr = (chunk) => {
      stderr += chunk.toString("utf8");
    };
    const onError = (error) => finish(undefined, error);
    const onClose = (code) =>
      finish(
        undefined,
        new Error(`candidate exited before ready (${code}): ${stderr}`),
      );

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function verifyCandidate(runtime, expectedVersion, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  let lastError = new Error("candidate health was not checked");

  while (performance.now() < deadline) {
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      throw new Error("candidate exited during health verification");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/health`, {
        signal: AbortSignal.timeout(Math.min(500, timeoutMs)),
      });
      const health = await response.json();
      if (!response.ok || health.status !== "ok") {
        throw new Error(
          `candidate health returned ${response.status}: ${JSON.stringify(health)}`,
        );
      }
      if (expectedVersion && health.version !== expectedVersion) {
        throw new Error(
          `candidate version is ${health.version}; expected ${expectedVersion}`,
        );
      }
      return health;
    } catch (error) {
      lastError = error;
      await delay(20);
    }
  }

  throw lastError;
}

function runtimeSnapshot(runtime) {
  if (!runtime) return null;
  return {
    artifactPath: runtime.artifactPath,
    port: runtime.port,
    pid: runtime.child.pid,
    inFlight: runtime.inFlight,
    version: runtime.health.version,
    stopped:
      runtime.child.exitCode !== null || runtime.child.signalCode !== null,
  };
}

export class RuntimeSupervisor {
  #active = null;
  #proxy = null;
  #proxyPort = null;
  #retiring = new Set();
  #updatePromise = null;

  constructor(options = {}) {
    this.nodeBinary =
      options.nodeBinary ?? process.env.DEMO_NODE_BINARY ?? "node";
    this.readyTimeoutMs = options.readyTimeoutMs ?? 5000;
    this.verifyTimeoutMs = options.verifyTimeoutMs ?? 5000;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 5000;
  }

  get url() {
    if (!this.#proxyPort) throw new Error("runtime supervisor is not started");
    return `http://127.0.0.1:${this.#proxyPort}`;
  }

  snapshot() {
    return {
      active: runtimeSnapshot(this.#active),
      retiring: [...this.#retiring].map(runtimeSnapshot),
      updateInProgress: this.#updatePromise !== null,
    };
  }

  async start(artifactPath, options = {}) {
    if (this.#active) throw new Error("runtime supervisor is already started");
    const candidate = await this.#startCandidate(
      artifactPath,
      options.expectedVersion,
      options.env,
    );
    this.#active = candidate;
    this.#proxy = createServer((request, response) =>
      this.#forward(request, response),
    );
    try {
      await new Promise((resolve, reject) => {
        this.#proxy.once("error", reject);
        this.#proxy.listen(0, "127.0.0.1", resolve);
      });
    } catch (error) {
      this.#active = null;
      await stopProcess(candidate.child);
      throw error;
    }
    const address = this.#proxy.address();
    if (!address || typeof address === "string") {
      throw new Error("proxy did not bind a TCP port");
    }
    this.#proxyPort = address.port;
    return { url: this.url, active: runtimeSnapshot(candidate) };
  }

  async update(buildArtifact, options = {}) {
    if (!this.#active) throw new Error("runtime supervisor is not started");
    if (this.#updatePromise) {
      throw new Error("runtime update is already in progress");
    }
    const updatePromise = this.#performUpdate(buildArtifact, options);
    this.#updatePromise = updatePromise;
    try {
      return await updatePromise;
    } finally {
      this.#updatePromise = null;
    }
  }

  async close() {
    if (this.#updatePromise) await this.#updatePromise.catch(() => {});
    if (this.#proxy) {
      const proxy = this.#proxy;
      const closed = new Promise((resolve) => proxy.close(resolve));
      proxy.closeIdleConnections();
      proxy.closeAllConnections();
      await Promise.race([closed, delay(1000)]);
      this.#proxy = null;
      this.#proxyPort = null;
    }
    const runtimes = new Set([this.#active, ...this.#retiring]);
    this.#active = null;
    this.#retiring.clear();
    await Promise.all(
      [...runtimes]
        .filter(Boolean)
        .map((runtime) => stopProcess(runtime.child)),
    );
  }

  async #performUpdate(buildArtifact, options) {
    const incumbent = this.#active;
    const buildStartedAt = performance.now();
    let artifactPath;

    try {
      artifactPath = await buildArtifact();
    } catch (error) {
      return {
        promoted: false,
        stage: "build",
        reason: error instanceof Error ? error.message : String(error),
        active: runtimeSnapshot(this.#active),
      };
    }

    const buildMs = elapsed(buildStartedAt);
    let candidate;
    try {
      candidate = await this.#startCandidate(
        artifactPath,
        options.expectedVersion,
        options.env,
      );
    } catch (error) {
      return {
        promoted: false,
        stage: "verify",
        reason: error instanceof Error ? error.message : String(error),
        buildMs,
        active: runtimeSnapshot(this.#active),
      };
    }

    if (this.#active !== incumbent) {
      await stopProcess(candidate.child);
      return {
        promoted: false,
        stage: "promote",
        reason: "active runtime changed while candidate was building",
        buildMs,
        active: runtimeSnapshot(this.#active),
      };
    }

    if (
      candidate.child.exitCode !== null ||
      candidate.child.signalCode !== null
    ) {
      return {
        promoted: false,
        stage: "promote",
        reason: "verified candidate exited before promotion",
        buildMs,
        active: runtimeSnapshot(this.#active),
      };
    }

    this.#active = candidate;
    this.#retiring.add(incumbent);
    const drained = await this.#waitForDrain(incumbent);
    await stopProcess(incumbent.child);
    this.#retiring.delete(incumbent);

    return {
      promoted: true,
      buildMs,
      drained,
      active: runtimeSnapshot(candidate),
      retired: runtimeSnapshot(incumbent),
    };
  }

  async #startCandidate(artifactPath, expectedVersion, env = {}) {
    const child = spawn(this.nodeBinary, [artifactPath], {
      env: { ...process.env, ...env, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const ready = await waitForReadyMessage(child, this.readyTimeoutMs);
      const runtime = {
        artifactPath,
        child,
        port: ready.port,
        health: null,
        inFlight: 0,
        drained: new Set(),
      };
      runtime.health = await verifyCandidate(
        runtime,
        expectedVersion,
        this.verifyTimeoutMs,
      );
      child.stdout.resume();
      child.stderr.resume();
      return runtime;
    } catch (error) {
      await stopProcess(child);
      throw error;
    }
  }

  #forward(request, response) {
    const runtime = this.#active;
    if (!runtime) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "runtime_unavailable" }));
      return;
    }

    runtime.inFlight += 1;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      runtime.inFlight -= 1;
      if (runtime.inFlight === 0) {
        for (const resolve of runtime.drained) resolve();
        runtime.drained.clear();
      }
    };
    const upstream = createRequest(
      {
        hostname: "127.0.0.1",
        port: runtime.port,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
        upstreamResponse.once("end", finish);
        upstreamResponse.once("error", finish);
      },
    );
    upstream.once("error", (error) => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
      }
      if (!response.writableEnded) {
        response.end(JSON.stringify({ error: error.message }));
      }
      finish();
    });
    response.once("close", () => {
      upstream.destroy();
      finish();
    });
    request.pipe(upstream);
  }

  async #waitForDrain(runtime) {
    if (runtime.inFlight === 0) return true;
    return Promise.race([
      new Promise((resolve) => runtime.drained.add(() => resolve(true))),
      delay(this.drainTimeoutMs).then(() => false),
    ]);
  }
}
