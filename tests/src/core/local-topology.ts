import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalWorktreeConfig } from "./local-profile";

interface WorktreeMarker extends LocalWorktreeConfig {
  path: string;
  branch: string;
  dbMode?: "shared" | "isolated";
}

interface RegistrySlot {
  path: string;
}

export interface LocalTopology {
  root: string;
  marker: WorktreeMarker | null;
  worktreeName: string | null;
  apiUrl: string;
}

function localPort(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`invalid local ${label} port: ${String(value)}`);
  }
  return value;
}

export function assertLoopbackHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid ${label} URL: ${value}`);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(hostname) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(`${label} URL must use unauthenticated loopback HTTP`);
  }
  return url;
}

export function localEndpoint(baseUrl: string, label: string, suffix: string): URL {
  const url = assertLoopbackHttpUrl(baseUrl, label);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${suffix}`;
  url.search = "";
  url.hash = "";
  return url;
}

export function localTopology(
  root: string,
  marker: WorktreeMarker | null,
  slots: Record<string, RegistrySlot> = {},
): LocalTopology {
  const worktreeName =
    Object.entries(slots).find(([, entry]) => entry.path === root)?.[0] ?? null;
  const apiPort = localPort(marker?.ports.api ?? 8008, "API");
  if (marker) {
    localPort(marker.ports.web, "web");
    localPort(marker.ports.gateway, "gateway");
  }
  return {
    root,
    marker,
    worktreeName,
    apiUrl: `http://127.0.0.1:${apiPort}/v1`,
  };
}

export function resolveLocalTopology(root: string): LocalTopology {
  const markerPath = join(root, ".kortix-worktree.json");
  const marker = existsSync(markerPath)
    ? (JSON.parse(readFileSync(markerPath, "utf8")) as WorktreeMarker)
    : null;
  const registryPath = join(
    process.env.KORTIX_HOME || join(homedir(), ".kortix"),
    "worktrees",
    "registry.json",
  );
  const slots = existsSync(registryPath)
    ? ((
        JSON.parse(readFileSync(registryPath, "utf8")) as {
          slots?: Record<string, RegistrySlot>;
        }
      ).slots ?? {})
    : {};
  return localTopology(root, marker, slots);
}
