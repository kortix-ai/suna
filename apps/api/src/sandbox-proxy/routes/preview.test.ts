import { describe, expect, test } from 'bun:test';

import { shouldAutoResumeStoppedSandbox } from './preview';

// The data-path proxy may only wake a stopped box on ACTIVE user traffic to the
// OpenCode daemon (port 8000, principal). Everything else must still 503 so we
// never resurrect an idle-quiesced box on passive asset/preview traffic.
describe('shouldAutoResumeStoppedSandbox', () => {
  test('stopped + daemon port 8000 + principal → resume', () => {
    expect(shouldAutoResumeStoppedSandbox('stopped', 8000, 'principal')).toBe(true);
  });

  test('a non-daemon (passive/asset/preview) port never resumes', () => {
    expect(shouldAutoResumeStoppedSandbox('stopped', 4096, 'principal')).toBe(false);
    expect(shouldAutoResumeStoppedSandbox('stopped', 3000, 'principal')).toBe(false);
    expect(shouldAutoResumeStoppedSandbox('stopped', 443, 'principal')).toBe(false);
  });

  test('non-user (service / share) access never resumes', () => {
    expect(shouldAutoResumeStoppedSandbox('stopped', 8000, 'service')).toBe(false);
    expect(shouldAutoResumeStoppedSandbox('stopped', 8000, 'share')).toBe(false);
    expect(shouldAutoResumeStoppedSandbox('stopped', 8000, '')).toBe(false);
  });

  test('only a STOPPED record is a resume candidate (error/archived/active are not)', () => {
    expect(shouldAutoResumeStoppedSandbox('error', 8000, 'principal')).toBe(false);
    expect(shouldAutoResumeStoppedSandbox('archived', 8000, 'principal')).toBe(false);
    expect(shouldAutoResumeStoppedSandbox('active', 8000, 'principal')).toBe(false);
    expect(shouldAutoResumeStoppedSandbox('provisioning', 8000, 'principal')).toBe(false);
  });
});
