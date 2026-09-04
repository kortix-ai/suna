import { expect, test } from 'bun:test';
import { withStageInstructions } from './stage-instructions';

test('appends the stage protocol only when the env carries one', () => {
  expect(withStageInstructions('base', {})).toBe('base');
  expect(withStageInstructions('base', { KORTIX_STAGE_INSTRUCTIONS: '  ' })).toBe('base');
  expect(
    withStageInstructions('base', { KORTIX_STAGE_INSTRUCTIONS: '# Monitoring board\n- stage planning\n' }),
  ).toBe('base\n\n# Monitoring board\n- stage planning');
});
