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
