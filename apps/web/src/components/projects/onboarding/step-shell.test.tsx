import { expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { StepShell } from './step-shell';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test('survey navigation retains independent Skip and Continue actions', async () => {
  const actions: string[] = [];
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(<StepShell title="Survey" primaryLabel="Continue" onPrimary={() => actions.push('continue')} skipLabel="Skip" onSkip={() => actions.push('skip')} />);
    });
    const buttons = renderer?.root.findAllByType('button');
    expect(buttons?.map((button) => button.children.join(''))).toEqual(['Skip', 'Continue']);
    await act(async () => { buttons?.[0].props.onClick(); buttons?.[1].props.onClick(); });
    expect(actions).toEqual(['skip', 'continue']);
    await act(async () => {
      renderer?.update(<StepShell title="Survey" primaryLabel="Continue" primaryDisabled onPrimary={() => actions.push('continue')} />);
    });
    expect(renderer?.root.findAllByType('button')).toHaveLength(1);
    expect(renderer?.root.findByType('button').props.disabled).toBe(true);
  } finally {
    await act(async () => renderer?.unmount());
  }
});
