import { describe, expect, it } from 'vitest';
import {
  PREVIEW_RUNTIME_SECRET_ALLOWLIST,
  applyPreviewEnvironment,
  buildPreviewCaddyfile,
  buildPreviewComposeOverlay,
  validatePreviewRuntimeSecrets,
} from '../src/core/preview-stack';

const SHA = 'a'.repeat(40);

describe('ephemeral self-host preview stack', () => {
  it('routes every public surface through one origin', () => {
    const caddy = buildPreviewCaddyfile('preview.example.test');
    expect(caddy).toContain(':8080');
    expect(caddy).toContain('@api path /v1*');
    expect(caddy).toContain('reverse_proxy kortix-api:8008');
    expect(caddy).toContain('@supabase path /auth/v1* /rest/v1* /storage/v1*');
    expect(caddy).toContain('reverse_proxy supabase-kong:8000');
    expect(caddy).toContain('handle_path /_gateway/*');
    expect(caddy).toContain('reverse_proxy llm-gateway:8090');
    expect(caddy).toContain('handle_path /_tests/*');
    expect(caddy).toContain('root * /reports');
    expect(caddy).toContain('handle_path /_mailpit/*');
    expect(caddy).toContain('reverse_proxy mailpit:8025');
    expect(caddy).toContain('reverse_proxy frontend:3000');
  });

  it('adds preview ingress, Mailpit, direct database access, and preview-only Auth capacity', () => {
    const overlay = buildPreviewComposeOverlay('/workspace/suna/tests/test-results');
    expect(overlay).toContain('preview-edge:');
    expect(overlay).toContain('mailpit:');
    expect(overlay).toContain('127.0.0.1:15432:5432');
    expect(overlay).toContain('/workspace/suna/tests/test-results:/reports:ro');
    expect(overlay).toContain('GOTRUE_RATE_LIMIT_TOKEN_REFRESH: "10000"');
    expect(overlay).toContain('GOTRUE_RATE_LIMIT_EMAIL_SENT: "10000"');
    expect(overlay).not.toContain('volumes/db/data');
  });

  it('rejects every runtime secret outside the explicit allowlist', () => {
    expect(PREVIEW_RUNTIME_SECRET_ALLOWLIST).toEqual([
      'DAYTONA_API_KEY',
      'KE2E_STRIPE_SECRET_KEY',
      'KE2E_STRIPE_WEBHOOK_SECRET',
      'KORTIX_GITHUB_APP_ID',
      'KORTIX_GITHUB_APP_PRIVATE_KEY',
      'KORTIX_GITHUB_APP_SLUG',
      'MANAGED_GIT_GITHUB_INSTALL_ID',
      'MANAGED_GIT_GITHUB_OWNER',
      'OPENROUTER_API_KEY',
    ]);
    expect(() =>
      validatePreviewRuntimeSecrets({
        DAYTONA_API_KEY: 'allowed',
        DEV_DATABASE_URL: 'forbidden',
      }),
    ).toThrow('DEV_DATABASE_URL');
  });

  it('pins exact images and configures the preview data plane', () => {
    const configured = applyPreviewEnvironment(
      'POSTGRES_PASSWORD=generated\nSUPABASE_ANON_KEY=anon\nSUPABASE_SERVICE_ROLE_KEY=service\nINTERNAL_SERVICE_KEY=internal\n',
      {
        origin: 'https://preview.example',
        sha: SHA,
        apiImage: `kortix/kortix-api:pr-${SHA}`,
        gatewayImage: `kortix/kortix-gateway:pr-${SHA}`,
        frontendImage: `kortix/kortix-frontend:pr-${SHA}`,
      },
      {
        DAYTONA_API_KEY: 'daytona',
        KE2E_STRIPE_SECRET_KEY: 'stripe',
        KE2E_STRIPE_WEBHOOK_SECRET: 'webhook',
        KORTIX_GITHUB_APP_ID: '12345',
        KORTIX_GITHUB_APP_PRIVATE_KEY: 'line-one\nline-two',
        KORTIX_GITHUB_APP_SLUG: 'kortix-preview-test',
        MANAGED_GIT_GITHUB_INSTALL_ID: '67890',
        MANAGED_GIT_GITHUB_OWNER: 'kortix-preview',
        OPENROUTER_API_KEY: 'openrouter',
      },
    );

    expect(configured.runtimeEnv).toContain(`API_IMAGE=kortix/kortix-api:pr-${SHA}`);
    expect(configured.runtimeEnv).toContain('DATABASE_URL=postgresql://postgres:generated@supabase-db:5432/postgres');
    expect(configured.runtimeEnv).toContain('SUPABASE_PUBLIC_URL=https://preview.example');
    expect(configured.runtimeEnv).toContain('INTERNAL_KORTIX_ENV=preview');
    expect(configured.runtimeEnv).toContain('EMAIL_PROVIDER_ORDER=mailpit');
    expect(configured.runtimeEnv).toContain('MANAGED_GIT_PROVIDER=github');
    expect(configured.runtimeEnv).toContain('KORTIX_GITHUB_APP_PRIVATE_KEY=line-one\\nline-two');
    expect(configured.runtimeEnv).not.toContain('E2E_AGENTMAIL_API_KEY');
    expect(configured.testEnv).toContain('KE2E_TARGET=preview');
    expect(configured.testEnv).toContain(`KE2E_PREVIEW_AUTHORIZATION=approved:${SHA}`);
    expect(configured.testEnv).toContain('E2E_MAILPIT_URL=https://preview.example/_mailpit');
    expect(configured.testEnv).toContain('KE2E_DATABASE_URL=postgresql://postgres:generated@127.0.0.1:15432/postgres');
    expect(configured.testEnv).toContain('KE2E_CAP_MANAGED_GIT_PUSH=1');
    expect(configured.testEnv).toContain('E2E_AGENTMAIL_API_KEY=');
  });

  it('fails before boot when managed GitHub cannot run every target flow', () => {
    expect(() =>
      applyPreviewEnvironment(
        'POSTGRES_PASSWORD=generated\nSUPABASE_ANON_KEY=anon\nSUPABASE_SERVICE_ROLE_KEY=service\nINTERNAL_SERVICE_KEY=internal\n',
        {
          origin: 'https://preview.example',
          sha: SHA,
          apiImage: 'api',
          gatewayImage: 'gateway',
          frontendImage: 'frontend',
        },
        {},
      ),
    ).toThrow('complete managed GitHub App configuration');
  });

  // 2026-08-27: every Server Action on the preview 500'd with `Invalid Server
  // Actions request` — surfaced in the browser as minified React error #441 —
  // because the sandbox ingress sets `x-forwarded-host` to the INTERNAL host
  // (`*.aec.local`) while the browser's `origin` is the public one, and Next's
  // CSRF guard compares the two. The whole auth flow was unusable.
  it('pins the PUBLIC host on the Next upstream for Server Actions', () => {
    const caddy = buildPreviewCaddyfile('8080-abc.eu-west.sbx.platinum.dev');
    expect(caddy).toContain('X-Forwarded-Host 8080-abc.eu-west.sbx.platinum.dev');
    expect(caddy).toContain('X-Forwarded-Proto https');
    const frontendBlock = caddy.slice(caddy.indexOf('reverse_proxy frontend:3000'));
    expect(frontendBlock).toContain('X-Forwarded-Host');
  });
});
