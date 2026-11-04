import { describe, expect, test } from 'bun:test';

import { chatInputAgents, chatInputTriggerParts, inheritedModelFor, modelIsOverridden } from './chat-input-summary';

const glm = { providerID: 'kortix', modelID: 'glm-5.3-flash' };
const kimi = { providerID: 'kortix', modelID: 'kimi-k3' };

describe('chatInputTriggerParts — what the closed chat-input control says after the agent', () => {
  test('nothing overridden → the model alone', () => {
    expect(chatInputTriggerParts({ model: 'GLM 5.3 Flash', effort: null, extras: 0 })).toEqual(['GLM 5.3 Flash']);
  });

  test('effort is named only when overridden', () => {
    expect(chatInputTriggerParts({ model: 'GLM 5.3 Flash', effort: 'High', extras: 0 })).toEqual(['GLM 5.3 Flash', 'High']);
  });

  test('overridden "More settings" rows are counted, never named', () => {
    expect(chatInputTriggerParts({ model: 'GLM 5.3 Flash', effort: null, extras: 2 })).toEqual(['GLM 5.3 Flash', '2']);
    expect(chatInputTriggerParts({ model: 'GLM 5.3 Flash', effort: 'Low', extras: 1 })).toEqual(['GLM 5.3 Flash', 'Low', '1']);
  });

  test('no model shown (a host without models) → only what is overridden', () => {
    expect(chatInputTriggerParts({ model: null, effort: null, extras: 0 })).toEqual([]);
    expect(chatInputTriggerParts({ model: null, effort: null, extras: 3 })).toEqual(['3']);
  });
});

describe('modelIsOverridden — the model row is Auto while the agent would pick the same model', () => {
  test('same model as the agent default → not overridden, even when picked explicitly', () => {
    expect(modelIsOverridden(glm, { ...glm })).toBe(false);
  });

  test('another model → overridden', () => {
    expect(modelIsOverridden(kimi, glm)).toBe(true);
  });

  test('inherited model unknown (defaults loading) or no model yet → never overridden', () => {
    expect(modelIsOverridden(kimi, null)).toBe(false);
    expect(modelIsOverridden(null, glm)).toBe(false);
  });
});

describe('inheritedModelFor — the model "Reset to auto" goes back to', () => {
  const resolveDefaultFor = (agent: string | undefined) => (agent === 'coder' ? kimi : glm);

  test('no explicit pick → the composer already shows the inherited model', () => {
    expect(
      inheritedModelFor({ onDefault: true, currentKey: glm, defaults: { resolveDefaultFor } }, 'coder'),
    ).toEqual(glm);
  });

  test('an explicit pick → the server default chain for the selected agent', () => {
    expect(
      inheritedModelFor({ onDefault: false, currentKey: glm, defaults: { resolveDefaultFor } }, 'coder'),
    ).toEqual(kimi);
  });

  test('no default known → null, so no reset is offered', () => {
    expect(
      inheritedModelFor(
        { onDefault: false, currentKey: glm, defaults: { resolveDefaultFor: () => undefined } },
        'coder',
      ),
    ).toBeNull();
  });
});

describe('chatInputAgents — the agent the control names, and the agents it offers', () => {
  const isMyKortix = (name: string) => name === 'mykortix';
  const roster = ['worker', 'mykortix', 'coder'];

  test('a bound agent (a DM) is named whatever was picked before, and no agent is offered', () => {
    expect(chatInputAgents(roster, 'worker', true, isMyKortix)).toEqual({ name: 'worker', offered: [] });
    // Bound to an agent the roster does not list (no grant): still that agent.
    expect(chatInputAgents([], 'worker', true, isMyKortix)).toEqual({ name: 'worker', offered: [] });
  });

  test('a free composer names the selection and offers every agent, My Kortix first', () => {
    expect(chatInputAgents(roster, 'coder', false, isMyKortix)).toEqual({ name: 'coder', offered: ['mykortix', 'worker', 'coder'] });
    expect(chatInputAgents(roster, null, false, isMyKortix).name).toBe('worker');
  });
});
