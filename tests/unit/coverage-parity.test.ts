import { describe, expect, it } from 'vitest';
import {
  compareFlowIds,
  parseSpecificationFlowIds,
} from '../src/coverage/spec-parity';

describe('flow specification parity', () => {
  it('reads only standalone product flow contracts', () => {
    const markdown = [
      '`ACC-1` Creates an account.',
      '`GW-2b` Rejects anonymous model reads.',
      '`CLI-PROJ` Runs project commands.',
      '`GOLD-1`',
      'A paragraph mentions `ACC-2` but does not define it.',
      '`/v1/health` is a route, not a flow.',
    ].join('\n');

    expect(parseSpecificationFlowIds(markdown)).toEqual([
      'ACC-1',
      'GW-2b',
      'CLI-PROJ',
      'GOLD-1',
    ]);
  });

  it('reports missing and duplicate contracts in both directions', () => {
    expect(compareFlowIds(['ACC-1', 'ACC-1', 'ACC-2'], ['ACC-1', 'ACC-3'])).toEqual({
      specificationIds: ['ACC-1', 'ACC-2'],
      registeredIds: ['ACC-1', 'ACC-3'],
      missingSpecifications: ['ACC-3'],
      missingFlows: ['ACC-2'],
      duplicateSpecifications: ['ACC-1'],
    });
  });
});
