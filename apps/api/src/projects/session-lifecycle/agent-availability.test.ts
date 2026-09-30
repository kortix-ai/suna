import { describe, expect, test } from 'bun:test';
import {
  RUNTIME_AGENT_ROSTER_TTL_MS,
  parseRuntimeAgentNames,
  resolveDeliverableAgent,
  runtimeAgentRoster,
} from './agent-availability';

const ROSTER = { names: ['build', 'plan', 'general'] };

describe('resolveDeliverableAgent', () => {
  test('keeps an agent the runtime has', () => {
    expect(resolveDeliverableAgent('build', ROSTER)).toEqual({ agent: 'build' });
  });

  test('refuses an agent the runtime does not have', () => {
    // The measured defect: `agent:"kortix"` on a runtime without it was
    // acknowledged 204 and the message was destroyed.
    expect(() => resolveDeliverableAgent('kortix', ROSTER)).toThrow('Runtime agent "kortix" is not registered');
  });

  test('refuses an unreadable roster rather than forwarding an unchecked name', () => {
    expect(() => resolveDeliverableAgent('kortix', { names: null })).toThrow('agent roster unavailable');
  });

  test('no request means no agent field', () => {
    for (const requested of [null, undefined, '', '   ']) {
      expect(resolveDeliverableAgent(requested, ROSTER)).toEqual({ agent: null });
    }
  });

  test('the requested name is trimmed before it is matched', () => {
    expect(resolveDeliverableAgent('  build  ', ROSTER)).toEqual({ agent: 'build' });
  });

  test('an empty roster refuses every pick', () => {
    expect(() => resolveDeliverableAgent('build', { names: [] })).toThrow('not registered');
  });
});

describe('parseRuntimeAgentNames', () => {
  test('reads the daemon list shape', () => {
    expect(
      parseRuntimeAgentNames([
        { name: 'build', mode: 'primary' },
        { name: 'general', mode: 'subagent' },
      ]),
    ).toEqual(['build', 'general']);
  });

  test('reads an { agents: [...] } envelope', () => {
    expect(parseRuntimeAgentNames({ agents: [{ name: 'plan' }] })).toEqual(['plan']);
  });

  test('a non-list body is unreadable, not empty', () => {
    expect(parseRuntimeAgentNames(null)).toBeNull();
    expect(parseRuntimeAgentNames({ error: 'nope' })).toBeNull();
  });

  test('entries with no usable name are skipped, the rest still count', () => {
    expect(parseRuntimeAgentNames([{ name: '' }, { mode: 'primary' }, { name: 'build' }])).toEqual([
      'build',
    ]);
  });
});

// Every case reads its own sandbox id, so the process-wide cache never
// carries a roster from one case into another.
describe('runtimeAgentRoster', () => {

  test('reads once and serves the cache inside the TTL', async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return ['build'];
    };
    expect(await runtimeAgentRoster('sbx_1', read, 1_000)).toEqual({ names: ['build'] });
    expect(await runtimeAgentRoster('sbx_1', read, 1_000 + RUNTIME_AGENT_ROSTER_TTL_MS - 1)).toEqual(
      { names: ['build'] },
    );
    expect(reads).toBe(1);
  });

  test('re-reads once the TTL is past', async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return [`agent-${reads}`];
    };
    await runtimeAgentRoster('sbx_2', read, 1_000);
    expect(await runtimeAgentRoster('sbx_2', read, 1_000 + RUNTIME_AGENT_ROSTER_TTL_MS)).toEqual({
      names: ['agent-2'],
    });
    expect(reads).toBe(2);
  });

  test('a THROWN read is an unreadable roster, cached so a burst cannot re-probe per prompt', async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      throw new Error('sandbox unreachable');
    };
    expect(await runtimeAgentRoster('sbx_3', read, 1_000)).toEqual({ names: null });
    expect(await runtimeAgentRoster('sbx_3', read, 1_500)).toEqual({ names: null });
    expect(reads).toBe(1);
  });

  test('rosters are per sandbox', async () => {
    await runtimeAgentRoster('sbx_a', async () => ['build'], 1_000);
    expect(await runtimeAgentRoster('sbx_b', async () => ['plan'], 1_000)).toEqual({
      names: ['plan'],
    });
  });
});
