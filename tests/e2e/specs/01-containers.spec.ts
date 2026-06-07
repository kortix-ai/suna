import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';

function containerRunning(name: string): boolean {
  try {
    const out = execFileSync('docker', ['ps', '--format', '{{.Names}}', '--filter', `name=${name}`], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return out.trim().includes(name);
  } catch {
    return false;
  }
}

const composeProjectName = process.env.E2E_COMPOSE_PROJECT_NAME;

function composeContainer(serviceName: string, legacyName: string): string {
  return composeProjectName ? `${composeProjectName}-${serviceName}-1` : legacyName;
}

test.describe('01 — Docker containers are running', () => {
  test('frontend container is up', () => {
    expect(containerRunning(composeContainer('frontend', 'kortix-frontend'))).toBe(true);
  });

  test('API container is up', () => {
    expect(containerRunning(composeContainer('kortix-api', 'kortix-kortix-api'))).toBe(true);
  });

  test('Supabase Auth container is up', () => {
    expect(containerRunning(composeContainer('supabase-auth', 'kortix-supabase-auth'))).toBe(true);
  });

  test('Supabase Kong container is up', () => {
    expect(containerRunning(composeContainer('supabase-kong', 'kortix-supabase-kong'))).toBe(true);
  });

  test('Supabase DB container is up', () => {
    expect(containerRunning(composeContainer('supabase-db', 'kortix-supabase-db'))).toBe(true);
  });

  test('Sandbox container is up', () => {
    expect(containerRunning(process.env.E2E_SANDBOX_CONTAINER_NAME || 'kortix-sandbox')).toBe(true);
  });
});
