/**
 * E2E tests for the Agent Tunnel CLI (src/client/cli.ts).
 *
 * Strategy: spin up a lightweight mock HTTP server that simulates the
 * tunnel relay API, then invoke the CLI as a child process via `bun run`
 * with TUNNEL_API_URL pointing at the mock. Assert on JSON stdout,
 * stderr, and exit codes.
 *
 * Run: bun test src/client/cli.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "child_process";
import { resolve, dirname } from "path";
import { tmpdir } from "os";
import { existsSync, unlinkSync } from "fs";

// ── Mock tunnel server ────────────────────────────────────────────────────

const TUNNEL_ID = "test-tunnel-001";

/** Builds JSON-RPC–style responses for each method. */
function mockRpcResponse(
  method: string,
  params: Record<string, unknown>
): unknown {
  switch (method) {
    case "fs.read":
      return {
        content: `mock content of ${params.path}`,
        size: 28,
        path: params.path,
      };
    case "fs.write":
      return { path: params.path, size: (params.content as string).length };
    case "fs.list":
      return {
        entries: [
          {
            name: "file.txt",
            path: `${params.path}/file.txt`,
            isDirectory: false,
            isFile: true,
          },
          {
            name: "subdir",
            path: `${params.path}/subdir`,
            isDirectory: true,
            isFile: false,
          },
        ],
        count: 2,
      };
    case "shell.exec":
      return {
        exitCode: 0,
        signal: null,
        stdout: `ran ${params.command} ${((params.args as string[]) || []).join(" ")}`,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    case "desktop.screenshot":
      // 1x1 red PNG as base64
      return {
        image:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
        width: 1,
        height: 1,
        format: "png",
      };
    case "desktop.mouse.click":
      return { ok: true };
    case "desktop.mouse.move":
      return { ok: true };
    case "desktop.mouse.drag":
      return { ok: true };
    case "desktop.mouse.scroll":
      return { ok: true };
    case "desktop.keyboard.type":
      return { ok: true };
    case "desktop.keyboard.key":
      return { ok: true };
    case "desktop.window.list":
      return {
        windows: [
          {
            id: 42,
            app: "Finder",
            title: "Desktop",
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
            minimized: false,
          },
        ],
      };
    case "desktop.window.focus":
      return { ok: true };
    case "desktop.app.launch":
      return { ok: true };
    case "desktop.app.quit":
      return { ok: true };
    case "desktop.clipboard.read":
      return { text: "clipboard mock content" };
    case "desktop.clipboard.write":
      return { ok: true };
    case "desktop.screen.info":
      return { width: 1920, height: 1080, scaleFactor: 2 };
    case "desktop.cursor.image":
      return {
        image:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
        width: 100,
        height: 100,
        format: "png",
      };
    case "desktop.ax.tree":
      return {
        root: {
          id: "0",
          role: "AXApplication",
          title: "TestApp",
          value: "",
          description: "",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          children: [
            {
              id: "0.0",
              role: "AXButton",
              title: "OK",
              value: "",
              description: "",
              bounds: { x: 100, y: 100, width: 80, height: 30 },
              children: [],
              actions: ["AXPress"],
              enabled: true,
              focused: false,
            },
          ],
          actions: [],
          enabled: true,
          focused: false,
        },
        elementCount: 2,
      };
    case "desktop.ax.action":
      return {
        ok: true,
        action: params.action,
        elementId: params.elementId,
        before: { focused: false, value: "" },
        after: { focused: true, value: "" },
        stateChanged: true,
        role: "AXButton",
        title: "OK",
      };
    case "desktop.ax.set_value":
      return {
        ok: true,
        elementId: params.elementId,
        requestedValue: params.value,
        actualValue: params.value,
      };
    case "desktop.ax.focus":
      return {
        ok: true,
        elementId: params.elementId,
        role: "AXTextField",
        title: "Search",
        before: { focused: false },
        after: { focused: true },
      };
    case "desktop.ax.search":
      return {
        elements: [
          {
            id: "0.1",
            role: "AXButton",
            title: params.query as string,
            value: "",
            description: "",
            bounds: { x: 200, y: 200, width: 60, height: 30 },
            children: [],
            actions: ["AXPress"],
            enabled: true,
            focused: false,
          },
        ],
      };
    default:
      return { error: `Unknown method: ${method}` };
  }
}

let mockServer: ReturnType<typeof Bun.serve>;
let mockPort = 0;

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0, // random available port
    async fetch(req) {
      const url = new URL(req.url);

      // GET /v1/tunnel/connections — list connections
      if (
        url.pathname === "/v1/tunnel/connections" &&
        req.method === "GET"
      ) {
        return Response.json([
          {
            tunnelId: TUNNEL_ID,
            name: "Test Tunnel",
            isLive: true,
            capabilities: ["filesystem", "shell", "desktop"],
            machineInfo: {
              hostname: "test-machine",
              platform: "darwin",
              arch: "arm64",
            },
          },
        ]);
      }

      // POST /v1/tunnel/rpc/:tunnelId — RPC call
      const rpcMatch = url.pathname.match(
        /^\/v1\/tunnel\/rpc\/(.+)$/
      );
      if (rpcMatch && req.method === "POST") {
        const body = (await req.json()) as {
          method: string;
          params: Record<string, unknown>;
        };
        const result = mockRpcResponse(body.method, body.params || {});
        return Response.json({ result });
      }

      return new Response("Not Found", { status: 404 });
    },
  });
  mockPort = mockServer.port!;
});

afterAll(() => {
  mockServer?.stop(true);
});

// ── Test helpers ──────────────────────────────────────────────────────────

const CLI_PATH = resolve(dirname(import.meta.dir), "client/cli.ts");

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  json: Record<string, unknown> | null;
}

function runCli(
  command: string,
  argsJson?: string,
  envOverrides?: Record<string, string>
): Promise<CliResult> {
  return new Promise((resolve) => {
    const cliArgs = ["run", CLI_PATH];
    if (command) cliArgs.push(command);
    if (argsJson) cliArgs.push(argsJson);

    const child = spawn("bun", cliArgs, {
      env: {
        ...process.env,
        TUNNEL_API_URL: `http://localhost:${mockPort}`,
        TUNNEL_TOKEN: "test-token",
        TUNNEL_ID: "",
        ...envOverrides,
      },
      cwd: dirname(dirname(CLI_PATH)),
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    child.on("close", (code: number | null) => {
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(stdout.trim());
      } catch {}
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
        json,
      });
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("Agent Tunnel CLI", () => {
  // ── Dispatch & error handling ──

  test("no command shows usage and exits 1", async () => {
    const r = await runCli("");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Usage:");
    expect(r.stderr).toContain("Available:");
  });

  test("unknown command shows error and exits 1", async () => {
    const r = await runCli("nonexistent");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Unknown command: nonexistent");
    expect(r.stderr).toContain("Available:");
  });

  test("invalid JSON arg exits 1 with error", async () => {
    const r = await runCli("fs_read", "{invalid json}");
    expect(r.exitCode).toBe(1);
  });

  // ── status ──

  test("status returns connections list", async () => {
    const r = await runCli("status");
    expect(r.exitCode).toBe(0);
    expect(r.json).not.toBeNull();
    expect(r.json!.success).toBe(true);
    expect(Array.isArray(r.json!.connections)).toBe(true);
    const conns = r.json!.connections as Array<Record<string, unknown>>;
    expect(conns.length).toBe(1);
    expect(conns[0].tunnelId).toBe(TUNNEL_ID);
    expect(conns[0].status).toBe("ONLINE");
    expect(r.json!.hasOnline).toBe(true);
  });

  // ── Filesystem ──

  test("fs_read returns file content", async () => {
    const r = await runCli("fs_read", '{"path":"/tmp/test.txt"}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.path).toBe("/tmp/test.txt");
    expect(r.json!.content).toContain("mock content");
    expect(typeof r.json!.size).toBe("number");
  });

  test("fs_write returns path and size", async () => {
    const r = await runCli(
      "fs_write",
      '{"path":"/tmp/out.txt","content":"hello world"}'
    );
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.path).toBe("/tmp/out.txt");
    expect(r.json!.size).toBe(11);
  });

  test("fs_list returns entries", async () => {
    const r = await runCli("fs_list", '{"path":"/tmp"}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.count).toBe(2);
    const entries = r.json!.entries as Array<Record<string, unknown>>;
    expect(entries.length).toBe(2);
    expect(entries[0].name).toBe("file.txt");
    expect(entries[0].isFile).toBe(true);
    expect(entries[1].name).toBe("subdir");
    expect(entries[1].isDirectory).toBe(true);
  });

  // ── Shell ──

  test("shell returns command output", async () => {
    const r = await runCli(
      "shell",
      '{"command":"echo","args":["hello","world"]}'
    );
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.exitCode).toBe(0);
    expect(r.json!.stdout).toContain("echo hello world");
    expect(r.json!.stderr).toBe("");
  });

  // ── Screenshot ──

  test("screenshot saves image and returns path", async () => {
    const r = await runCli("screenshot");
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.width).toBe(1);
    expect(r.json!.height).toBe(1);
    expect(r.json!.format).toBe("png");
    expect(typeof r.json!.path).toBe("string");
    const imgPath = r.json!.path as string;
    expect(imgPath).toContain("tunnel-screenshots");
    expect(imgPath).toEndWith(".png");
    // Verify the file was actually written
    expect(existsSync(imgPath)).toBe(true);
    // Clean up
    try {
      unlinkSync(imgPath);
    } catch {}
  });

  test("screenshot with region params", async () => {
    const r = await runCli(
      "screenshot",
      '{"x":0,"y":0,"width":800,"height":600}'
    );
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
  });

  // ── Mouse ──

  test("click returns success", async () => {
    const r = await runCli("click", '{"x":100,"y":200}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.x).toBe(100);
    expect(r.json!.y).toBe(200);
    expect(r.json!.button).toBe("left");
  });

  test("click with button and modifiers", async () => {
    const r = await runCli(
      "click",
      '{"x":50,"y":50,"button":"right","clicks":2,"modifiers":["cmd"]}'
    );
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.button).toBe("right");
    expect(r.json!.clicks).toBe(2);
  });

  test("mouse_move returns success", async () => {
    const r = await runCli("mouse_move", '{"x":500,"y":300}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.x).toBe(500);
    expect(r.json!.y).toBe(300);
  });

  test("mouse_drag returns success", async () => {
    const r = await runCli(
      "mouse_drag",
      '{"fromX":0,"fromY":0,"toX":100,"toY":100}'
    );
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.fromX).toBe(0);
    expect(r.json!.toX).toBe(100);
  });

  test("mouse_scroll returns success", async () => {
    const r = await runCli(
      "mouse_scroll",
      '{"x":500,"y":500,"deltaY":3}'
    );
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.deltaY).toBe(3);
  });

  // ── Keyboard ──

  test("type returns char count", async () => {
    const r = await runCli("type", '{"text":"hello world"}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.chars).toBe(11);
  });

  test("key returns pressed keys", async () => {
    const r = await runCli("key", '{"keys":["cmd","s"]}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    const keys = r.json!.keys as string[];
    expect(keys).toEqual(["cmd", "s"]);
  });

  // ── Windows ──

  test("window_list returns windows", async () => {
    const r = await runCli("window_list");
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    const windows = r.json!.windows as Array<Record<string, unknown>>;
    expect(windows.length).toBe(1);
    expect(windows[0].id).toBe(42);
    expect(windows[0].app).toBe("Finder");
  });

  test("window_focus returns success", async () => {
    const r = await runCli("window_focus", '{"windowId":42}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.windowId).toBe(42);
  });

  // ── Apps ──

  test("app_launch returns success", async () => {
    const r = await runCli("app_launch", '{"app":"Safari"}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.app).toBe("Safari");
  });

  test("app_quit returns success", async () => {
    const r = await runCli("app_quit", '{"app":"Safari"}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.app).toBe("Safari");
  });

  // ── Clipboard ──

  test("clipboard_read returns text", async () => {
    const r = await runCli("clipboard_read");
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.text).toBe("clipboard mock content");
  });

  test("clipboard_write returns char count", async () => {
    const r = await runCli("clipboard_write", '{"text":"test copy"}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.chars).toBe(9);
  });

  // ── Screen ──

  test("screen_info returns dimensions", async () => {
    const r = await runCli("screen_info");
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.width).toBe(1920);
    expect(r.json!.height).toBe(1080);
    expect(r.json!.scaleFactor).toBe(2);
  });

  test("cursor_image saves image", async () => {
    const r = await runCli("cursor_image", '{"radius":50}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.width).toBe(100);
    expect(r.json!.height).toBe(100);
    const imgPath = r.json!.path as string;
    expect(existsSync(imgPath)).toBe(true);
    try {
      unlinkSync(imgPath);
    } catch {}
  });

  // ── Accessibility ──

  test("ax_tree returns formatted tree", async () => {
    const r = await runCli("ax_tree");
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.elementCount).toBe(2);
    expect(typeof r.json!.tree).toBe("string");
    const tree = r.json!.tree as string;
    expect(tree).toContain("[AXApplication]");
    expect(tree).toContain("[AXButton] OK");
  });

  test("ax_tree with pid filter", async () => {
    const r = await runCli("ax_tree", '{"pid":1234,"maxDepth":4}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
  });

  test("ax_action returns state change", async () => {
    const r = await runCli(
      "ax_action",
      '{"elementId":"0.0","action":"AXPress"}'
    );
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.action).toBe("AXPress");
    expect(r.json!.elementId).toBe("0.0");
    expect(r.json!.stateChanged).toBe(true);
    expect(r.json!.role).toBe("AXButton");
  });

  test("ax_set_value returns verified value", async () => {
    const r = await runCli(
      "ax_set_value",
      '{"elementId":"0.1","value":"search text"}'
    );
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.requestedValue).toBe("search text");
    expect(r.json!.actualValue).toBe("search text");
  });

  test("ax_focus returns focus state", async () => {
    const r = await runCli("ax_focus", '{"elementId":"0.1"}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.role).toBe("AXTextField");
    expect((r.json!.after as Record<string, unknown>).focused).toBe(true);
  });

  test("ax_search returns matching elements", async () => {
    const r = await runCli("ax_search", '{"query":"Submit"}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.count).toBe(1);
    const elements = r.json!.elements as Array<Record<string, unknown>>;
    expect(elements[0].role).toBe("AXButton");
    expect(elements[0].title).toBe("Submit");
  });

  test("ax_search with role filter", async () => {
    const r = await runCli(
      "ax_search",
      '{"query":"Submit","role":"button","maxResults":5}'
    );
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
  });

  // ── Permission flow ──

  describe("permission handling", () => {
    let permServer: ReturnType<typeof Bun.serve>;
    let permPort = 0;

    beforeAll(() => {
      permServer = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);

          if (url.pathname === "/v1/tunnel/connections") {
            return Response.json([
              { tunnelId: "perm-tunnel", isLive: true },
            ]);
          }

          // Always return 403 with requestId for RPC calls
          if (url.pathname.startsWith("/v1/tunnel/rpc/")) {
            return Response.json(
              {
                code: -32003,
                error: "Permission denied",
                requestId: "req-abc-123",
              },
              { status: 403 }
            );
          }

          return new Response("Not Found", { status: 404 });
        },
      });
      permPort = permServer.port!;
    });

    afterAll(() => {
      permServer?.stop(true);
    });

    test("permission denied returns structured response", async () => {
      const r = await runCli("fs_read", '{"path":"/etc/passwd"}', {
        TUNNEL_API_URL: `http://localhost:${permPort}`,
      });
      // CLI should output permission-required JSON (not crash)
      expect(r.json).not.toBeNull();
      expect(r.json!.success).toBe(false);
      expect(r.json!.permissionRequired).toBe(true);
      expect(r.json!.requestId).toBe("req-abc-123");
      expect(typeof r.json!.message).toBe("string");
    });

    test("shell permission denied returns structured response", async () => {
      const r = await runCli(
        "shell",
        '{"command":"rm","args":["-rf","/"]}',
        { TUNNEL_API_URL: `http://localhost:${permPort}` }
      );
      expect(r.json!.success).toBe(false);
      expect(r.json!.permissionRequired).toBe(true);
    });
  });

  // ── Error handling: server down ──

  describe("server unreachable", () => {
    test("status with dead server returns error JSON", async () => {
      const r = await runCli("status", undefined, {
        TUNNEL_API_URL: "http://localhost:1",
      });
      expect(r.exitCode).toBe(1);
      expect(r.json).not.toBeNull();
      expect(r.json!.success).toBe(false);
      expect(typeof r.json!.error).toBe("string");
    });

    test("fs_read with dead server returns error JSON", async () => {
      const r = await runCli("fs_read", '{"path":"/tmp/x"}', {
        TUNNEL_API_URL: "http://localhost:1",
      });
      expect(r.exitCode).toBe(1);
      expect(r.json!.success).toBe(false);
    });
  });

  // ── Empty connections ──

  describe("no connections", () => {
    let emptyServer: ReturnType<typeof Bun.serve>;
    let emptyPort = 0;

    beforeAll(() => {
      emptyServer = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/v1/tunnel/connections") {
            return Response.json([]);
          }
          return new Response("Not Found", { status: 404 });
        },
      });
      emptyPort = emptyServer.port!;
    });

    afterAll(() => {
      emptyServer?.stop(true);
    });

    test("status with no connections returns empty list", async () => {
      const r = await runCli("status", undefined, {
        TUNNEL_API_URL: `http://localhost:${emptyPort}`,
      });
      expect(r.exitCode).toBe(0);
      expect(r.json!.success).toBe(true);
      expect((r.json!.connections as unknown[]).length).toBe(0);
      expect(typeof r.json!.message).toBe("string");
    });

    test("fs_read with no connections returns error", async () => {
      const r = await runCli("fs_read", '{"path":"/tmp/x"}', {
        TUNNEL_API_URL: `http://localhost:${emptyPort}`,
      });
      expect(r.exitCode).toBe(1);
      expect(r.json!.success).toBe(false);
      expect(r.json!.error).toContain("No tunnel connection found");
    });
  });
});
