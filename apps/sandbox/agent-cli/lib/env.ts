import { CliError } from './cli';

export function getEnv(key: string): string | undefined {
  const v = process.env[key];
  return v && v.length > 0 ? v : undefined;
}

export function requireEnv(key: string): string {
  const v = getEnv(key);
  if (!v) {
    throw new CliError(
      `${key} not set. Connect this platform in the Kortix dashboard so the token is provisioned to the sandbox.`,
      'MISSING_ENV',
    );
  }
  return v;
}

export function kortixProjectId(): string | undefined {
  return getEnv('KORTIX_PROJECT_ID');
}

export function kortixSessionId(): string | undefined {
  return getEnv('KORTIX_SESSION_ID');
}

export function kortixWorkspace(): string {
  return getEnv('KORTIX_WORKSPACE') ?? '/workspace';
}
