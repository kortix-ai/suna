import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config';

export class WorkspaceAccess {
  private exclusive = false;
  private readers = 0;
  terminalActive: () => boolean = () => false;
  constructor(readonly pending: () => boolean = () => false) {}
  get locked(): boolean { return this.exclusive || this.pending(); }
  enter(exclusive: boolean): (() => void) | null {
    if (this.exclusive || (exclusive && this.readers > 0)) return null;
    if (exclusive) this.exclusive = true;
    else this.readers++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (exclusive) this.exclusive = false;
      else this.readers--;
    };
  }
}
const gates = new Map<string, WorkspaceAccess>();
export function workspaceAccess(cfg: Config): WorkspaceAccess | null {
  if (!cfg.environmentHistory || cfg.workload !== 'environment' || !cfg.projectId || !cfg.sessionId) return null;
  const key = JSON.stringify([cfg.workspace, cfg.projectId, cfg.sessionId, cfg.agentStateDir]);
  let gate = gates.get(key);
  if (!gate) {
    gate = new WorkspaceAccess(() => existsSync(path.join(cfg.agentStateDir || '/opt/kortix/environment-runtime', 'workspace-history', 'pending.json')));
    gates.set(key, gate);
  }
  return gate;
}
