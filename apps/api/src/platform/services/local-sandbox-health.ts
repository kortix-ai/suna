import { execSync } from 'child_process';
import { config } from '../../config';
import { JUSTAVPS_SERVICE_NAME } from '../../update/container-config';

export interface LocalSandboxHealthCheck {
  ok: boolean;
  error?: string;
  recovered?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function run(command: string, timeout = 5000): string {
  return execSync(command, { stdio: 'pipe', timeout }).toString().trim();
}

function getCandidateContainerNames(): string[] {
  return Array.from(new Set([config.SANDBOX_CONTAINER_NAME, 'justavps-workload'].filter(Boolean)));
}

function inspectContainerStatus(name: string): string | null {
  try {
    return run(`docker inspect ${shellQuote(name)} --format "{{.State.Status}}"`);
  } catch {
    return null;
  }
}

function hasManagedRecoveryService(): boolean {
  try {
    run(`systemctl cat ${JUSTAVPS_SERVICE_NAME}`, 3000);
    return true;
  } catch {
    return false;
  }
}

function recoverSandboxContainer(): { recovered: boolean; error?: string } {
  try {
    if (hasManagedRecoveryService()) {
      run(`systemctl restart ${JUSTAVPS_SERVICE_NAME}`, 15000);
      return { recovered: true };
    }

    for (const name of getCandidateContainerNames()) {
      const status = inspectContainerStatus(name);
      if (status && status !== 'running') {
        run(`docker start ${shellQuote(name)}`, 15000);
        return { recovered: true };
      }
    }

    return { recovered: false, error: 'Container not found' };
  } catch (error) {
    return {
      recovered: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function checkLocalSandboxHealth(): { docker: LocalSandboxHealthCheck; sandbox: LocalSandboxHealthCheck } {
  const checks: { docker: LocalSandboxHealthCheck; sandbox: LocalSandboxHealthCheck } = {
    docker: { ok: false },
    sandbox: { ok: false },
  };

  try {
    run('docker info');
    checks.docker = { ok: true };
  } catch {
    checks.docker = { ok: false, error: 'Docker not running' };
    checks.sandbox = { ok: false, error: 'Docker not running' };
    return checks;
  }

  let lastObserved = 'Container not found';
  for (const name of getCandidateContainerNames()) {
    const status = inspectContainerStatus(name);
    if (!status) continue;
    if (status === 'running') {
      checks.sandbox = { ok: true };
      return checks;
    }
    lastObserved = `Status: ${status}`;
  }

  const recovery = recoverSandboxContainer();
  if (recovery.recovered) {
    for (const name of getCandidateContainerNames()) {
      const status = inspectContainerStatus(name);
      if (status === 'running') {
        checks.sandbox = { ok: true, recovered: true };
        return checks;
      }
      if (status) lastObserved = `Status: ${status}`;
    }
    lastObserved = recovery.error || 'Recovery attempted but container is still not running';
  } else if (recovery.error) {
    lastObserved = recovery.error;
  }

  checks.sandbox = { ok: false, error: lastObserved };
  return checks;
}
