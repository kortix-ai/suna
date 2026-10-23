import { describe, expect, test } from 'bun:test';
import type { LayerRef } from './layers';
import { type ThreadRow, threadPlan } from './thread-layers';
import { isMemoryTurnRoute, turnLayersOf, withMemoryLayers } from './turn-context';

const CHANNEL = '11111111-1111-4111-8111-111111111111';
const DM = '22222222-2222-4222-8222-222222222222';

const row = (over: Partial<ThreadRow>): ThreadRow => ({
  project_id: 'p',
  project_metadata: {},
  session_agent: 'writer',
  session_created_by: 'u1',
  root_session_id: 's1',
  root_visibility: 'project',
  space_id: CHANNEL,
  space_kind: 'channel',
  space_slug: 'marketing',
  space_dm_user_id: null,
  space_dm_agent: null,
  space_archived_at: null,
  dm_space_id: null,
  dm_user_id: null,
  dm_agent: null,
  layers: null,
  ...over,
});

/** The plan's read layers as the turn hook sends them, each layer at version 3. */
function turnLayers(thread: ThreadRow) {
  const plan = threadPlan(thread);
  if (!plan) return null;
  return turnLayersOf(
    plan.read.map(
      (layer, i): LayerRef => ({
        layerId: `layer-${i}`,
        projectId: 'p',
        scope: layer.scope,
        spaceId: layer.spaceId,
        version: 3,
        name: '',
        readOnly: false,
        dmUserId: null,
      }),
    ),
  );
}

describe('the memory layers a turn carries', () => {
  test('a channel thread reads company and channel', () => {
    expect(turnLayers(row({}))).toEqual([
      { layer_id: 'layer-0', version: '3', dir: 'company' },
      { layer_id: 'layer-1', version: '3', dir: 'channel' },
    ]);
  });

  test('a DM thread reads company and personal', () => {
    const dm = row({ space_id: DM, space_kind: 'dm', space_slug: null, space_dm_user_id: 'u1', space_dm_agent: 'writer' });
    expect(turnLayers(dm)?.map((layer) => layer.dir)).toEqual(['company', 'personal']);
    expect(threadPlan(dm)?.own.scope).toBe('dm');
  });

  test('a private channel thread whose owner has a DM with its agent also reads that DM, but writes the channel', () => {
    const thread = row({ root_visibility: 'private', dm_space_id: DM, dm_user_id: 'u1', dm_agent: 'writer' });
    expect(turnLayers(thread)?.map((layer) => layer.dir)).toEqual(['company', 'channel', 'personal']);
    expect(threadPlan(thread)?.own.spaceId).toBe(CHANNEL);
    // A project-visible thread never reads the DM, even if one were found.
    expect(turnLayers(row({ dm_space_id: DM }))?.map((layer) => layer.dir)).toEqual(['company', 'channel']);
  });

  test('a thread in no space has no memory', () => {
    expect(turnLayers(row({ space_id: null, space_kind: null }))).toBeNull();
  });

  test('only the Kortix prompt route carries memory_layers', () => {
    expect(isMemoryTurnRoute('POST', '/kortix/runtime/sessions/abc/prompt')).toBe(true);
    expect(isMemoryTurnRoute('POST', '/proxy/4096/kortix/runtime/sessions/abc/prompt')).toBe(true);
    expect(isMemoryTurnRoute('POST', '/kortix/runtime/sessions/abc/steer')).toBe(false);
    expect(isMemoryTurnRoute('POST', '/session/abc/prompt_async')).toBe(false);
    expect(isMemoryTurnRoute('GET', '/kortix/runtime/sessions/abc/prompt')).toBe(false);
  });

  test('the body keeps every field and gains memory_layers; a body that is not a JSON object is unchanged', () => {
    const layers = [{ layer_id: 'l', version: '0', dir: 'company' as const }];
    const body = new TextEncoder().encode(JSON.stringify({ text: 'hi', message_id: 'm1' })).buffer as ArrayBuffer;
    const out = withMemoryLayers(body, layers)!;
    expect(JSON.parse(new TextDecoder().decode(out))).toEqual({ text: 'hi', message_id: 'm1', memory_layers: layers });
    const notJson = new TextEncoder().encode('nope').buffer as ArrayBuffer;
    expect(withMemoryLayers(notJson, layers)).toBe(notJson);
    expect(withMemoryLayers(undefined, layers)).toBeUndefined();
  });

  test('a layer list the daemon would refuse is not sent', () => {
    const twice: LayerRef = { layerId: 'a', projectId: 'p', scope: 'channel', spaceId: CHANNEL, version: 1, name: '', readOnly: false, dmUserId: null };
    expect(turnLayersOf([twice, { ...twice, layerId: 'b' }])).toBeNull();
  });
});
