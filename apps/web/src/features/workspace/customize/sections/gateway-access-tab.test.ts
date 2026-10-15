import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { readFileSync } from '@/i18n/test-source';

const here = import.meta.dir;
const tab = readFileSync(join(here, 'gateway-access-tab.tsx'), 'utf8');
const reference = readFileSync(join(here, 'view/gateway/gateway-api-reference.tsx'), 'utf8');
const keys = readFileSync(join(here, 'view/gateway/gateway-keys.tsx'), 'utf8');

/** Paper GW09: hero card, endpoint tiles, keys, then the full reference. */
describe('Gateway tab — GW09 layout', () => {
  test('hero first, then tiles, then keys — no full-reference block', () => {
    expect(tab).not.toContain('<GatewayApiReference');
    const order = ['data-gateway-hero', 'data-gateway-endpoints', '<GatewayKeys'].map(
      (marker) => tab.indexOf(marker),
    );
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('the hero owns Create: the key list renders rows only, its dialog controlled', () => {
    expect(tab).toContain('createOpen={creating}');
    expect(tab).toContain('onCreateOpenChange={setCreating}');
    expect(tab).toContain('listOnly');
    expect(keys).toContain('listOnly ? null');
  });

  test('the hero code panel: curl / Python / Anthropic SDK, highlighted, labelled Copy', () => {
    expect(tab).toContain('<GatewayQuickstartCode');
    expect(reference).toContain('export function GatewayQuickstartCode');
    expect(reference).toContain('<HighlightedCode');
    expect(reference).toContain("value=\"anthropic\"");
  });

  test('copy icons come only from copy.tsx', () => {
    for (const source of [tab, reference, keys]) expect(source).not.toContain('CopyIcon');
    expect(reference).toContain("from '@/features/icon/icons/copy'");
    expect(keys).toContain("from '@/features/icon/icons/copy'");
  });

  test('every endpoint tile is a button that copies its FULL URL', () => {
    expect(tab).toContain('data-copy-value={url}');
    expect(tab).toContain('url={gatewayBase(gatewayUrl)}');
    expect(tab).toContain('url={`${gatewayBase(gatewayUrl)}${tile.path}`}');
    for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/models']) {
      expect(tab).toContain(`path: '${path}'`);
    }
    expect(tab).toContain('<button');
    expect(tab).toContain('aria-live="polite"');
  });
});
