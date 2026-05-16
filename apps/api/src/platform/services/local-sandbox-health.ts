import { execSync } from 'child_process';
import { config } from '../../config';

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

function inspectImage(image: string): boolean {
  try {
    run(`docker image inspect ${shellQuote(image)}`);
    return true;
  } catch {
    return false;
  }
}

export function checkLocalSandboxHealth(): {
  docker: LocalSandboxHealthCheck;
  sandbox: LocalSandboxHealthCheck;
} {
  const checks = {
    docker: { ok: false } as LocalSandboxHealthCheck,
    sandbox: { ok: false } as LocalSandboxHealthCheck,
  };

  try {
    run('docker info');
    checks.docker = { ok: true };
  } catch {
    checks.docker = { ok: false, error: 'Docker not running' };
    checks.sandbox = { ok: false, error: 'Docker not running' };
    return checks;
  }

  const image = config.KORTIX_LOCAL_DOCKER_IMAGE || 'kortix/sandbox:dev';
  if (inspectImage(image)) {
    checks.sandbox = { ok: true };
    return checks;
  }

  checks.sandbox = {
    ok: false,
    error: `Sandbox image ${image} not found. Build it with: docker build -f apps/sandbox/Dockerfile -t ${image} .`,
  };
  return checks;
}
