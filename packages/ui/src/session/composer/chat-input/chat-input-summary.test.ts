import { describe, expect, test } from 'bun:test';

import { chatInputSummary, inheritedModelFor, modelIsOverridden } from './chat-input-summary';

const glm = { providerID: 'kortix', modelID: 'glm-5.3-flash' };
const kimi = { providerID: 'kortix', modelID: 'kimi-k3' };

describe('chatInputSummary — what the closed chat-input control says after the agent', () => {
  test('nothing overridden → Auto', () => {
    expect(chatInputSummary([])).toEqual({ kind: 'auto' });
  });

  test('only model and effort → their values, in row order', () => {
    expect(
      chatInputSummary([
        { id: 'model', value: 'GLM 5.3 Flash', glanceable: true },
        { id: 'effort', value: 'High', glanceable: true },
      ]),
    ).toEqual({ kind: 'values', values: ['GLM 5.3 Flash', 'High'] });
  });

  test('a setting with no one-word value (secrets) → a count of every override', () => {
    expect(
      chatInputSummary([
        { id: 'model', value: 'GLM 5.3 Flash', glanceable: true },
        { id: 'secrets', value: '2 selected', glanceable: false },
      ]),
    ).toEqual({ kind: 'count', count: 2 });
    expect(chatInputSummary([{ id: 'sandbox', value: 'gpu', glanceable: false }])).toEqual({
      kind: 'count',
      count: 1,
    });
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
