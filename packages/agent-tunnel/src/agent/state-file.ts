import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';

import type { TunnelAgentStatus } from './agent';
import { agentTunnelHome } from './service-paths';
import { agentTunnelVersion } from './version';

/**
 * `<home>/state.json`: the running agent's connection status, for local
 * observers such as the desktop tray. It holds no credential.
 */
export interface AgentStateFile {
  tunnelId: string;
  apiUrl: string;
  status: TunnelAgentStatus;
  /** ISO time of the last status change. */
  since: string;
  agentVersion: string;
  pid: number;
}

export function stateFilePath(home: string = agentTunnelHome()): string {
  return join(home, 'state.json');
}

/** Atomic and private. A status write never stops the agent. */
export function writeAgentState(
  status: TunnelAgentStatus,
  tunnel: { tunnelId: string; apiUrl: string },
  home: string = agentTunnelHome(),
): void {
  const state: AgentStateFile = {
    tunnelId: tunnel.tunnelId,
    apiUrl: tunnel.apiUrl,
    status,
    since: new Date().toISOString(),
    agentVersion: agentTunnelVersion(),
    pid: process.pid,
  };
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const tmp = join(home, `state.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch {}
    renameSync(tmp, stateFilePath(home));
  } catch {
    // Observers fall back to "unknown"; the tunnel itself is unaffected.
  }
}

export function readAgentState(home: string = agentTunnelHome()): AgentStateFile | null {
  try {
    const parsed = JSON.parse(readFileSync(stateFilePath(home), 'utf8')) as AgentStateFile;
    return parsed && typeof parsed === 'object' && typeof parsed.status === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
