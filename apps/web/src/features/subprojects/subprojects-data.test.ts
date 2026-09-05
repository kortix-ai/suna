import { describe, expect, test } from 'bun:test';
import type { ProjectTrigger } from '@kortix/sdk';

import {
  triggerSubproject,
  triggersForSubproject,
  withTriggerSubproject,
} from './subprojects-data';

/** Only the fields these helpers read — the rest of ProjectTrigger is noise. */
function trigger(slug: string, subproject?: string | null): ProjectTrigger {
  return { slug, subproject } as unknown as ProjectTrigger;
}

describe('triggerSubproject', () => {
  test('reads the field the SDK type does not declare yet', () => {
    expect(triggerSubproject(trigger('weekly', 'marketing'))).toBe('marketing');
  });

  test('an absent or null field is "no subproject", never undefined', () => {
    expect(triggerSubproject(trigger('weekly'))).toBeNull();
    expect(triggerSubproject(trigger('weekly', null))).toBeNull();
  });
});

describe('triggersForSubproject', () => {
  test('keeps only the triggers filed under the slug, in list order', () => {
    const all = [
      trigger('a', 'marketing'),
      trigger('b'),
      trigger('c', 'research'),
      trigger('d', 'marketing'),
    ];
    expect(triggersForSubproject(all, 'marketing').map((t) => t.slug)).toEqual(['a', 'd']);
  });

  test('a slug nothing names yields nothing', () => {
    expect(triggersForSubproject([trigger('a', 'marketing')], 'research')).toEqual([]);
  });
});

describe('withTriggerSubproject', () => {
  test('undefined leaves the body byte-identical — the field is not being edited', () => {
    const body = { name: 'Weekly' };
    expect(withTriggerSubproject(body, undefined)).toEqual({ name: 'Weekly' });
  });

  test('a slug is added, and null is sent through to CLEAR the back-reference', () => {
    expect(withTriggerSubproject({ name: 'Weekly' }, 'marketing')).toEqual({
      name: 'Weekly',
      subproject: 'marketing',
    });
    expect(withTriggerSubproject({ name: 'Weekly' }, null)).toEqual({
      name: 'Weekly',
      subproject: null,
    });
  });

  test('never mutates the input body', () => {
    const body = { name: 'Weekly' };
    withTriggerSubproject(body, 'marketing');
    expect(body).toEqual({ name: 'Weekly' });
  });
});
