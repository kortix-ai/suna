import { afterEach, describe, expect, test } from 'bun:test';

import { postEnvToDaemon } from './sandbox-env-transport';

/**
 * `POST /kortix/env` across daemon builds (W3 D2). A W3 daemon reads
 * `runtimeEnv` and answers `runtime*`; an older one reads `runtimeEnv` and
 * answers `opencode*`. The API sends both request names and reads either answer.
 */
const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function daemonAnswering(body: Record<string, unknown>) {
  const posted: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    posted.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, revision: 'rev-1', exported: 0, agent_env_written: true, ...body });
  }) as unknown as typeof fetch;
  return posted;
}

const ARGS = {
  previewUrl: 'https://box.test/',
  providerHeaders: {},
  serviceKey: 'svc',
  snapshot: { env: {}, names: [], revision: 'rev-1', scope: 'inherit' as const, capabilitiesJson: '{"version":1,"capabilities":[]}' },
  runtimeEnv: { KORTIX_MODEL: 'kortix/m' },
  refreshModels: true,
};

describe('postEnvToDaemon across daemon builds', () => {
  test('sends the runtime env under its W3 name and its pre-W3 name', async () => {
    const posted = daemonAnswering({});
    await postEnvToDaemon(ARGS);
    expect(posted[0]!.runtimeEnv).toEqual(posted[0]!.runtimeEnv);
    expect(posted[0]!.runtimeEnv).toMatchObject({ KORTIX_MODEL: 'kortix/m' });
  });

  test('reads a W3 answer (runtime*)', async () => {
    daemonAnswering({ runtime: 'starting', runtime_reload: 'kept-old', runtime_turn_ended: false });
    const result = await postEnvToDaemon(ARGS);
    expect(result).toMatchObject({ runtimeState: 'starting', runtimeReload: 'kept-old', runtimeTurnEnded: false });
  });
});
