import { describe, expect, test } from 'bun:test';
import { classifyProgressChannel } from './progress-channel';

/**
 * The bucket a box lands in decides which progress signal shadow mode may
 * expect from it — and therefore whether "no usage events" means "wedged" or
 * "BYOK, by construction". Guessing UPWARD here would license a longer life on
 * no evidence, so every ambiguous case must fall to 'none'.
 */
describe('classifyProgressChannel', () => {
  test('opencode is gateway-locked, so it always produces usage_events', () => {
    expect(classifyProgressChannel({ runtime_harness: 'opencode' })).toBe('gateway');
  });

  test.each(['claude', 'codex', 'pi'])('%s is ACP — it may produce NO usage events at all', (h) => {
    // The harness registry launches Claude Code with no ANTHROPIC_BASE_URL when
    // a direct key is present, and points pi at api.openai.com. Treating these
    // as 'gateway' would make the shadow gate pass vacuously and then kill
    // every BYOK turn at the ceiling.
    expect(classifyProgressChannel({ runtime_harness: h })).toBe('acp');
  });

  test('an ACP transport with no harness recorded is still ACP', () => {
    expect(classifyProgressChannel({ runtime_transport: 'acp' })).toBe('acp');
  });

  test('a pre-harness opencode session is recognised by its REST transport', () => {
    expect(classifyProgressChannel({ runtime_transport: 'rest' })).toBe('gateway');
  });

  test.each([
    ['no metadata at all', null],
    ['empty metadata', {}],
    ['a harness we have never heard of', { runtime_harness: 'future-harness' }],
    ['a transport we have never heard of', { runtime_transport: 'grpc' }],
  ])('%s falls to none, the conservative direction', (_label, metadata) => {
    expect(classifyProgressChannel(metadata as Record<string, unknown> | null)).toBe('none');
  });
});
