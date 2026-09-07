import { afterEach, describe, expect, test } from 'bun:test';

import type { PiSkill } from './skill-runtime.ts';
import { startWorker } from './worker.ts';

const workers: Array<Awaited<ReturnType<typeof startWorker>>> = [];
const globals = globalThis as Record<string, unknown>;
const originalCompiled = globals.__KORTIX_COMPILED__;

afterEach(async () => {
  globals.__KORTIX_COMPILED__ = originalCompiled;
  await Promise.all(
    workers.splice(0).map((worker) => {
      worker.server.closeAllConnections();
      return worker.close();
    }),
  );
});

async function start(skills: PiSkill[]) {
  globals.__KORTIX_COMPILED__ = {
    manifest: { default_agent: 'build', skill_config_etag: 'skill-etag' },
    agentConfig: { agent: { build: {} } },
    skills,
  };
  const worker = await startWorker({
    port: 0,
    envUrl: 'http://127.0.0.1:1',
    envUrlExplicit: true,
    envCwd: '/workspace',
    envTransport: 'fetch',
    systemPrompt: 'Answer exactly.',
    modelMode: 'faux',
    sessionId: `skill-routes-${workers.length}`,
    kortixToken: 'runtime-token',
  });
  workers.push(worker);
  return worker;
}

function request(worker: Awaited<ReturnType<typeof startWorker>>, path: string) {
  return fetch(`http://127.0.0.1:${worker.port}${path}`, {
    headers: { authorization: 'Bearer runtime-token' },
  });
}

describe('Pi OpenCode skill route', () => {
  test('lists compiled skill metadata and exposes its config etag in runtime state', async () => {
    const skills: PiSkill[] = [
      {
        name: 'release',
        description: 'Prepare a release',
        location: '.kortix/pi/skills/release/SKILL.md',
        content: 'Release instructions.',
        files: [],
      },
    ];
    const worker = await start(skills);

    expect(await (await request(worker, '/skill?directory=/workspace')).json()).toEqual([
      {
        name: 'release',
        description: 'Prepare a release',
        location: '/workspace/.kortix/pi/skills/release/SKILL.md',
        content: 'Release instructions.',
      },
    ]);
    const state = (await (await request(worker, '/kortix/opencode/state')).json()) as {
      identity: { skill_config_etag?: string };
      skills: { known: boolean; value: unknown[] };
    };
    expect(state.identity.skill_config_etag).toBe('skill-etag');
    expect(state.skills.known).toBe(true);
    expect(state.skills.value).toHaveLength(1);
  });
});
