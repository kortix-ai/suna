import { describe, expect, test } from 'bun:test';
import { type ParsedManifest, extractTriggers } from '../triggers';
import { draftToSpec, parseTriggerDraft, specToBody } from './trigger-draft';
import { upsertTriggerInManifest } from './trigger-manifest';

const blank = (): ParsedManifest => ({ raw: {}, path: 'kortix.yaml' });

describe('a change_request trigger from POST /triggers', () => {
  test('filter.base becomes the branch; kortix.yaml gets the flat entry; it reads back the same', () => {
    const draft = parseTriggerDraft(
      { name: 'Verify prod', type: 'change_request', prompt_template: 'Verify {{ change_request.number }}', filter: { base: 'main' } },
      { existingSlug: null },
    );
    if ('error' in draft) throw new Error(draft.error);
    const spec = draftToSpec(draft);
    expect(spec).toMatchObject({ type: 'change_request', changeRequest: { crId: null, base: 'main' }, filter: null });

    const written = upsertTriggerInManifest(blank(), spec);
    const entry = (written.raw.triggers as Record<string, unknown>[])[0]!;
    expect(entry).toMatchObject({ slug: 'verify-prod', type: 'change_request', filter: { base: 'main' } });
    expect(entry).not.toHaveProperty('on');

    const { specs, errors } = extractTriggers(written);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({ type: 'change_request', changeRequest: { crId: null, base: 'main' } });
    // A PATCH merges over specToBody: the branch survives an edit of any other field.
    expect(specToBody(specs[0]!).filter).toEqual({ base: 'main' });
  });

  test('no filter fires on any merge; a blank base is refused', () => {
    const any = parseTriggerDraft({ name: 'Any', type: 'change_request', prompt_template: 'x' }, { existingSlug: null });
    expect('error' in any ? any.error : any.changeRequest).toEqual({ crId: null, base: null });
    const blankBase = parseTriggerDraft({ name: 'B', type: 'change_request', prompt_template: 'x', filter: { base: ' ' } }, { existingSlug: null });
    expect(blankBase).toEqual({ error: 'filter.base must be a branch name' });
  });
});

describe('a trigger edited through the manifest keeps its own fields', () => {
  // KRTX-4340: the silence alert is written back for every type, not only cron.
  // An app trigger that lost `expect_event_within` stops alerting, and the user
  // who renamed their watcher silently turned the alert off.
  test('an app trigger keeps expect_event_within: a rename and a prompt edit read back the window', () => {
    // A trigger saved flat (the shape an edited entry keeps) with its silence alert set.
    const seeded: ParsedManifest = {
      ...blank(),
      raw: {
        triggers: [{
          slug: 'status-watch', name: 'Status watch', type: 'app', agent: 'default', enabled: true,
          app: 'status-watch', prompt: 'Status: {{ event.data.status }}', expect_event_within: '30m',
        }],
      },
    };
    const before = extractTriggers(seeded);
    expect(before.errors).toEqual([]);
    expect(before.specs[0]!.expectEventWithinSeconds).toBe(1800);

    // Any edit goes through specToBody → parseTriggerDraft → upsertTriggerInManifest.
    const draft = parseTriggerDraft({ ...specToBody(before.specs[0]!), name: 'Status watcher' }, { existingSlug: 'status-watch' });
    if ('error' in draft) throw new Error(draft.error);
    expect(draft.expectEventWithinSeconds).toBe(1800);

    const written = upsertTriggerInManifest(seeded, draftToSpec(draft));
    const entry = (written.raw.triggers as Record<string, unknown>[])[0]!;
    expect(entry).toMatchObject({ slug: 'status-watch', type: 'app', app: 'status-watch', expect_event_within: '30m' });

    const after = extractTriggers(written);
    expect(after.errors).toEqual([]);
    expect(after.specs[0]).toMatchObject({ name: 'Status watcher', type: 'app', app: 'status-watch', expectEventWithinSeconds: 1800 });
  });

  test('a cron trigger keeps its max_lateness and carries no silence window', () => {
    const cron = parseTriggerDraft(
      { name: 'Hourly', type: 'cron', cron: '0 * * * *', prompt_template: 'x', max_lateness: '5m' },
      { existingSlug: null },
    );
    if ('error' in cron) throw new Error(cron.error);
    const written = upsertTriggerInManifest(blank(), draftToSpec(cron));
    const { specs, errors } = extractTriggers(written);
    expect(errors).toEqual([]);
    expect(specs[0]).toMatchObject({ type: 'cron', maxLatenessSeconds: 300 });
    expect(specs[0]!.expectEventWithinSeconds).toBeUndefined();
  });
});
