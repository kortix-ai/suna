import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';

const composeProject = process.env.E2E_COMPOSE_PROJECT_NAME || 'kortix';
const sandboxContainer = process.env.E2E_SANDBOX_CONTAINER_NAME || 'kortix-sandbox';

function serviceContainer(service: string): string {
  return `${composeProject}-${service}-1`;
}

function containerRunning(name: string): boolean {
  try {
    const out = execSync(`docker ps --format '{{.Names}}' --filter name=${name}`, {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return out.trim().includes(name);
  } catch {
    return false;
  }
}

test.describe('01 — Docker containers are running', () => {
  test('frontend container is up', () => {
    expect(containerRunning(serviceContainer('frontend'))).toBe(true);
  });

  test('API container is up', () => {
    expect(containerRunning(serviceContainer('kortix-api'))).toBe(true);
  });

  test('Supabase Auth container is up', () => {
    expect(containerRunning(serviceContainer('supabase-auth'))).toBe(true);
  });

  test('Supabase Kong container is up', () => {
    expect(containerRunning(serviceContainer('supabase-kong'))).toBe(true);
  });

  test('Supabase DB container is up', () => {
    expect(containerRunning(serviceContainer('supabase-db'))).toBe(true);
  });

  test('Sandbox container is up', () => {
    expect(containerRunning(sandboxContainer)).toBe(true);
  });
});
