import { describe, expect, test } from 'bun:test';

import {
  enrollmentUrl,
  expiryDate,
  installCommand,
  msiCommand,
  parseDomains,
  parseLimit,
  personLabel,
  windowsCmd,
  windowsInstallerUrl,
} from './rollout-model';

describe('IT rollout model', () => {
  test('domains: any separator, a leading @, any case, no duplicates', () => {
    expect(parseDomains(' @Corp.example, corp.example\nlab.corp.example;  ')).toEqual([
      'corp.example',
      'lab.corp.example',
    ]);
    expect(parseDomains('')).toEqual([]);
  });

  test('the enrollment URL is the API origin without /v1', () => {
    expect(enrollmentUrl('https://api.kortix.com/v1')).toBe('https://api.kortix.com');
    expect(enrollmentUrl('http://localhost:8008/v1/')).toBe('http://localhost:8008');
    expect(enrollmentUrl('https://kortix.example/api')).toBe('https://kortix.example/api');
    expect(enrollmentUrl(undefined)).toBe('https://api.kortix.com');
  });

  test('Windows: one Command Prompt line downloads, installs, waits and reports', () => {
    const cmd = windowsCmd('https://api.kortix.com', 'kortix_enr_x');
    expect(cmd).toBe(
      'curl.exe -fsSL -o "%TEMP%\\KortixCapture-x64.msi" https://github.com/kortix-ai/suna/releases/latest/download/KortixCapture-x64.msi' +
        ' && start /wait msiexec /i "%TEMP%\\KortixCapture-x64.msi" /qn /l*v "%TEMP%\\KortixCapture-install.log" KORTIX_URL=https://api.kortix.com ENROLLMENT_TOKEN=kortix_enr_x' +
        ' && echo Kortix Capture installed. It records from the next Windows sign-in.' +
        ' || echo Install failed. Log: "%TEMP%\\KortixCapture-install.log"',
    );
    expect(windowsInstallerUrl('https://dev-api.kortix.com')).toBe(
      'https://github.com/kortix-ai/suna/releases/download/capture-dev-latest/KortixCapture-x64.msi',
    );
    expect(installCommand('windows', 'https://api.kortix.com', 'kortix_enr_x')).toBe(cmd);
  });

  test('the silent install names the URL and the token', () => {
    expect(msiCommand('https://api.kortix.com', 'kortix_enr_x')).toBe(
      'msiexec /i KortixCapture-x64.msi /qn KORTIX_URL=https://api.kortix.com ENROLLMENT_TOKEN=kortix_enr_x',
    );
  });

  test('a computer limit is a whole number from 1, else no limit', () => {
    expect(parseLimit('20')).toBe(20);
    expect(parseLimit(' ')).toBeNull();
    expect(parseLimit('0')).toBeNull();
    expect(parseLimit('2.5')).toBeNull();
  });

  test('a waiting computer names its UPN, else its login name', () => {
    expect(personLabel({ principal_name: 'a@corp.example', account_name: 'CORP\\a' })).toBe(
      'a@corp.example',
    );
    expect(personLabel({ principal_name: null, account_name: 'CORP\\a' })).toBe('CORP\\a');
  });

  test('an expiry is a calendar date, never "just now"', () => {
    expect(expiryDate('2026-11-12T13:28:02.000Z', 'en-GB')).toBe('12 Nov 2026');
    expect(expiryDate('2026-11-12T13:28:02.000Z', 'de')).toBe('12. Nov. 2026');
  });

  test('macOS and Linux write a root-only config.json with the URL and the token, then install the package', () => {
    const mac = installCommand('macos', 'https://api.kortix.com', 'kortix_enr_x');
    expect(mac).toContain('{"url":"https://api.kortix.com","enrollment_token":"kortix_enr_x"}');
    expect(mac).toContain(
      'sudo chmod 600 "/Library/Application Support/Kortix/Capture/config.json"',
    );
    expect(mac.split('\n').at(-1)).toBe(
      'sudo installer -pkg KortixCapture-universal.pkg -target /',
    );
    const linux = installCommand('linux', 'https://api.kortix.com', 'kortix_enr_x');
    expect(linux).toContain('sudo tee /etc/kortix/capture.json');
    expect(linux).toContain('sudo chmod 600 /etc/kortix/capture.json');
    expect(linux.split('\n').at(-1)).toBe('sudo apt install ./kortix-capture_amd64.deb');
    expect(installCommand('windows', 'https://api.kortix.com', 'kortix_enr_x')).toBe(
      windowsCmd('https://api.kortix.com', 'kortix_enr_x'),
    );
  });
});
