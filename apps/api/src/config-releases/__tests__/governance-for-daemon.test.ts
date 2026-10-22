import { describe, expect, test } from 'bun:test';
import { COMPILED_AGENT_CONFIG_GZ_CAPABILITY } from '@kortix/api-contract/compiled-agent-config-env';
import { governanceForDaemon } from '../desired';

// A kortixd built before the gzip form stores a release's governance raw in its
// env, and every exec after that fails with E2BIG once it passes 128 KiB.
describe('governanceForDaemon', () => {
  type Descriptor = { compiled_governance: string | null; compiled_governance_etag: string | null; release_id: string };
  const small: Descriptor = { compiled_governance: '{"agent":{}}', compiled_governance_etag: 'e1', release_id: 'r' };
  const big: Descriptor = { compiled_governance: JSON.stringify({ agent: { a: { prompt: 'x'.repeat(140_000) } } }), compiled_governance_etag: 'e2', release_id: 'r' };

  test('a governance that fits in one env string reaches every daemon', () => {
    expect(governanceForDaemon(small, [])).toBe(small);
  });

  test('an oversized governance reaches only a daemon that declares the gzip form', () => {
    expect(governanceForDaemon(big, [COMPILED_AGENT_CONFIG_GZ_CAPABILITY])).toBe(big);
    const withheld = governanceForDaemon(big, []);
    // kortixd's descriptor schema rejects a governance without its etag (and the
    // reverse), so both go: an invalid descriptor boots the image default config.
    expect(withheld).toEqual({ ...big, compiled_governance: null, compiled_governance_etag: null });
    // The cached descriptor is not changed.
    expect(big.compiled_governance).not.toBeNull();
  });
});
