import { describe, expect, test } from 'bun:test';
import { posthogEnvironment } from './posthog-environment';

describe('posthogEnvironment', () => {
  test('separates the three Kortix deployments that share one PostHog project', () => {
    expect(posthogEnvironment('kortix.com')).toBe('prod');
    expect(posthogEnvironment('www.kortix.com')).toBe('prod');
    expect(posthogEnvironment('dev.kortix.com')).toBe('dev');
    expect(posthogEnvironment('staging.kortix.com')).toBe('staging');
  });

  test('local development and preview origins never look like production', () => {
    expect(posthogEnvironment('localhost')).toBe('local');
    expect(posthogEnvironment('127.0.0.1')).toBe('local');
    expect(posthogEnvironment('demo.localhost')).toBe('local');
    expect(posthogEnvironment('wine-pads-zum.trycloudflare.com')).toBe('preview');
    expect(posthogEnvironment('abc.sbx.platinum.dev')).toBe('preview');
    expect(posthogEnvironment('kortix-git-branch.vercel.app')).toBe('preview');
  });

  test('anything else is a self-hosted install', () => {
    expect(posthogEnvironment('kortix.essentia.com')).toBe('self-host');
    expect(posthogEnvironment('')).toBe('self-host');
    expect(posthogEnvironment(null)).toBe('self-host');
  });

  test('case and a trailing dot do not change the answer', () => {
    expect(posthogEnvironment('KORTIX.COM')).toBe('prod');
    expect(posthogEnvironment('dev.kortix.com.')).toBe('dev');
  });
});
