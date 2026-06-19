#!/usr/bin/env bun
/**
 * Agent Tunnel CLI — self-contained script for the agent-tunnel skill.
 *
 * Zero external dependencies — TunnelClient is inlined so this works
 * standalone in the sandbox without @kortix/agent-tunnel in node_modules.
 *
 * Usage: bun run tunnel.ts <command> [args as JSON]
 *
 * Commands:
 *   status                                          — list all tunnel connections
 *   fs_read   '{"path":"/Users/me/file.txt"}'       — read a file
 *   fs_write  '{"path":"/tmp/out.txt","content":"hello"}' — write a file
 *   fs_list   '{"path":"/Users/me"}'                — list directory
 *   shell     '{"command":"git","args":["status"]}'  — run a command
 *   screenshot                                       — take a screenshot
 *   click     '{"x":100,"y":200}'                    — click at coordinates
 *   mouse_move '{"x":100,"y":200}'                   — move mouse
 *   mouse_drag '{"fromX":0,"fromY":0,"toX":100,"toY":100}' — drag
 *   mouse_scroll '{"x":500,"y":500,"deltaY":3}'     — scroll
 *   type      '{"text":"hello world"}'               — type text
 *   key       '{"keys":["cmd","s"]}'                 — press key combo
 *   window_list                                      — list windows
 *   window_focus '{"windowId":123}'                  — focus a window
 *   app_launch '{"app":"Safari"}'                    — launch app
 *   app_quit  '{"app":"Safari"}'                     — quit app
 *   clipboard_read                                   — read clipboard
 *   clipboard_write '{"text":"copied"}'              — write clipboard
 *   screen_info                                      — get screen resolution
 *   cursor_image                                     — screenshot around cursor
 *   ax_tree   '{"pid":1234}'                         — accessibility tree
 *   ax_action '{"elementId":"0.3.1","action":"AXPress"}' — perform AX action
 *   ax_set_value '{"elementId":"0.3.1","value":"hello"}' — set element value
 *   ax_focus  '{"elementId":"0.3.1"}'                — focus element
 *   ax_search '{"query":"Submit"}'                   — search AX tree
 */

import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

// ── Env resolution (s6 → process.env) ─────────────────────────────────────

const S6_ENV_DIR = process.env.S6_ENV_DIR || "/run/s6/container_environment";

function getEnv(key: string): string | undefined {
  try {
    const val = readFileSync(`${S6_ENV_DIR}/${key}`, "utf-8").trim();
    if (val) return val;
  } catch {}
  return process.env[key];
}

// ── Inlined TunnelClient (no external deps) ───────────────────────────────

interface AXElement {
  id: string;
  role: string;
  title: string;
  value: string;
  description: string;
  bounds: { x: number; y: number; width: number; height: number };
  children: AXElement[];
  actions: string[];
  enabled: boolean;
  focused: boolean;
}

class TunnelClientError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly requestId?: string,
    public readonly isPermissionRequest = false
  ) {
    super(message);
    this.name = "TunnelClientError";
  }
}

class TunnelClient {
  private apiUrl: string;
  private token: string;
  private explicitTunnelId: string | undefined;
  private cachedTunnelId: string | null = null;
  private cacheTimestamp = 0;
  private cacheTtlMs: number;

  constructor(config: {
    apiUrl: string;
    token: string;
    tunnelId?: string;
    cacheTtlMs?: number;
  }) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, "");
    this.token = config.token;
    this.explicitTunnelId = config.tunnelId;
    this.cacheTtlMs = config.cacheTtlMs ?? 10_000;
  }

  async rpc(
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    const tunnelId = await this.resolveTunnelId();
    const res = await fetch(`${this.apiUrl}/rpc/${tunnelId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ method, params }),
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      if (res.status === 404) this.cachedTunnelId = null;
      throw new TunnelClientError(
        (data.code as number) ?? -1,
        (data.error as string) ?? `HTTP ${res.status}`,
        data.requestId as string | undefined,
        res.status === 403 && !!data.requestId
      );
    }

    return data.result;
  }

  async getConnections(): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`${this.apiUrl}/connections`, {
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (!res.ok)
      throw new TunnelClientError(
        -1,
        `Failed to list connections: HTTP ${res.status}`
      );
    return (await res.json()) as Array<Record<string, unknown>>;
  }

  async resolveTunnelId(): Promise<string> {
    if (this.explicitTunnelId) return this.explicitTunnelId;
    if (
      this.cachedTunnelId &&
      Date.now() - this.cacheTimestamp < this.cacheTtlMs
    ) {
      return this.cachedTunnelId;
    }

    const res = await fetch(`${this.apiUrl}/connections`, {
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    });

    if (res.ok) {
      const connections = (await res.json()) as Array<{
        tunnelId: string;
        isLive?: boolean;
      }>;
      const online = connections.find((c) => c.isLive);
      if (online) {
        this.cachedTunnelId = online.tunnelId;
        this.cacheTimestamp = Date.now();
        return online.tunnelId;
      }
      if (connections.length > 0) {
        const first = connections[0];
        if (!first) {
          this.cachedTunnelId = null;
          throw new TunnelClientError(-1, "No tunnel connection found.");
        }
        this.cachedTunnelId = first.tunnelId;
        this.cacheTimestamp = Date.now();
        return first.tunnelId;
      }
    }

    this.cachedTunnelId = null;
    throw new TunnelClientError(
      -1,
      "No tunnel connection found. The user needs to set up Agent Tunnel first:\n" +
        "1. Create a tunnel connection in the UI\n" +
        '2. Run `npx @kortix/agent-tunnel connect` on their local machine'
    );
  }
}

// ── Client setup ──────────────────────────────────────────────────────────

const FALLBACK_API_URL = "http://localhost:8008";

function getApiBase(): string {
  const raw = getEnv("KORTIX_API_URL") || FALLBACK_API_URL;
  const url = raw.startsWith("http") ? raw : FALLBACK_API_URL;
  // Strip /v1/router suffix — KORTIX_API_URL sometimes includes the router path
  // but tunnel.ts appends its own /v1/tunnel path.
  return url.replace(/\/+$/, "").replace(/\/v1\/router\/?$/, "");
}

const client = new TunnelClient({
  apiUrl: `${getApiBase()}/v1/tunnel`,
  token: getEnv("KORTIX_TOKEN") || "",
  tunnelId: getEnv("KORTIX_TUNNEL_ID"),
});

// ── Helpers ───────────────────────────────────────────────────────────────

function out(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function saveImage(base64: string, format: string): string {
  const ext = format === "jpeg" || format === "jpg" ? "jpg" : "png";
  const dir = join(tmpdir(), "tunnel-screenshots");
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    `screenshot-${randomBytes(4).toString("hex")}.${ext}`
  );
  writeFileSync(path, Buffer.from(base64, "base64"));
  return path;
}

function formatAXTree(el: AXElement, indent = 0): string {
  const pad = "  ".repeat(indent);
  const parts: string[] = [];

  const label = el.title || el.value || el.description || "(unnamed)";
  const flags: string[] = [];
  if (!el.enabled) flags.push("disabled");
  if (el.focused) flags.push("focused");
  if (el.actions.length > 0) flags.push(`actions: ${el.actions.join(",")}`);
  const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";

  parts.push(`${pad}[${el.role}] ${label} (id: ${el.id})${flagStr}`);

  for (const child of el.children) {
    parts.push(formatAXTree(child, indent + 1));
  }

  return parts.join("\n");
}

async function rpcSafe(
  method: string,
  params: Record<string, unknown> = {}
): Promise<
  | { result: unknown; permissionRequired: false }
  | {
      result: null;
      permissionRequired: true;
      requestId: string;
      message: string;
    }
> {
  try {
    const result = await client.rpc(method, params);
    return { result, permissionRequired: false };
  } catch (err) {
    if (err instanceof TunnelClientError && err.isPermissionRequest) {
      return {
        result: null,
        permissionRequired: true,
        requestId: err.requestId || "unknown",
        message: `Permission required. A permission request (${err.requestId}) has been sent to the user for approval. The user needs to approve this request before you can access their local machine. Please inform the user and try again after they approve.`,
      };
    }
    throw err;
  }
}

async function call(
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown | null> {
  const r = await rpcSafe(method, params);
  if (r.permissionRequired) {
    out({
      success: false,
      permissionRequired: true,
      requestId: r.requestId,
      message: r.message,
    });
    return null;
  }
  return r.result;
}

// ── Commands ──────────────────────────────────────────────────────────────

async function status() {
  const connections = (await client.getConnections()) as Array<
    Record<string, unknown>
  >;

  if (connections.length === 0) {
    return out({
      success: true,
      connections: [],
      message:
        "No tunnel connections found. The user needs to set up Agent Tunnel first.",
    });
  }

  let hasOnline = false;
  const mapped = connections.map((data) => {
    if (data.isLive) hasOnline = true;
    return {
      name: data.name || "Unnamed",
      tunnelId: data.tunnelId,
      status: data.isLive ? "ONLINE" : "OFFLINE",
      capabilities: (data.capabilities as string[]) || [],
      machineInfo: data.machineInfo || {},
    };
  });

  out({
    success: true,
    connections: mapped,
    hasOnline,
    message: hasOnline
      ? undefined
      : "No tunnel is currently online. Ask the user to run `npx @kortix/agent-tunnel connect` on their local machine.",
  });
}

async function fsRead(args: Record<string, unknown>) {
  const result = await call("fs.read", {
    path: args.path,
    encoding: (args.encoding as string) || "utf-8",
  });
  if (result === null) return;
  const data = result as Record<string, unknown>;
  out({
    success: true,
    path: data.path || args.path,
    size: data.size,
    content: data.content,
  });
}

async function fsWrite(args: Record<string, unknown>) {
  const result = await call("fs.write", {
    path: args.path,
    content: args.content,
    encoding: (args.encoding as string) || "utf-8",
  });
  if (result === null) return;
  const data = result as Record<string, unknown>;
  out({ success: true, path: data.path, size: data.size });
}

async function fsList(args: Record<string, unknown>) {
  const result = await call("fs.list", {
    path: args.path,
    recursive: args.recursive || false,
  });
  if (result === null) return;
  const data = result as {
    entries: Array<{
      name: string;
      path: string;
      isDirectory: boolean;
      isFile: boolean;
    }>;
    count: number;
  };
  out({
    success: true,
    path: args.path,
    count: data.count,
    entries: data.entries,
  });
}

async function shell(args: Record<string, unknown>) {
  const result = await call("shell.exec", {
    command: args.command,
    args: (args.args as string[]) || [],
    cwd: args.cwd,
    timeout: args.timeout,
  });
  if (result === null) return;
  const data = result as {
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
  out({
    success: data.exitCode === 0,
    exitCode: data.exitCode,
    signal: data.signal,
    stdout: data.stdout,
    stderr: data.stderr,
    stdoutTruncated: data.stdoutTruncated,
    stderrTruncated: data.stderrTruncated,
  });
}

async function screenshot(args: Record<string, unknown>) {
  const params: Record<string, unknown> = {};
  if (
    args.x !== undefined &&
    args.y !== undefined &&
    args.width !== undefined &&
    args.height !== undefined
  ) {
    params.region = {
      x: args.x,
      y: args.y,
      width: args.width,
      height: args.height,
    };
  }
  if (args.windowId !== undefined) params.windowId = args.windowId;

  const result = await call("desktop.screenshot", params);
  if (result === null) return;
  const data = result as {
    image: string;
    width: number;
    height: number;
    format?: string;
  };
  const format = data.format || "png";
  const sizeKB = Math.round((data.image.length * 0.75) / 1024);
  const path = saveImage(data.image, format);
  out({
    success: true,
    path,
    width: data.width,
    height: data.height,
    format,
    sizeKB,
    message: `Screenshot saved: ${path} (${data.width}x${data.height} ${format.toUpperCase()}, ${sizeKB}KB). Use the Read tool to view.`,
  });
}

async function click(args: Record<string, unknown>) {
  const result = await call("desktop.mouse.click", {
    x: args.x,
    y: args.y,
    button: args.button,
    clicks: args.clicks,
    modifiers: args.modifiers,
  });
  if (result === null) return;
  out({
    success: true,
    x: args.x,
    y: args.y,
    button: args.button || "left",
    clicks: args.clicks || 1,
  });
}

async function mouseMove(args: Record<string, unknown>) {
  const result = await call("desktop.mouse.move", { x: args.x, y: args.y });
  if (result === null) return;
  out({ success: true, x: args.x, y: args.y });
}

async function mouseDrag(args: Record<string, unknown>) {
  const result = await call("desktop.mouse.drag", {
    fromX: args.fromX,
    fromY: args.fromY,
    toX: args.toX,
    toY: args.toY,
    button: args.button,
  });
  if (result === null) return;
  out({
    success: true,
    fromX: args.fromX,
    fromY: args.fromY,
    toX: args.toX,
    toY: args.toY,
  });
}

async function mouseScroll(args: Record<string, unknown>) {
  const result = await call("desktop.mouse.scroll", {
    x: args.x,
    y: args.y,
    deltaX: args.deltaX,
    deltaY: args.deltaY,
  });
  if (result === null) return;
  out({
    success: true,
    x: args.x,
    y: args.y,
    deltaX: args.deltaX || 0,
    deltaY: args.deltaY || 0,
  });
}

async function typeText(args: Record<string, unknown>) {
  const result = await call("desktop.keyboard.type", {
    text: args.text,
    delay: args.delay,
  });
  if (result === null) return;
  out({ success: true, chars: (args.text as string).length });
}

async function pressKey(args: Record<string, unknown>) {
  const result = await call("desktop.keyboard.key", { keys: args.keys });
  if (result === null) return;
  out({ success: true, keys: args.keys });
}

async function windowList() {
  const result = await call("desktop.window.list", {});
  if (result === null) return;
  const data = result as {
    windows: Array<{
      id: number;
      app: string;
      title: string;
      bounds: { x: number; y: number; width: number; height: number };
      minimized: boolean;
    }>;
  };
  out({ success: true, windows: data.windows });
}

async function windowFocus(args: Record<string, unknown>) {
  const result = await call("desktop.window.focus", {
    windowId: args.windowId,
  });
  if (result === null) return;
  out({ success: true, windowId: args.windowId });
}

async function appLaunch(args: Record<string, unknown>) {
  const result = await call("desktop.app.launch", { app: args.app });
  if (result === null) return;
  out({ success: true, app: args.app });
}

async function appQuit(args: Record<string, unknown>) {
  const result = await call("desktop.app.quit", { app: args.app });
  if (result === null) return;
  out({ success: true, app: args.app });
}

async function clipboardRead() {
  const result = await call("desktop.clipboard.read", {});
  if (result === null) return;
  const data = result as { text: string };
  out({ success: true, text: data.text || "" });
}

async function clipboardWrite(args: Record<string, unknown>) {
  const result = await call("desktop.clipboard.write", { text: args.text });
  if (result === null) return;
  out({ success: true, chars: (args.text as string).length });
}

async function screenInfo() {
  const result = await call("desktop.screen.info", {});
  if (result === null) return;
  const data = result as {
    width: number;
    height: number;
    scaleFactor: number;
  };
  out({ success: true, ...data });
}

async function cursorImage(args: Record<string, unknown>) {
  const result = await call("desktop.cursor.image", { radius: args.radius });
  if (result === null) return;
  const data = result as {
    image: string;
    width: number;
    height: number;
    format?: string;
  };
  const format = data.format || "png";
  const sizeKB = Math.round((data.image.length * 0.75) / 1024);
  const path = saveImage(data.image, format);
  out({
    success: true,
    path,
    width: data.width,
    height: data.height,
    format,
    sizeKB,
    message: `Cursor area saved: ${path} (${data.width}x${data.height}). Use the Read tool to view.`,
  });
}

async function axTree(args: Record<string, unknown>) {
  const params: Record<string, unknown> = {};
  if (args.pid !== undefined) params.pid = args.pid;
  if (args.maxDepth !== undefined) params.maxDepth = args.maxDepth;
  if (args.roles !== undefined) params.roles = args.roles;

  const result = await call("desktop.ax.tree", params);
  if (result === null) return;
  const data = result as { root: AXElement; elementCount: number };
  if (!data.root)
    return out({
      success: true,
      tree: null,
      message: "No accessibility tree available",
    });

  out({
    success: true,
    elementCount: data.elementCount,
    tree: formatAXTree(data.root),
  });
}

async function axAction(args: Record<string, unknown>) {
  const result = await call("desktop.ax.action", {
    elementId: args.elementId,
    action: args.action,
    pid: args.pid,
  });
  if (result === null) return;
  const data = result as {
    ok: boolean;
    action: string;
    elementId: string;
    before: { focused: boolean; value: string };
    after: { focused: boolean; value: string };
    stateChanged: boolean;
    role: string;
    title: string;
  };
  out({
    success: data.ok,
    action: data.action,
    elementId: data.elementId,
    role: data.role,
    title: data.title,
    stateChanged: data.stateChanged,
    before: data.before,
    after: data.after,
  });
}

async function axSetValue(args: Record<string, unknown>) {
  const result = await call("desktop.ax.set_value", {
    elementId: args.elementId,
    value: args.value,
    pid: args.pid,
  });
  if (result === null) return;
  const data = result as {
    ok: boolean;
    elementId: string;
    requestedValue: string;
    actualValue: string;
    error?: string;
  };
  out({
    success: data.ok,
    elementId: data.elementId,
    requestedValue: data.requestedValue,
    actualValue: data.actualValue,
    error: data.error,
  });
}

async function axFocus(args: Record<string, unknown>) {
  const result = await call("desktop.ax.focus", {
    elementId: args.elementId,
    pid: args.pid,
  });
  if (result === null) return;
  const data = result as {
    ok: boolean;
    elementId: string;
    role: string;
    title: string;
    before: { focused: boolean };
    after: { focused: boolean };
    error?: string;
  };
  out({
    success: data.ok,
    elementId: data.elementId,
    role: data.role,
    title: data.title,
    before: data.before,
    after: data.after,
    error: data.error,
  });
}

async function axSearch(args: Record<string, unknown>) {
  const params: Record<string, unknown> = { query: args.query };
  if (args.role !== undefined) params.role = args.role;
  if (args.pid !== undefined) params.pid = args.pid;
  if (args.maxResults !== undefined) params.maxResults = args.maxResults;

  const result = await call("desktop.ax.search", params);
  if (result === null) return;
  const data = result as { elements: AXElement[] };

  if (!data.elements || data.elements.length === 0) {
    return out({
      success: true,
      query: args.query,
      elements: [],
      message: `No elements found matching "${args.query}"`,
    });
  }

  const elements = data.elements.map((el) => ({
    id: el.id,
    role: el.role,
    title: el.title || el.value || el.description || "(unnamed)",
    bounds: el.bounds,
    enabled: el.enabled,
    focused: el.focused,
    actions: el.actions,
  }));

  out({ success: true, query: args.query, count: elements.length, elements });
}

// ── Dispatch ──────────────────────────────────────────────────────────────

const ALL_COMMANDS = [
  "status",
  "fs_read",
  "fs_write",
  "fs_list",
  "shell",
  "screenshot",
  "click",
  "mouse_move",
  "mouse_drag",
  "mouse_scroll",
  "type",
  "key",
  "window_list",
  "window_focus",
  "app_launch",
  "app_quit",
  "clipboard_read",
  "clipboard_write",
  "screen_info",
  "cursor_image",
  "ax_tree",
  "ax_action",
  "ax_set_value",
  "ax_focus",
  "ax_search",
];

const [cmd, rawArgs] = process.argv.slice(2);

if (!cmd) {
  console.error(
    `Usage: bun run tunnel.ts <command> [args as JSON]\n\nAvailable: ${ALL_COMMANDS.join(" | ")}`
  );
  process.exit(1);
}

const args = rawArgs ? JSON.parse(rawArgs) : {};

try {
  switch (cmd) {
    case "status":
      await status();
      break;
    case "fs_read":
      await fsRead(args);
      break;
    case "fs_write":
      await fsWrite(args);
      break;
    case "fs_list":
      await fsList(args);
      break;
    case "shell":
      await shell(args);
      break;
    case "screenshot":
      await screenshot(args);
      break;
    case "click":
      await click(args);
      break;
    case "mouse_move":
      await mouseMove(args);
      break;
    case "mouse_drag":
      await mouseDrag(args);
      break;
    case "mouse_scroll":
      await mouseScroll(args);
      break;
    case "type":
      await typeText(args);
      break;
    case "key":
      await pressKey(args);
      break;
    case "window_list":
      await windowList();
      break;
    case "window_focus":
      await windowFocus(args);
      break;
    case "app_launch":
      await appLaunch(args);
      break;
    case "app_quit":
      await appQuit(args);
      break;
    case "clipboard_read":
      await clipboardRead();
      break;
    case "clipboard_write":
      await clipboardWrite(args);
      break;
    case "screen_info":
      await screenInfo();
      break;
    case "cursor_image":
      await cursorImage(args);
      break;
    case "ax_tree":
      await axTree(args);
      break;
    case "ax_action":
      await axAction(args);
      break;
    case "ax_set_value":
      await axSetValue(args);
      break;
    case "ax_focus":
      await axFocus(args);
      break;
    case "ax_search":
      await axSearch(args);
      break;
    default:
      console.error(
        `Unknown command: ${cmd}\n\nAvailable: ${ALL_COMMANDS.join(" | ")}`
      );
      process.exit(1);
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  out({ success: false, error: message });
  process.exit(1);
}
