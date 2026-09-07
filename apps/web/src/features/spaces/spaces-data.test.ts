import { describe, expect, test } from 'bun:test';
import type { ProjectTrigger } from '@kortix/sdk';

import {
  triggerSpace,
  triggersForSpace,
  withTriggerSpace,
} from './spaces-data';

/** Only the fields these helpers read — the rest of ProjectTrigger is noise. */
function trigger(slug: string, space?: string | null): ProjectTrigger {
  return { slug, space } as unknown as ProjectTrigger;
}

describe('triggerSpace', () => {
  test('reads the field the SDK type does not declare yet', () => {
    expect(triggerSpace(trigger('weekly', 'marketing'))).toBe('marketing');
  });

  test('an absent or null field is "no space", never undefined', () => {
    expect(triggerSpace(trigger('weekly'))).toBeNull();
    expect(triggerSpace(trigger('weekly', null))).toBeNull();
  });
});

describe('triggersForSpace', () => {
  test('keeps only the triggers filed under the slug, in list order', () => {
    const all = [
      trigger('a', 'marketing'),
      trigger('b'),
      trigger('c', 'research'),
      trigger('d', 'marketing'),
    ];
    expect(triggersForSpace(all, 'marketing').map((t) => t.slug)).toEqual(['a', 'd']);
  });

  test('a slug nothing names yields nothing', () => {
    expect(triggersForSpace([trigger('a', 'marketing')], 'research')).toEqual([]);
  });
});

describe('withTriggerSpace', () => {
  test('undefined leaves the body byte-identical — the field is not being edited', () => {
    const body = { name: 'Weekly' };
    expect(withTriggerSpace(body, undefined)).toEqual({ name: 'Weekly' });
  });

  test('a slug is added, and null is sent through to CLEAR the back-reference', () => {
    expect(withTriggerSpace({ name: 'Weekly' }, 'marketing')).toEqual({
      name: 'Weekly',
      space: 'marketing',
    });
    expect(withTriggerSpace({ name: 'Weekly' }, null)).toEqual({
      name: 'Weekly',
      space: null,
    });
  });

  test('never mutates the input body', () => {
    const body = { name: 'Weekly' };
    withTriggerSpace(body, 'marketing');
    expect(body).toEqual({ name: 'Weekly' });
  });
});
