import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const challengeSource = readFileSync(join(import.meta.dir, 'chatgpt-device-challenge.tsx'), 'utf8');
const sidebarConnectSource = readFileSync(
  join(import.meta.dir, 'chatgpt-subscription-connect.tsx'),
  'utf8',
);
const providerConnectSource = readFileSync(
  join(
    import.meta.dir,
    '../../features/workspace/customize/sections/llm-provider/chatgpt-subscription-connect.tsx',
  ),
  'utf8',
);

describe('ChatGPT device authorization', () => {
  test('shows the device code before the explicit auth-page action', () => {
    const code = challengeSource.indexOf('{code}');
    const authPage = challengeSource.indexOf('Open auth page');

    expect(code).toBeGreaterThan(-1);
    expect(authPage).toBeGreaterThan(code);
  });

  test('provides a device-code copy action', () => {
    expect(challengeSource).toContain('<CopyButton code={code}');
    expect(challengeSource).toContain('label="Copy code"');
  });

  test('does not open the auth page from either connection request', () => {
    expect(sidebarConnectSource).not.toContain('window.open');
    expect(providerConnectSource).not.toContain('window.open');
    expect(sidebarConnectSource).toContain('<ChatGptDeviceChallenge');
    expect(providerConnectSource).toContain('<ChatGptDeviceChallenge');
  });
});
